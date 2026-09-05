import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import {
  DisabledOutboundAdapter,
  DryRunOutboundAdapter,
  type OutboundAdapter,
} from "../lib/outbound/adapters";
import { dispatchOutboxMessage, type DispatchableOutboxMessage } from "../lib/outbound/dispatcher";
import { parseClaimedOutboxRows } from "../lib/outbound/claim";
import { DEFAULT_SENDING_TIME_ZONE, type SendingWindow } from "../lib/outbound/policy";
import { classifyOutboundError, retryDelayMs, scheduleRetry } from "../lib/outbound/retry";
import { assertOutboxTransition, canTransitionOutbox, isTerminalOutboxState } from "../lib/outbound/state";

const openWindow: SendingWindow = {
  timeZone: DEFAULT_SENDING_TIME_ZONE,
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  allowedWeekdays: [1, 2, 3, 4, 5],
};

const message: DispatchableOutboxMessage = {
  id: "message-1",
  idempotencyKey: "campaign:person:contact",
  state: "claimed",
  channel: "email",
  expectedChannel: "email",
  destination: "person@example.com",
  subject: "Subject",
  body: "Body",
  suppressionStatus: "active",
  identityStatus: "resolved",
  consentStatus: "opted_in",
  contactabilityStatus: "reachable",
  destinationCurrent: true,
  destinationUniqueOwner: true,
};

test("outbox transition graph accepts legal moves and rejects terminal or illegal moves", () => {
  assert.equal(canTransitionOutbox("pending", "claimed"), true);
  assert.equal(canTransitionOutbox("claimed", "retry_scheduled"), true);
  assert.equal(isTerminalOutboxState("dry_run_completed"), true);
  assert.doesNotThrow(() => assertOutboxTransition("claimed", "dry_run_completed"));
  assert.throws(() => assertOutboxTransition("pending", "delivered"), /Illegal outbox transition/);
  assert.throws(() => assertOutboxTransition("delivered", "pending"), /Illegal outbox transition/);
});

test("retry classification and scheduling are deterministic and capped", () => {
  assert.equal(classifyOutboundError("timeout"), "retryable");
  assert.equal(classifyOutboundError("invalid_destination"), "permanent");
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(20), 6 * 60 * 60 * 1_000);
  assert.equal(scheduleRetry(2, new Date("2026-08-17T14:00:00.000Z")), "2026-08-17T14:02:00.000Z");
});

test("dry-run and disabled adapters produce terminal states without a provider call", async () => {
  const now = new Date("2026-08-17T14:00:00.000Z");
  assert.deepEqual(await dispatchOutboxMessage(message, new DryRunOutboundAdapter(), now, openWindow), {
    state: "dry_run_completed",
    code: "dry_run_no_provider_call",
    availableAt: null,
    providerCalled: false,
  });
  assert.deepEqual(await dispatchOutboxMessage(message, new DisabledOutboundAdapter(), now, openWindow), {
    state: "disabled",
    code: "provider_disabled",
    availableAt: null,
    providerCalled: false,
  });
});

test("blocked policy and closed windows do not invoke even the local adapter", async () => {
  let adapterCalls = 0;
  const adapter: OutboundAdapter = {
    mode: "dry_run",
    async dispatch() {
      adapterCalls += 1;
      return { kind: "dry_run", code: "dry_run_no_provider_call" };
    },
  };

  const blocked = await dispatchOutboxMessage(
    { ...message, consentStatus: "unknown" },
    adapter,
    new Date("2026-08-17T14:00:00.000Z"),
    openWindow,
  );
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.code, "unknown_consent");

  const unresolvedIdentity = await dispatchOutboxMessage(
    { ...message, identityStatus: "review_required" },
    adapter,
    new Date("2026-08-17T14:00:00.000Z"),
    openWindow,
  );
  assert.equal(unresolvedIdentity.state, "blocked");
  assert.equal(unresolvedIdentity.code, "identity_review_required");

  const duplicateDestination = await dispatchOutboxMessage(
    { ...message, destinationUniqueOwner: false },
    adapter,
    new Date("2026-08-17T14:00:00.000Z"),
    openWindow,
  );
  assert.equal(duplicateDestination.state, "blocked");
  assert.equal(duplicateDestination.code, "duplicate_destination_ownership");

  const deferred = await dispatchOutboxMessage(
    message,
    adapter,
    new Date("2026-08-17T02:00:00.000Z"),
    openWindow,
  );
  assert.equal(deferred.state, "retry_scheduled");
  assert.equal(deferred.code, "outside_sending_window");
  assert.equal(adapterCalls, 0);
});

