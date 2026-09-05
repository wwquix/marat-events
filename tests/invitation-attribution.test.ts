import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import {
  generateInvitationToken,
  hashInvitationToken,
  parseInvitationToken,
} from "../lib/invitations/token";

const MIGRATIONS = [
  "20260814000000_initial_events.sql",
  "20260814203000_phase_1_registration_core.sql",
  "20260814212500_registration_identity_snapshots.sql",
  "20260815053500_phase_2_audience_schema.sql",
  "20260815055000_phase_2_import_preview.sql",
  "20260815063744_phase_2_import_review_commit.sql",
  "20260818193000_phase_2_identity_integrity.sql",
  "20260818195406_phase_2_segmentation.sql",
  "20260818195538_phase_3_check_in.sql",
  "20260818200000_phase_2_campaign_outbox.sql",
  "20260818201300_phase_4_matching.sql",
  "20260818201528_phase_5_crm.sql",
  "20260818204122_database_integrity_hardening.sql",
  "20260818205940_phase_2_invitation_attribution.sql",
] as const;

const ids = {
  event: "00000000-0000-4000-8000-000000000701",
  otherEvent: "00000000-0000-4000-8000-000000000702",
  ticket: "00000000-0000-4000-8000-000000000703",
  otherTicket: "00000000-0000-4000-8000-000000000704",
  invitedPerson: "00000000-0000-4000-8000-000000000705",
  otherPerson: "00000000-0000-4000-8000-000000000706",
  contact: "00000000-0000-4000-8000-000000000707",
  segment: "00000000-0000-4000-8000-000000000708",
  selection: "00000000-0000-4000-8000-000000000709",
  template: "00000000-0000-4000-8000-000000000710",
  templateVersion: "00000000-0000-4000-8000-000000000711",
  templateRequest: "00000000-0000-4000-8000-000000000712",
  campaign: "00000000-0000-4000-8000-000000000713",
  campaignRequest: "00000000-0000-4000-8000-000000000714",
  recipient: "00000000-0000-4000-8000-000000000715",
  issueRequest: "00000000-0000-4000-8000-000000000716",
  expiredToken: "00000000-0000-4000-8000-000000000717",
  expiredRequest: "00000000-0000-4000-8000-000000000718",
} as const;

async function migratedDatabase(): Promise<PGlite> {
  const database = new PGlite();
  await database.exec("create role anon; create role authenticated; create role service_role;");

  for (const migration of MIGRATIONS) {
    const sql = readFileSync(
      path.join(process.cwd(), "supabase", "migrations", migration),
      "utf8",
    );
    await database.exec(sql);
  }

  return database;
}

