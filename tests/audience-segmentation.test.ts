import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import {
  normalizeSegmentFilter,
  parseCampaignPreview,
  summarizeCampaignPreview,
  type AudienceSegmentFilter,
  type CampaignPreviewRow,
} from "../lib/audience/segmentation";

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const PEOPLE = {
  eligible: "20000000-0000-4000-8000-000000000001",
  suppressed: "20000000-0000-4000-8000-000000000002",
  review: "20000000-0000-4000-8000-000000000003",
  missing: "20000000-0000-4000-8000-000000000004",
  noConsent: "20000000-0000-4000-8000-000000000005",
  unreachable: "20000000-0000-4000-8000-000000000006",
  priorInvite: "20000000-0000-4000-8000-000000000007",
  registered: "20000000-0000-4000-8000-000000000008",
} as const;

const EMPTY_FILTER: AudienceSegmentFilter = {
  version: 1,
  genders: [],
  cities: [],
  occupations: [],
  educations: [],
  sources: [],
  sourceReferences: [],
  importBatchIds: [],
};

async function migratedDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");

  const migrationsDirectory = path.join(process.cwd(), "supabase", "migrations");
  for (const filename of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(path.join(migrationsDirectory, filename), "utf8"));
  }
  return db;
}

async function seedAudience(db: PGlite) {
  await db.query(
    `insert into public.events (id, slug, title, description, venue, starts_at, capacity, price_cents, currency, status)
     values ($1, 'segmentation-test', 'Segmentation Test', 'Test', 'Test venue', '2026-09-01T23:00:00Z', 100, 1000, 'USD', 'published')`,
    [EVENT_ID],
  );

  const people = [
    [PEOPLE.eligible, "Eligible Person", "eligible"],
    [PEOPLE.suppressed, "Suppressed Person", "suppressed"],
    [PEOPLE.review, "Review Person", "review"],
    [PEOPLE.missing, "Missing Contact", "missing"],
    [PEOPLE.noConsent, "No Consent", "no-consent"],
    [PEOPLE.unreachable, "Unreachable", "unreachable"],
    [PEOPLE.priorInvite, "Prior Invite", "prior"],
    [PEOPLE.registered, "Registered Person", "registered"],
  ];
  for (const [id, name, source] of people) {
    await db.query(
      `insert into public.people (id, full_name, source, source_reference, suppression_status, identity_status)
       values ($1, $2, $3, $4, 'active', 'resolved')`,
      [id, name, source, `${source}-reference`],
    );
  }
  await db.query("update public.people set suppression_status = 'suppressed' where id = $1", [PEOPLE.suppressed]);
  await db.query("update public.people set identity_status = 'review_required' where id = $1", [PEOPLE.review]);

  const contacts = [
    [PEOPLE.eligible, "eligible@example.com", "opted_in", "reachable"],
    [PEOPLE.suppressed, "suppressed@example.com", "opted_in", "reachable"],
    [PEOPLE.review, "review@example.com", "opted_in", "reachable"],
    [PEOPLE.noConsent, "no-consent@example.com", "unknown", "reachable"],
    [PEOPLE.unreachable, "unreachable@example.com", "opted_in", "unreachable"],
    [PEOPLE.priorInvite, "prior@example.com", "opted_in", "reachable"],
    [PEOPLE.registered, "registered@example.com", "opted_in", "reachable"],
  ];
  for (const [personId, email, consent, contactability] of contacts) {
    await db.query(
      `insert into public.person_contacts
        (person_id, channel, value, normalized_value, is_primary, consent_status, contactability_status, source)
       values ($1, 'email', $2, $2, true, $3, $4, 'test')`,
      [personId, email, consent, contactability],
    );
  }
}

async function commitCampaign(
  db: PGlite,
  options: { name: string; segmentName: string; filter: typeof EMPTY_FILTER },
): Promise<{ campaign_id: string; eligible_count: number; excluded_count: number }> {
  const result = await db.query<{ result: { campaign_id: string; eligible_count: number; excluded_count: number } }>(
    `select public.commit_invitation_campaign(
      $1::uuid, null::uuid, $2::text, null::text, $3::text, 'email'::text, $4::jsonb, 'admin@example.com'::text
    ) as result`,
    [EVENT_ID, options.segmentName, options.name, JSON.stringify(options.filter)],
  );
  return result.rows[0].result;
}