test("claimed database rows are validated before entering the dispatcher", () => {
  const parsed = parseClaimedOutboxRows([
    {
      id: "message-1",
      idempotency_key: "outbox:message-1",
      channel: "email",
      destination_snapshot: "person@example.com",
      subject_snapshot: null,
      body_snapshot: "Body",
      delivery_mode: "dry_run",
      live_suppression_status: "active",
      live_identity_status: "resolved",
      live_consent_status: "opted_in",
      live_contactability_status: "reachable",
      destination_current: true,
      destination_unique_owner: true,
      sending_time_zone: DEFAULT_SENDING_TIME_ZONE,
      sending_window_start_minute: 540,
      sending_window_end_minute: 1020,
      allowed_weekdays: [1, 2, 3, 4, 5],
      attempt_number: 1,
    },
  ]);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].message.destinationCurrent, true);
  assert.equal(parsed[0].message.identityStatus, "resolved");
  assert.equal(parsed[0].message.destinationUniqueOwner, true);
  assert.equal(parsed[0].mode, "dry_run");
  assert.throws(
    () => parseClaimedOutboxRows([{ delivery_mode: "live" }]),
    /Malformed outbox claim row/,
  );
});

test("campaign schema is private, idempotent, durable, and provider-disabled", () => {
  const migrationName = readdirSync(path.join(process.cwd(), "supabase", "migrations")).find((name) =>
    name.endsWith("_phase_2_campaign_outbox.sql"),
  );
  assert.ok(migrationName);
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", migrationName), "utf8");

  for (const table of [
    "message_templates",
    "message_template_versions",
    "campaigns",
    "campaign_recipients",
    "outbox_messages",
    "delivery_attempts",
    "outbound_audit_entries",
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, "i"));
  }

  assert.doesNotMatch(sql, /create\s+policy/i);
  assert.match(sql, /delivery_mode\s+text[\s\S]*in \('disabled', 'dry_run'\)/i);
  assert.doesNotMatch(sql, /delivery_mode[\s\S]{0,100}'live'/i);
  assert.match(sql, /provider_called boolean not null default false check \(provider_called = false\)/i);
  assert.match(sql, /provider_message_id text[\s\S]*provider_message_id is null/i);
  assert.match(sql, /idempotency_key text not null unique/i);
  assert.match(sql, /create index outbox_messages_due_idx[\s\S]*where status in \('pending', 'retry_scheduled'\)/i);
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /preview_event_audience_selection\(selected_selection\.id, 5001\)/i);
  assert.match(sql, /evaluated_count > 5000/i);
  assert.match(sql, /campaign_preview_stale_policy/i);
  assert.match(sql, /immutable_outbound_record/i);
  assert.match(sql, /live_identity_status text/i);
  assert.match(sql, /destination_unique_owner boolean/i);
  assert.match(sql, /duplicate_destination_ownership/i);

  const recordFunctionStart = sql.indexOf("create or replace function public.record_outbox_attempt");
  assert.notEqual(recordFunctionStart, -1);
  const recordFunction = sql.slice(recordFunctionStart, sql.indexOf("revoke execute", recordFunctionStart));
  const campaignLock = recordFunction.indexOf("select campaign.*");
  const messageLock = recordFunction.indexOf("select message.*");
  assert.ok(campaignLock >= 0 && messageLock > campaignLock, "record locks campaign before outbox message");
  assert.match(recordFunction, /selected_message\.status = 'retry_scheduled'[\s\S]*p_outcome = 'retry_scheduled'[\s\S]*already_recorded/i);

  for (const rpc of [
    "create_message_template_version",
    "create_campaign_preview",
    "queue_campaign_outbox",
    "claim_campaign_outbox",
    "record_outbox_attempt",
  ]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${rpc}[\\s\\S]*?security invoker[\\s\\S]*?set search_path = ''`, "i"));
    assert.match(sql, new RegExp(`revoke execute on function public\\.${rpc}[\\s\\S]*?from public, anon, authenticated`, "i"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${rpc}[\\s\\S]*?to service_role`, "i"));
  }
});