async function seedCampaign(database: PGlite): Promise<void> {
  await database.query(
    `insert into public.events
       (id, slug, title, description, venue, starts_at, price_cents, currency, status)
     values
       ($1, 'invite-event', 'Invite Event', '', 'Venue', now() + interval '60 days', 2500, 'USD', 'published'),
       ($2, 'other-event', 'Other Event', '', 'Venue', now() + interval '60 days', 2500, 'USD', 'published')`,
    [ids.event, ids.otherEvent],
  );
  await database.query(
    `insert into public.ticket_types
       (id, event_id, code, name, audience, price_cents, currency, status)
     values
       ($1, $3, 'general', 'General', 'any', 2500, 'USD', 'active'),
       ($2, $4, 'general', 'General', 'any', 2500, 'USD', 'active')`,
    [ids.ticket, ids.otherTicket, ids.event, ids.otherEvent],
  );
  await database.query(
    `insert into public.people (id, full_name, email, phone, gender)
     values
       ($1, 'Invited Person', 'invited@example.com', '+1 212 555 0701', 'female'),
       ($2, 'Other Person', 'other-invite@example.com', '+1 212 555 0702', 'male')`,
    [ids.invitedPerson, ids.otherPerson],
  );
  await database.query(
    `insert into public.person_contacts
       (id, person_id, channel, value, normalized_value, is_primary, consent_status, contactability_status)
     values ($1, $2, 'email', 'invited@example.com', 'invited@example.com', true, 'opted_in', 'reachable')`,
    [ids.contact, ids.invitedPerson],
  );
  await database.query(
    `insert into public.audience_segments
       (id, name, contact_channel, consent_requirement, contactability_requirement, created_by, updated_by)
     values ($1, 'Invite segment', 'email', 'opted_in', 'reachable', 'operator@example.com', 'operator@example.com')`,
    [ids.segment],
  );
  await database.query(
    `insert into public.event_audience_selections
       (id, event_id, segment_id, name, segment_version, snapshot_contact_channel,
        snapshot_consent_requirement, snapshot_contactability_requirement,
        snapshot_prior_registration_payment_status, required_channel, created_by, updated_by)
     values
       ($1, $2, $3, 'Invite selection', 1, 'email', 'opted_in', 'reachable',
        'any', 'email', 'operator@example.com', 'operator@example.com')`,
    [ids.selection, ids.event, ids.segment],
  );
  await database.query(
    `insert into public.message_templates
       (id, template_key, name, channel, created_by, updated_by)
     values ($1, 'invite-template', 'Invite template', 'email', 'operator@example.com', 'operator@example.com')`,
    [ids.template],
  );
  await database.query(
    `insert into public.message_template_versions
       (id, request_id, template_id, channel, version, subject_template, body_template, created_by)
     values ($1, $2, $3, 'email', 1, 'Invitation', 'Join us', 'operator@example.com')`,
    [ids.templateVersion, ids.templateRequest, ids.template],
  );
  await database.query(
    `insert into public.campaigns
       (id, request_id, event_id, audience_selection_id, template_version_id, name, channel,
        delivery_mode, selection_updated_at_snapshot, recipient_count, created_by, updated_by)
     values
       ($1, $2, $3, $4, $5, 'Invite campaign', 'email', 'dry_run', now(), 1,
        'operator@example.com', 'operator@example.com')`,
    [ids.campaign, ids.campaignRequest, ids.event, ids.selection, ids.templateVersion],
  );
  await database.query(
    `insert into public.campaign_recipients
       (id, campaign_id, template_version_id, ordinal, person_id, contact_id, channel,
        destination_snapshot, normalized_destination_snapshot, consent_status_snapshot,
        contactability_status_snapshot, suppression_status_snapshot, identity_status_snapshot,
        eligibility, policy_reason, rendered_subject_snapshot, rendered_body_snapshot,
        idempotency_key, available_at)
     values
       ($1, $2, $3, 1, $4, $5, 'email', 'invited@example.com', 'invited@example.com',
        'opted_in', 'reachable', 'active', 'resolved', 'eligible', 'allowed',
        'Invitation', 'Join us', 'invite-recipient-1', now())`,
    [ids.recipient, ids.campaign, ids.templateVersion, ids.invitedPerson, ids.contact],
  );
}

type JsonResult = { result: Record<string, unknown> };

async function createRegistration(
  database: PGlite,
  input: {
    eventId: string;
    personId: string;
    ticketId: string;
    tokenHash: string | null;
  },
): Promise<Record<string, unknown>> {
  const result = await database.query<JsonResult>(
    `select public.create_pending_registration_with_invitation(
       $1, $2, $3, 'Checkout Guest', 'checkout@example.com', '+1 212 555 0799',
       31, 'female', 2500, 'USD', $4
     ) as result`,
    [input.eventId, input.personId, input.ticketId, input.tokenHash],
  );
  return result.rows[0]?.result ?? {};
}