test("segment filters are versioned, normalized, and fail closed", () => {
  assert.deepEqual(
    normalizeSegmentFilter({
      genders: ["female", "female"],
      cities: " New York, Boston\nNew York ",
      importBatchIds: [],
    }),
    {
      ...EMPTY_FILTER,
      genders: ["female"],
      cities: ["New York", "Boston"],
    },
  );
  assert.equal(normalizeSegmentFilter({ genders: ["unknown"] }), null);
  assert.equal(normalizeSegmentFilter({ importBatchIds: ["not-a-uuid"] }), null);
});

test("preview parsing verifies database totals and row eligibility invariants", () => {
  const rows: CampaignPreviewRow[] = [
    {
      person_id: PEOPLE.eligible,
      full_name: "Eligible",
      city: null,
      source: null,
      eligibility_status: "eligible",
      person_contact_id: "30000000-0000-4000-8000-000000000001",
      contact_value: "eligible@example.com",
      exclusion_reasons: [],
    },
    {
      person_id: PEOPLE.suppressed,
      full_name: "Suppressed",
      city: null,
      source: null,
      eligibility_status: "excluded",
      person_contact_id: null,
      contact_value: null,
      exclusion_reasons: ["person_suppressed", "missing_channel"],
    },
  ];
  assert.deepEqual(summarizeCampaignPreview(rows), {
    candidates: 2,
    eligible: 1,
    excluded: 1,
    reasonCounts: [
      { reason: "missing_channel", count: 1 },
      { reason: "person_suppressed", count: 1 },
    ],
  });
  assert.ok(parseCampaignPreview({ candidate_count: 2, eligible_count: 1, excluded_count: 1, rows }));
  assert.equal(parseCampaignPreview({ candidate_count: 1, eligible_count: 1, excluded_count: 0, rows }), null);
});

test("database preview enforces every automatic exclusion rule", async () => {
  const db = await migratedDatabase();
  try {
    await seedAudience(db);
    const prior = await commitCampaign(db, {
      name: "Prior campaign",
      segmentName: "Prior segment",
      filter: { ...EMPTY_FILTER, sources: ["prior"] },
    });
    assert.equal(prior.eligible_count, 1);

    await db.query(
      `insert into public.registrations
        (event_id, person_id, full_name, email, amount_cents, currency, payment_status, source)
       values ($1, $2, 'Registered Person', 'registered@example.com', 1000, 'USD', 'pending', 'event_page')`,
      [EVENT_ID, PEOPLE.registered],
    );

    const result = await db.query<{ preview: unknown }>(
      "select public.preview_invitation_campaign($1::uuid, 'email'::text, $2::jsonb) as preview",
      [EVENT_ID, JSON.stringify(EMPTY_FILTER)],
    );
    const preview = parseCampaignPreview(result.rows[0].preview);
    assert.ok(preview);

    const rowsByPerson = new Map(preview.rows.map((row) => [row.person_id, row]));
    assert.equal(rowsByPerson.get(PEOPLE.eligible)?.eligibility_status, "eligible");
    assert.ok(rowsByPerson.get(PEOPLE.suppressed)?.exclusion_reasons.includes("person_suppressed"));
    assert.ok(rowsByPerson.get(PEOPLE.review)?.exclusion_reasons.includes("identity_review_required"));
    assert.ok(rowsByPerson.get(PEOPLE.missing)?.exclusion_reasons.includes("missing_channel"));
    assert.ok(rowsByPerson.get(PEOPLE.noConsent)?.exclusion_reasons.includes("channel_not_opted_in"));
    assert.ok(rowsByPerson.get(PEOPLE.unreachable)?.exclusion_reasons.includes("channel_not_reachable"));
    assert.ok(rowsByPerson.get(PEOPLE.priorInvite)?.exclusion_reasons.includes("already_invited"));
    assert.ok(rowsByPerson.get(PEOPLE.registered)?.exclusion_reasons.includes("already_registered"));
  } finally {
    await db.close();
  }
});