test("every campaign mutation rechecks the admin session", () => {
  const source = readFileSync(
    path.join(process.cwd(), "app", "admin", "(protected)", "campaigns", "actions.ts"),
    "utf8",
  );
  for (const actionName of [
    "createMessageTemplateVersionAction",
    "createCampaignPreviewAction",
    "queueCampaignOutboxAction",
    "dispatchCampaignBatchAction",
  ]) {
    const start = source.indexOf(`export async function ${actionName}`);
    assert.notEqual(start, -1);
    const nextExport = source.indexOf("export async function", start + 1);
    const body = source.slice(start, nextExport === -1 ? undefined : nextExport);
    assert.match(body, /await requireAdminSession\(\)/);
  }
});

test("campaign SQL executes an atomic preview-to-dry-run lifecycle", async () => {
  const database = new PGlite();
  const migrations = [
    "20260814000000_initial_events.sql",
    "20260814203000_phase_1_registration_core.sql",
    "20260814212500_registration_identity_snapshots.sql",
    "20260815053500_phase_2_audience_schema.sql",
    "20260815055000_phase_2_import_preview.sql",
    "20260815063744_phase_2_import_review_commit.sql",
    "20260818195406_phase_2_segmentation.sql",
    "20260818200000_phase_2_campaign_outbox.sql",
  ] as const;

  try {
    await database.exec("create role anon; create role authenticated; create role service_role;");
    for (const migration of migrations) {
      await database.exec(readFileSync(path.join(process.cwd(), "supabase", "migrations", migration), "utf8"));
    }

    const eventId = "00000000-0000-4000-8000-000000000401";
    const personId = "00000000-0000-4000-8000-000000000402";
    const segmentId = "00000000-0000-4000-8000-000000000403";
    const selectionId = "00000000-0000-4000-8000-000000000404";
    const templateRequestId = "00000000-0000-4000-8000-000000000405";
    const campaignRequestId = "00000000-0000-4000-8000-000000000406";
    const operator = "operator@example.com";

    await database.query(
      `insert into public.events
         (id, slug, title, description, venue, starts_at, price_cents, currency, status)
       values ($1, 'campaign-test', 'Campaign Test', '', 'Demo Hall', '2026-08-17T20:00:00Z', 1000, 'USD', 'published')`,
      [eventId],
    );
    await database.query(
      `insert into public.people (id, full_name, email, gender)
       values ($1, 'Eligible Guest', 'eligible@example.com', 'female')`,
      [personId],
    );
    await database.query(
      `insert into public.person_contacts
         (person_id, channel, value, normalized_value, is_primary, consent_status, contactability_status)
       values ($1, 'email', 'eligible@example.com', 'eligible@example.com', true, 'opted_in', 'reachable')`,
      [personId],
    );
    await database.query(
      `insert into public.audience_segments (id, name, created_by, updated_by)
       values ($1, 'Campaign SQL test', $2, $2)`,
      [segmentId, operator],
    );
    await database.query(
      `insert into public.event_audience_selections (
         id, event_id, segment_id, name, segment_version,
         snapshot_consent_requirement, snapshot_contactability_requirement,
         snapshot_prior_registration_payment_status, required_channel,
         created_by, updated_by
       ) values ($1, $2, $3, 'Campaign recipients', 1, 'any', 'any', 'any', 'email', $4, $4)`,
      [selectionId, eventId, segmentId, operator],
    );

    const template = await database.query<{ template_version_id: string }>(
      `select public.create_message_template_version(
         $1, 'campaign-sql-test', 'Campaign SQL test', 'email',
         'Hello {{full_name}}', 'Join {{event_title}} at {{venue}}.',
         array['full_name', 'event_title', 'venue']::text[], $2
       )->>'template_version_id' as template_version_id`,
      [templateRequestId, operator],
    );
    const templateVersionId = template.rows[0]?.template_version_id;
    assert.match(templateVersionId ?? "", /^[0-9a-f-]{36}$/i);

    const preview = await database.query<{ campaign_id: string; recipient_count: number }>(
      `select
         result->>'campaign_id' as campaign_id,
         (result->>'recipient_count')::integer as recipient_count
       from (
         select public.create_campaign_preview(
           $1, $2, $3, 'Campaign SQL lifecycle', 'dry_run',
           '2026-08-17T14:00:00Z', '09:00'::time, '17:00'::time,
           array[1,2,3,4,5]::smallint[], $4
         ) as result
       ) as created`,
      [campaignRequestId, selectionId, templateVersionId, operator],
    );
    const campaignId = preview.rows[0]?.campaign_id;
    assert.equal(preview.rows[0]?.recipient_count, 1);

    const repeatedPreview = await database.query<{ status: string }>(
      `select public.create_campaign_preview(
         $1, $2, $3, 'Campaign SQL lifecycle', 'dry_run',
         '2026-08-17T14:01:00Z', '09:00'::time, '17:00'::time,
         array[1,2,3,4,5]::smallint[], $4
       )->>'status' as status`,
      [campaignRequestId, selectionId, templateVersionId, operator],
    );
    assert.equal(repeatedPreview.rows[0]?.status, "already_created");

    await database.query("select public.queue_campaign_outbox($1, $2)", [campaignId, operator]);
    const claimed = await database.query<{ id: string }>(
      "select id from public.claim_campaign_outbox($1, $2, 50, $3)",
      [campaignId, `admin-foundation:${operator}`, "2026-08-17T14:00:00Z"],
    );
    assert.equal(claimed.rows.length, 1);

    const retry = await database.query<{ status: string }>(
      `select public.record_outbox_attempt(
         $1, $2, 'retry_scheduled', 'transient_local_failure', $3, $4, $5
       )->>'status' as status`,
      [
        claimed.rows[0]?.id,
        `admin-foundation:${operator}`,
        "2026-08-17T14:02:00Z",
        operator,
        "2026-08-17T14:00:01Z",
      ],
    );
    assert.equal(retry.rows[0]?.status, "recorded");

    const repeatedRetry = await database.query<{ status: string; attempt_number: number }>(
      `select
         result->>'status' as status,
         (result->>'attempt_number')::integer as attempt_number
       from (
         select public.record_outbox_attempt(
           $1, $2, 'retry_scheduled', 'transient_local_failure', $3, $4, $5
         ) as result
       ) as replayed`,
      [
        claimed.rows[0]?.id,
        `admin-foundation:${operator}`,
        "2026-08-17T14:02:00Z",
        operator,
        "2026-08-17T14:00:01Z",
      ],
    );
    assert.deepEqual(repeatedRetry.rows, [{ status: "already_recorded", attempt_number: 1 }]);

    const reclaimed = await database.query<{ id: string; attempt_number: number }>(
      "select id, attempt_number from public.claim_campaign_outbox($1, $2, 50, $3)",
      [campaignId, `admin-foundation:${operator}`, "2026-08-17T14:02:00Z"],
    );
    assert.deepEqual(reclaimed.rows, [{ id: claimed.rows[0]?.id, attempt_number: 2 }]);

    const nextRetry = await database.query<{ status: string; attempt_number: number }>(
      `select
         result->>'status' as status,
         (result->>'attempt_number')::integer as attempt_number
       from (
         select public.record_outbox_attempt(
           $1, $2, 'retry_scheduled', 'transient_local_failure', $3, $4, $5
         ) as result
       ) as recorded`,
      [
        reclaimed.rows[0]?.id,
        `admin-foundation:${operator}`,
        "2026-08-17T14:04:00Z",
        operator,
        "2026-08-17T14:02:01Z",
      ],
    );
    assert.deepEqual(nextRetry.rows, [{ status: "recorded", attempt_number: 2 }]);

    const finalClaim = await database.query<{ id: string; attempt_number: number }>(
      "select id, attempt_number from public.claim_campaign_outbox($1, $2, 50, $3)",
      [campaignId, `admin-foundation:${operator}`, "2026-08-17T14:04:00Z"],
    );
    assert.deepEqual(finalClaim.rows, [{ id: claimed.rows[0]?.id, attempt_number: 3 }]);

    await database.query(
      "select public.record_outbox_attempt($1, $2, 'dry_run_completed', 'dry_run_no_provider_call', null, $3, $4)",
      [finalClaim.rows[0]?.id, `admin-foundation:${operator}`, operator, "2026-08-17T14:04:01Z"],
    );

    const campaign = await database.query<{ status: string }>(
      "select status from public.campaigns where id = $1",
      [campaignId],
    );
    assert.equal(campaign.rows[0]?.status, "dry_run_completed");

    const attempt = await database.query<{ provider_called: boolean; outcome: string; attempt_number: number }>(
      "select provider_called, outcome, attempt_number from public.delivery_attempts order by attempt_number",
    );
    assert.deepEqual(attempt.rows, [
      { provider_called: false, outcome: "retry_scheduled", attempt_number: 1 },
      { provider_called: false, outcome: "retry_scheduled", attempt_number: 2 },
      { provider_called: false, outcome: "dry_run_completed", attempt_number: 3 },
    ]);

    async function createTargetedPreview(input: {
      personId: string;
      segmentId: string;
      selectionId: string;
      requestId: string;
      city: string;
      destination: string;
      label: string;
    }): Promise<string> {
      await database.query(
        `insert into public.people (id, full_name, email, gender, city)
         values ($1, $2, $3, 'female', $4)`,
        [input.personId, `${input.label} Recipient`, `${input.label.toLowerCase()}@people.invalid`, input.city],
      );
      await database.query(
        `insert into public.person_contacts
           (person_id, channel, value, normalized_value, is_primary, consent_status, contactability_status)
         values ($1, 'email', $2, $2, true, 'opted_in', 'reachable')`,
        [input.personId, input.destination],
      );
      await database.query(
        `insert into public.audience_segments (id, name, city, created_by, updated_by)
         values ($1, $2, $3, $4, $4)`,
        [input.segmentId, `${input.label} segment`, input.city, operator],
      );
      await database.query(
        `insert into public.event_audience_selections (
           id, event_id, segment_id, name, segment_version, snapshot_city,
           snapshot_consent_requirement, snapshot_contactability_requirement,
           snapshot_prior_registration_payment_status, required_channel,
           created_by, updated_by
         ) values ($1, $2, $3, $4, 1, $5, 'any', 'any', 'any', 'email', $6, $6)`,
        [input.selectionId, eventId, input.segmentId, `${input.label} selection`, input.city, operator],
      );

      const created = await database.query<{ campaign_id: string }>(
        `select public.create_campaign_preview(
           $1, $2, $3, $4, 'dry_run',
           '2026-08-17T14:00:00Z', '09:00'::time, '17:00'::time,
           array[1,2,3,4,5]::smallint[], $5
         )->>'campaign_id' as campaign_id`,
        [input.requestId, input.selectionId, templateVersionId, `${input.label} campaign`, operator],
      );
      const createdCampaignId = created.rows[0]?.campaign_id;
      assert.match(createdCampaignId ?? "", /^[0-9a-f-]{36}$/i);
      return createdCampaignId;
    }

    async function insertDestinationCoOwner(
      personIdentifier: string,
      email: string,
      destination: string,
    ): Promise<void> {
      await database.query(
        `insert into public.people (id, full_name, email, gender, city)
         values ($1, 'Destination Co-owner', $2, 'female', 'Different City')`,
        [personIdentifier, email],
      );
      await database.query(
        `insert into public.person_contacts
           (person_id, channel, value, normalized_value, is_primary, consent_status, contactability_status)
         values ($1, 'email', $2, $2, true, 'opted_in', 'reachable')`,
        [personIdentifier, destination],
      );
    }

    const queueDestination = "queue-ownership@example.com";
    const queueOwnershipCampaignId = await createTargetedPreview({
      personId: "00000000-0000-4000-8000-000000000410",
      segmentId: "00000000-0000-4000-8000-000000000411",
      selectionId: "00000000-0000-4000-8000-000000000412",
      requestId: "00000000-0000-4000-8000-000000000413",
      city: "Queue City",
      destination: queueDestination,
      label: "QueueOwnership",
    });
    await insertDestinationCoOwner(
      "00000000-0000-4000-8000-000000000414",
      "queue-co-owner@people.invalid",
      queueDestination,
    );

    const queueOwnership = await database.query<{ blocked_count: number }>(
      `select (public.queue_campaign_outbox($1, $2)->>'blocked_count')::integer as blocked_count`,
      [queueOwnershipCampaignId, operator],
    );
    assert.equal(queueOwnership.rows[0]?.blocked_count, 1);
    const queueBlockedMessage = await database.query<{ status: string; last_result_code: string }>(
      `select status, last_result_code
       from public.outbox_messages
       where campaign_id = $1`,
      [queueOwnershipCampaignId],
    );
    assert.deepEqual(queueBlockedMessage.rows, [
      { status: "blocked", last_result_code: "duplicate_destination_ownership" },
    ]);

    const claimDestination = "claim-ownership@example.com";
    const claimOwnershipCampaignId = await createTargetedPreview({
      personId: "00000000-0000-4000-8000-000000000420",
      segmentId: "00000000-0000-4000-8000-000000000421",
      selectionId: "00000000-0000-4000-8000-000000000422",
      requestId: "00000000-0000-4000-8000-000000000423",
      city: "Claim City",
      destination: claimDestination,
      label: "ClaimOwnership",
    });
    await database.query("select public.queue_campaign_outbox($1, $2)", [claimOwnershipCampaignId, operator]);
    await insertDestinationCoOwner(
      "00000000-0000-4000-8000-000000000424",
      "claim-co-owner@people.invalid",
      claimDestination,
    );

    const ownershipClaim = await database.query<Record<string, unknown>>(
      "select * from public.claim_campaign_outbox($1, $2, 50, $3)",
      [claimOwnershipCampaignId, `admin-foundation:${operator}`, "2026-08-17T14:00:00Z"],
    );
    assert.equal(ownershipClaim.rows[0]?.live_identity_status, "resolved");
    assert.equal(ownershipClaim.rows[0]?.destination_unique_owner, false);
    const parsedOwnershipClaim = parseClaimedOutboxRows(ownershipClaim.rows);
    const ownershipDecision = await dispatchOutboxMessage(
      parsedOwnershipClaim[0].message,
      new DryRunOutboundAdapter(),
      new Date("2026-08-17T14:00:00Z"),
      parsedOwnershipClaim[0].sendingWindow,
    );
    assert.deepEqual(ownershipDecision, {
      state: "blocked",
      code: "duplicate_destination_ownership",
      availableAt: null,
      providerCalled: false,
    });
    await database.query(
      "select public.record_outbox_attempt($1, $2, 'blocked', $3, null, $4, $5)",
      [
        parsedOwnershipClaim[0].message.id,
        `admin-foundation:${operator}`,
        ownershipDecision.code,
        operator,
        "2026-08-17T14:00:01Z",
      ],
    );

    const ownershipAttempt = await database.query<{ outcome: string; result_code: string; provider_called: boolean }>(
      `select attempt.outcome, attempt.result_code, attempt.provider_called
       from public.delivery_attempts as attempt
       join public.outbox_messages as message on message.id = attempt.outbox_message_id
       where message.campaign_id = $1`,
      [claimOwnershipCampaignId],
    );
    assert.deepEqual(ownershipAttempt.rows, [
      { outcome: "blocked", result_code: "duplicate_destination_ownership", provider_called: false },
    ]);
  } finally {
    await database.close();
  }
});