test("invitation tokens are opaque random bearer values and hash deterministically", () => {
  const tokens = new Set(Array.from({ length: 64 }, () => generateInvitationToken()));
  assert.equal(tokens.size, 64);

  for (const token of tokens) {
    assert.match(token, /^mi_[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(token, /[0-9a-f]{8}-[0-9a-f]{4}-/i);
    assert.equal(parseInvitationToken(` ${token} `), token);
    assert.match(hashInvitationToken(token), /^[0-9a-f]{64}$/);
    assert.equal(hashInvitationToken(token), hashInvitationToken(token));
  }

  assert.equal(parseInvitationToken("not-an-invitation"), null);
  assert.equal(parseInvitationToken(null), null);
  assert.throws(() => hashInvitationToken("not-an-invitation"), /Invalid invitation token/);
});

test("public checkout carries only normalized tokens and uses the atomic registration RPC", () => {
  const eventPage = readFileSync(
    path.join(process.cwd(), "app", "events", "[slug]", "page.tsx"),
    "utf8",
  );
  const checkoutRoute = readFileSync(
    path.join(process.cwd(), "app", "api", "checkout", "route.ts"),
    "utf8",
  );
  const migration = readFileSync(
    path.join(
      process.cwd(),
      "supabase",
      "migrations",
      "20260818205940_phase_2_invitation_attribution.sql",
    ),
    "utf8",
  );

  assert.match(eventPage, /parseInvitationToken/);
  assert.match(eventPage, /name="invite_token"/);
  assert.match(checkoutRoute, /createPendingRegistrationWithInvitation/);
  assert.doesNotMatch(checkoutRoute, /tokenHash|token_hash/);
  assert.match(migration, /for share of invitation, recipient, campaign/);
  assert.match(
    migration,
    /before update of event_id, person_id, campaign_recipient_id, invitation_token_id, source/,
  );
});

test("issuance is exact-replay idempotent and stores only the token hash", async () => {
  const database = await migratedDatabase();

  try {
    await seedCampaign(database);
    const token = generateInvitationToken();
    const tokenHash = hashInvitationToken(token);
    const issued = await database.query<JsonResult>(
      `select public.issue_campaign_invitation_token(
         $1, $2, $3, now() + interval '30 days', 'operator@example.com'
       ) as result`,
      [ids.issueRequest, ids.recipient, tokenHash],
    );
    assert.equal(issued.rows[0]?.result.status, "issued");
    assert.equal(issued.rows[0]?.result.campaign_recipient_id, ids.recipient);
    assert.equal(issued.rows[0]?.result.event_id, ids.event);

    const replay = await database.query<JsonResult>(
      `select public.issue_campaign_invitation_token($1, $2, $3, $4, 'operator@example.com') as result`,
      [
        ids.issueRequest,
        ids.recipient,
        tokenHash,
        issued.rows[0]?.result.expires_at,
      ],
    );
    assert.equal(replay.rows[0]?.result.status, "already_issued");
    assert.equal(replay.rows[0]?.result.token_id, issued.rows[0]?.result.token_id);

    await assert.rejects(
      database.query(
        `select public.issue_campaign_invitation_token($1, $2, $3, $4, 'operator@example.com')`,
        [
          ids.issueRequest,
          ids.recipient,
          "f".repeat(64),
          issued.rows[0]?.result.expires_at,
        ],
      ),
      /invitation_request_conflict/,
    );

    await database.query(
      "update public.people set suppression_status = 'suppressed' where id = $1",
      [ids.invitedPerson],
    );
    await assert.rejects(
      database.query(
        `select public.issue_campaign_invitation_token(
           $1, $2, $3, now() + interval '30 days', 'operator@example.com'
         )`,
        [
          "00000000-0000-4000-8000-000000000721",
          ids.recipient,
          "a".repeat(64),
        ],
      ),
      /campaign_recipient_not_invitable/,
    );
    await database.query(
      "update public.people set suppression_status = 'active' where id = $1",
      [ids.invitedPerson],
    );
    await database.query(
      "update public.person_contacts set consent_status = 'opted_out' where id = $1",
      [ids.contact],
    );
    await assert.rejects(
      database.query(
        `select public.issue_campaign_invitation_token(
           $1, $2, $3, now() + interval '30 days', 'operator@example.com'
         )`,
        [
          "00000000-0000-4000-8000-000000000722",
          ids.recipient,
          "b".repeat(64),
        ],
      ),
      /campaign_recipient_not_invitable/,
    );
    await database.query(
      "update public.person_contacts set consent_status = 'opted_in' where id = $1",
      [ids.contact],
    );
    await database.query(
      `insert into public.person_contacts
         (id, person_id, channel, value, normalized_value, consent_status, contactability_status)
       values
         ('00000000-0000-4000-8000-000000000723', $1, 'email',
          'invited@example.com', 'invited@example.com', 'opted_in', 'reachable')`,
      [ids.otherPerson],
    );
    await assert.rejects(
      database.query(
        `select public.issue_campaign_invitation_token(
           $1, $2, $3, now() + interval '30 days', 'operator@example.com'
         )`,
        [
          "00000000-0000-4000-8000-000000000724",
          ids.recipient,
          "c".repeat(64),
        ],
      ),
      /campaign_recipient_destination_ambiguous/,
    );

    const stored = await database.query<{ token_hash: string; column_count: number }>(
      `select invitation.token_hash,
              (select count(*)::integer
               from information_schema.columns
               where table_schema = 'public'
                 and table_name = 'campaign_invitation_tokens'
                 and column_name in ('token', 'raw_token', 'invitation_token')) as column_count
       from public.campaign_invitation_tokens as invitation
       where invitation.request_id = $1`,
      [ids.issueRequest],
    );
    assert.equal(stored.rows[0]?.token_hash, tokenHash);
    assert.notEqual(stored.rows[0]?.token_hash, token);
    assert.equal(stored.rows[0]?.column_count, 0);

    const audit = await database.query<{ actions: string[] }>(
      `select array_agg(action order by action)::text[] as actions
       from public.outbound_audit_entries
       where campaign_recipient_id = $1`,
      [ids.recipient],
    );
    assert.deepEqual(audit.rows[0]?.actions, ["campaign_invitation_issued"]);
  } finally {
    await database.close();
  }
});

test("checkout attributes only a current event-bound token owned by the resolved person", async () => {
  const database = await migratedDatabase();

  try {
    await seedCampaign(database);
    const tokenHash = hashInvitationToken(generateInvitationToken());
    const issued = await database.query<JsonResult>(
      `select public.issue_campaign_invitation_token(
         $1, $2, $3, now() + interval '30 days', 'operator@example.com'
       ) as result`,
      [ids.issueRequest, ids.recipient, tokenHash],
    );

    const attributed = await createRegistration(database, {
      eventId: ids.event,
      personId: ids.invitedPerson,
      ticketId: ids.ticket,
      tokenHash,
    });
    assert.equal(attributed.attributed, true);
    assert.equal(attributed.campaign_recipient_id, ids.recipient);

    await assert.rejects(
      database.query(
        "update public.registrations set person_id = $1 where id = $2",
        [ids.otherPerson, attributed.registration_id],
      ),
      /invalid_campaign_invitation_attribution/,
    );

    const wrongPerson = await createRegistration(database, {
      eventId: ids.event,
      personId: ids.otherPerson,
      ticketId: ids.ticket,
      tokenHash,
    });
    assert.equal(wrongPerson.attributed, false);
    assert.equal(wrongPerson.campaign_recipient_id, null);

    const wrongEvent = await createRegistration(database, {
      eventId: ids.otherEvent,
      personId: ids.invitedPerson,
      ticketId: ids.otherTicket,
      tokenHash,
    });
    assert.equal(wrongEvent.attributed, false);

    const ordinary = await createRegistration(database, {
      eventId: ids.event,
      personId: ids.otherPerson,
      ticketId: ids.ticket,
      tokenHash: null,
    });
    assert.equal(ordinary.attributed, false);

    const registrations = await database.query<{
      id: string;
      source: string;
      campaign_recipient_id: string | null;
      invitation_token_id: string | null;
    }>(
      `select id, source, campaign_recipient_id, invitation_token_id
       from public.registrations
       order by created_at, id`,
    );
    assert.equal(registrations.rows.filter((row) => row.source === "campaign_invite").length, 1);
    assert.equal(
      registrations.rows.find((row) => row.source === "campaign_invite")?.invitation_token_id,
      issued.rows[0]?.result.token_id,
    );
    assert.ok(
      registrations.rows
        .filter((row) => row.source === "event_page")
        .every((row) => row.campaign_recipient_id === null && row.invitation_token_id === null),
    );

    const attributionAudit = await database.query<{
      action: string;
      campaign_recipient_id: string;
      registration_id: string;
    }>(
      `select action, campaign_recipient_id, details ->> 'registration_id' as registration_id
       from public.outbound_audit_entries
       where action = 'campaign_invitation_attributed'`,
    );
    assert.deepEqual(attributionAudit.rows, [
      {
        action: "campaign_invitation_attributed",
        campaign_recipient_id: ids.recipient,
        registration_id: attributed.registration_id,
      },
    ]);
  } finally {
    await database.close();
  }
});

test("revoked, expired, malformed and cancelled-campaign tokens fail closed to ordinary checkout", async () => {
  const database = await migratedDatabase();

  try {
    await seedCampaign(database);
    const revokedHash = hashInvitationToken(generateInvitationToken());
    const issued = await database.query<JsonResult>(
      `select public.issue_campaign_invitation_token(
         $1, $2, $3, now() + interval '30 days', 'operator@example.com'
       ) as result`,
      [ids.issueRequest, ids.recipient, revokedHash],
    );
    const tokenId = String(issued.rows[0]?.result.token_id);

    const revoked = await database.query<JsonResult>(
      `select public.revoke_campaign_invitation_token(
         $1, 'operator@example.com', 'recipient requested revocation'
       ) as result`,
      [tokenId],
    );
    assert.equal(revoked.rows[0]?.result.status, "revoked");
    const replay = await database.query<JsonResult>(
      `select public.revoke_campaign_invitation_token(
         $1, 'operator@example.com', 'recipient requested revocation'
       ) as result`,
      [tokenId],
    );
    assert.equal(replay.rows[0]?.result.status, "already_revoked");

    const revokedRegistration = await createRegistration(database, {
      eventId: ids.event,
      personId: ids.invitedPerson,
      ticketId: ids.ticket,
      tokenHash: revokedHash,
    });
    assert.equal(revokedRegistration.attributed, false);

    const expiredHash = "e".repeat(64);
    await database.query(
      `insert into public.campaign_invitation_tokens
         (id, request_id, campaign_id, campaign_recipient_id, event_id, token_hash,
          expires_at, issued_by, created_at)
       values
         ($1, $2, $3, $4, $5, $6, now() - interval '1 day',
          'operator@example.com', now() - interval '2 days')`,
      [
        ids.expiredToken,
        ids.expiredRequest,
        ids.campaign,
        ids.recipient,
        ids.event,
        expiredHash,
      ],
    );
    const expiredRegistration = await createRegistration(database, {
      eventId: ids.event,
      personId: ids.invitedPerson,
      ticketId: ids.ticket,
      tokenHash: expiredHash,
    });
    assert.equal(expiredRegistration.attributed, false);

    const malformedRegistration = await createRegistration(database, {
      eventId: ids.event,
      personId: ids.invitedPerson,
      ticketId: ids.ticket,
      tokenHash: "not-a-hash",
    });
    assert.equal(malformedRegistration.attributed, false);

    await database.query(
      `update public.campaigns
       set status = 'cancelled', queued_at = now(), completed_at = now(), updated_at = now()
       where id = $1`,
      [ids.campaign],
    );
    const cancelledHash = "d".repeat(64);
    await database.query(
      `insert into public.campaign_invitation_tokens
         (request_id, campaign_id, campaign_recipient_id, event_id, token_hash, expires_at, issued_by)
       values ($1, $2, $3, $4, $5, now() + interval '30 days', 'operator@example.com')`,
      [
        "00000000-0000-4000-8000-000000000719",
        ids.campaign,
        ids.recipient,
        ids.event,
        cancelledHash,
      ],
    );
    const cancelledRegistration = await createRegistration(database, {
      eventId: ids.event,
      personId: ids.invitedPerson,
      ticketId: ids.ticket,
      tokenHash: cancelledHash,
    });
    assert.equal(cancelledRegistration.attributed, false);

    const unattributed = await database.query<{ count: number }>(
      `select count(*)::integer as count
       from public.registrations
       where source = 'event_page'
         and campaign_recipient_id is null
         and invitation_token_id is null`,
    );
    assert.equal(unattributed.rows[0]?.count, 4);
  } finally {
    await database.close();
  }
});

test("database constraints reject forged attribution and public roles cannot access invitation data", async () => {
  const database = await migratedDatabase();

  try {
    await seedCampaign(database);
    const tokenHash = hashInvitationToken(generateInvitationToken());
    const issued = await database.query<JsonResult>(
      `select public.issue_campaign_invitation_token(
         $1, $2, $3, now() + interval '30 days', 'operator@example.com'
       ) as result`,
      [ids.issueRequest, ids.recipient, tokenHash],
    );

    await assert.rejects(
      database.query(
        `insert into public.registrations
           (event_id, person_id, ticket_type_id, full_name, email, phone, age, gender,
            source, amount_cents, currency, campaign_recipient_id, invitation_token_id)
         values
           ($1, $2, $3, 'Forged', 'forged@example.com', '+1 212 555 0788', 31, 'female',
            'campaign_invite', 2500, 'USD', $4, $5)`,
        [
          ids.otherEvent,
          ids.invitedPerson,
          ids.otherTicket,
          ids.recipient,
          issued.rows[0]?.result.token_id,
        ],
      ),
      /invalid_campaign_invitation_attribution|registrations_invitation_attribution_fkey/,
    );

    await assert.rejects(
      database.query(
        `update public.campaign_invitation_tokens
         set token_hash = $1
         where id = $2`,
        ["a".repeat(64), issued.rows[0]?.result.token_id],
      ),
      /campaign_invitation_token_identity_immutable/,
    );

    const privileges = await database.query<{
      table_select: boolean;
      issue_execute: boolean;
      create_execute: boolean;
    }>(
      `select
         has_table_privilege('anon', 'public.campaign_invitation_tokens', 'select') as table_select,
         has_function_privilege(
           'anon',
           'public.issue_campaign_invitation_token(uuid,uuid,text,timestamptz,text)',
           'execute'
         ) as issue_execute,
         has_function_privilege(
           'anon',
           'public.create_pending_registration_with_invitation(uuid,uuid,uuid,text,text,text,integer,text,integer,text,text)',
           'execute'
         ) as create_execute`,
    );
    assert.deepEqual(privileges.rows[0], {
      table_select: false,
      issue_execute: false,
      create_execute: false,
    });

    await database.exec("set role anon;");
    await assert.rejects(
      database.query("select id from public.campaign_invitation_tokens"),
      /permission denied/,
    );
    await assert.rejects(
      database.query(
        "select public.issue_campaign_invitation_token($1, $2, $3, now() + interval '1 day', 'anon')",
        [
          "00000000-0000-4000-8000-000000000720",
          ids.recipient,
          "c".repeat(64),
        ],
      ),
      /permission denied/,
    );
    await database.exec("reset role;");
  } finally {
    await database.close();
  }
});