test("campaign commit prevents duplicate event targets and attributes later registrations", async () => {
  const db = await migratedDatabase();
  try {
    await seedAudience(db);
    await commitCampaign(db, {
      name: "Prior campaign",
      segmentName: "Prior segment",
      filter: { ...EMPTY_FILTER, sources: ["prior"] },
    });
    await db.query(
      `insert into public.registrations
        (event_id, person_id, full_name, email, amount_cents, currency, payment_status, source)
       values ($1, $2, 'Registered Person', 'registered@example.com', 1000, 'USD', 'pending', 'event_page')`,
      [EVENT_ID, PEOPLE.registered],
    );

    const current = await commitCampaign(db, {
      name: "Current campaign",
      segmentName: "All audience",
      filter: EMPTY_FILTER,
    });
    assert.ok(current.eligible_count > 0);

    await db.query(
      "update public.people set source = 'changed', source_reference = 'changed-reference' where id = $1",
      [PEOPLE.eligible],
    );
    const sourceAttribution = await db.query<{
      person_source_snapshot: string | null;
      person_source_reference_snapshot: string | null;
    }>(
      `select person_source_snapshot, person_source_reference_snapshot
       from public.invitation_campaign_results
       where campaign_id = $1 and person_id = $2`,
      [current.campaign_id, PEOPLE.eligible],
    );
    assert.deepEqual(sourceAttribution.rows[0], {
      person_source_snapshot: "eligible",
      person_source_reference_snapshot: "eligible-reference",
    });

    const duplicate = await db.query<{ count: number }>(
      `select count(*)::integer as count
       from public.invitation_campaign_results
       where event_id = $1 and person_id = $2 and eligibility_status = 'eligible'`,
      [EVENT_ID, PEOPLE.priorInvite],
    );
    assert.equal(duplicate.rows[0].count, 1);

    const registrationId = "40000000-0000-4000-8000-000000000001";
    await db.query(
      `insert into public.registrations
        (id, event_id, person_id, full_name, email, amount_cents, currency, payment_status, source)
       values ($1, $2, $3, 'Eligible Person', 'eligible@example.com', 1000, 'USD', 'pending', 'event_page')`,
      [registrationId, EVENT_ID, PEOPLE.eligible],
    );
    const attributed = await db.query<{ invitation_campaign_id: string | null }>(
      "select invitation_campaign_id from public.registrations where id = $1",
      [registrationId],
    );
    assert.equal(attributed.rows[0].invitation_campaign_id, current.campaign_id);
  } finally {
    await db.close();
  }
});

test("new targeting tables have RLS, no policies, and service-role-only RPC access", async () => {
  const db = await migratedDatabase();
  try {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity
       from pg_catalog.pg_class
       where relname in ('audience_segments', 'invitation_campaigns', 'invitation_campaign_results')
       order by relname`,
    );
    assert.equal(rls.rows.length, 3);
    assert.ok(rls.rows.every((row) => row.relrowsecurity));

    const policies = await db.query<{ count: number }>(
      `select count(*)::integer as count
       from pg_catalog.pg_policies
       where schemaname = 'public'
         and tablename in ('audience_segments', 'invitation_campaigns', 'invitation_campaign_results')`,
    );
    assert.equal(policies.rows[0].count, 0);

    const privileges = await db.query<{ anon_execute: boolean; authenticated_execute: boolean; service_execute: boolean }>(
      `select
        has_function_privilege('anon', 'public.preview_invitation_campaign(uuid,text,jsonb)', 'EXECUTE') as anon_execute,
        has_function_privilege('authenticated', 'public.preview_invitation_campaign(uuid,text,jsonb)', 'EXECUTE') as authenticated_execute,
        has_function_privilege('service_role', 'public.preview_invitation_campaign(uuid,text,jsonb)', 'EXECUTE') as service_execute`,
    );
    assert.deepEqual(privileges.rows[0], {
      anon_execute: false,
      authenticated_execute: false,
      service_execute: true,
    });
  } finally {
    await db.close();
  }
});

test("targeting mutations remain admin-only and preview remains a read-only GET", () => {
  const actions = readFileSync(
    path.join(process.cwd(), "app", "admin", "(protected)", "events", "[id]", "audience", "actions.ts"),
    "utf8",
  );
  const page = readFileSync(
    path.join(process.cwd(), "app", "admin", "(protected)", "events", "[id]", "audience", "page.tsx"),
    "utf8",
  );
  assert.match(actions, /const session = await requireAdminSession\(\)/);
  assert.match(actions, /\.rpc\("commit_invitation_campaign"/);
  assert.match(page, /method="get"/);
  assert.match(page, /\.rpc\("preview_invitation_campaign"/);
});
