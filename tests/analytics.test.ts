import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { parseEventAnalytics } from "../lib/analytics/event";

const MIGRATION = "20260818204014_phase_6_event_analytics.sql";
const IDS = {
  event: "00000000-0000-4000-8000-000000000601",
  selectionOne: "00000000-0000-4000-8000-000000000602",
  selectionTwo: "00000000-0000-4000-8000-000000000603",
  campaignOne: "00000000-0000-4000-8000-000000000604",
  campaignTwo: "00000000-0000-4000-8000-000000000605",
  personA: "00000000-0000-4000-8000-000000000611",
  personB: "00000000-0000-4000-8000-000000000612",
  personC: "00000000-0000-4000-8000-000000000613",
  ticket: "00000000-0000-4000-8000-000000000621",
  invalidTicket: "00000000-0000-4000-8000-000000000622",
  registrationA: "00000000-0000-4000-8000-000000000631",
  registrationB: "00000000-0000-4000-8000-000000000632",
  registrationC: "00000000-0000-4000-8000-000000000633",
  registrationUnlinked: "00000000-0000-4000-8000-000000000634",
  profileA: "00000000-0000-4000-8000-000000000641",
  profileB: "00000000-0000-4000-8000-000000000642",
  profileC: "00000000-0000-4000-8000-000000000643",
} as const;

async function analyticsDatabase(): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;

    create table public.events (
      id uuid primary key,
      slug text not null,
      title text not null,
      starts_at timestamptz not null,
      capacity integer,
      price_cents integer not null,
      currency text not null
    );
    create table public.event_audience_selections (
      id uuid primary key,
      event_id uuid not null,
      name text not null,
      status text not null
    );
    create table public.analytics_preview_results (
      selection_id uuid not null,
      person_id uuid not null,
      eligible boolean not null
    );
    create or replace function public.preview_event_audience_selection(p_selection_id uuid, p_limit integer)
    returns table(person_id uuid, eligible boolean)
    language sql stable security invoker set search_path = ''
    as $$
      select preview.person_id, preview.eligible
      from public.analytics_preview_results as preview
      where preview.selection_id = p_selection_id
      order by preview.person_id
      limit least(p_limit, 5001);
    $$;
    create table public.campaigns (
      id uuid primary key,
      event_id uuid not null,
      name text not null,
      channel text not null,
      delivery_mode text not null,
      status text not null,
      created_at timestamptz not null
    );
    create table public.campaign_recipients (
      id uuid primary key,
      campaign_id uuid not null,
      person_id uuid not null
    );
    create table public.outbox_messages (
      id uuid primary key,
      campaign_id uuid not null,
      status text not null
    );
    create table public.registrations (
      id uuid primary key,
      event_id uuid not null,
      person_id uuid,
      payment_status text not null,
      amount_cents integer not null,
      ticket_type_id uuid,
      source text
    );
    create table public.registration_check_ins (
      id uuid primary key default gen_random_uuid(),
      event_id uuid not null,
      registration_id uuid not null,
      status text not null
    );
    create table public.matching_participant_profiles (
      id uuid primary key,
      event_id uuid not null,
      status text not null
    );
    create table public.matching_likes (
      id uuid primary key default gen_random_uuid(),
      event_id uuid not null,
      liker_profile_id uuid not null
    );
    create table public.matching_matches (
      id uuid primary key default gen_random_uuid(),
      event_id uuid not null,
      profile_one_id uuid not null,
      profile_two_id uuid not null
    );
    create table public.ticket_types (
      id uuid primary key,
      event_id uuid not null,
      code text not null,
      name text not null,
      capacity integer,
      price_cents integer not null,
      currency text not null
    );
  `);
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", MIGRATION), "utf8");
  await database.exec(sql);
  return database;
}

test("event analytics computes authoritative distinct funnel counts and breakdowns", async () => {
  const database = await analyticsDatabase();
  try {
    await database.query(
      `insert into public.events (id, slug, title, starts_at, capacity, price_cents, currency)
       values ($1, 'analytics-event', 'Analytics Event', '2026-09-01T20:00:00Z', 2, 2500, 'USD')`,
      [IDS.event],
    );
    await database.query(
      `insert into public.event_audience_selections (id, event_id, name, status)
       values ($1, $3, 'First audience', 'draft'), ($2, $3, 'Second audience', 'draft')`,
      [IDS.selectionOne, IDS.selectionTwo, IDS.event],
    );
    await database.query(
      `insert into public.analytics_preview_results (selection_id, person_id, eligible)
       values ($1, $3, true), ($1, $4, true), ($2, $3, true), ($2, $5, false)`,
      [IDS.selectionOne, IDS.selectionTwo, IDS.personA, IDS.personB, IDS.personC],
    );
    await database.query(
      `insert into public.campaigns (id, event_id, name, channel, delivery_mode, status, created_at)
       values ($1, $3, 'Campaign one', 'email', 'dry_run', 'dry_run_completed', now()),
              ($2, $3, 'Campaign two', 'email', 'disabled', 'previewed', now() + interval '1 second')`,
      [IDS.campaignOne, IDS.campaignTwo, IDS.event],
    );
    await database.query(
      `insert into public.campaign_recipients (id, campaign_id, person_id)
       values (gen_random_uuid(), $1, $3), (gen_random_uuid(), $1, $4), (gen_random_uuid(), $2, $3)`,
      [IDS.campaignOne, IDS.campaignTwo, IDS.personA, IDS.personB],
    );
    await database.query(
      `insert into public.outbox_messages (id, campaign_id, status)
       values (gen_random_uuid(), $1, 'dry_run_completed'),
              (gen_random_uuid(), $1, 'blocked'),
              (gen_random_uuid(), $2, 'dry_run_completed')`,
      [IDS.campaignOne, IDS.campaignTwo],
    );
    await database.query(
      `insert into public.ticket_types (id, event_id, code, name, capacity, price_cents, currency)
       values ($1, $2, 'general', 'General', 2, 2500, 'USD')`,
      [IDS.ticket, IDS.event],
    );
    await database.query(
      `insert into public.registrations
         (id, event_id, person_id, payment_status, amount_cents, ticket_type_id, source)
       values
         ($1, $9, $5, 'paid', 2500, $10, 'social'),
         ($2, $9, $6, 'paid', 2500, $10, 'social'),
         ($3, $9, $7, 'pending', 2500, null, null),
         ($4, $9, null, 'paid', 3000, $8, 'referral')`,
      [
        IDS.registrationA,
        IDS.registrationB,
        IDS.registrationC,
        IDS.registrationUnlinked,
        IDS.personA,
        IDS.personB,
        IDS.personC,
        IDS.invalidTicket,
        IDS.event,
        IDS.ticket,
      ],
    );
    await database.query(
      `insert into public.registration_check_ins (event_id, registration_id, status)
       values ($1, $2, 'checked_in'), ($1, $3, 'checked_in')`,
      [IDS.event, IDS.registrationA, IDS.registrationUnlinked],
    );
    await database.query(
      `insert into public.matching_participant_profiles (id, event_id, status)
       values ($1, $4, 'active'), ($2, $4, 'active'), ($3, $4, 'inactive')`,
      [IDS.profileA, IDS.profileB, IDS.profileC, IDS.event],
    );
    await database.query(
      `insert into public.matching_likes (event_id, liker_profile_id)
       values ($1, $2), ($1, $3), ($1, $4)`,
      [IDS.event, IDS.profileA, IDS.profileB, IDS.profileC],
    );
    await database.query(
      `insert into public.matching_matches (event_id, profile_one_id, profile_two_id)
       values ($1, $2, $3)`,
      [IDS.event, IDS.profileA, IDS.profileB],
    );

    const result = await database.query("select * from public.get_event_analytics($1)", [IDS.event]);
    const analytics = parseEventAnalytics(result.rows[0]);
    assert.ok(analytics, JSON.stringify(result.rows[0]));
    assert.equal(analytics.activeSelectionCount, 2);
    assert.equal(analytics.eligiblePeople, 2);
    assert.equal(analytics.audienceLimitExceeded, false);
    assert.equal(analytics.campaignCount, 2);
    assert.equal(analytics.campaignRecipientCount, 3);
    assert.equal(analytics.campaignRecipientPeople, 2);
    assert.deepEqual(analytics.outboxStatuses, { blocked: 1, dry_run_completed: 2 });
    assert.equal(analytics.registrationCount, 4);
    assert.equal(analytics.registeredPeople, 3);
    assert.equal(analytics.paidRegistrationCount, 3);
    assert.equal(analytics.paidPeople, 2);
    assert.equal(analytics.paidRevenueCents, 8000);
    assert.equal(analytics.checkedInRegistrationCount, 2);
    assert.equal(analytics.checkedInPeople, 1);
    assert.equal(analytics.remainingCapacity, 0);
    assert.equal(analytics.oversoldBy, 1);
    assert.equal(analytics.matchingParticipantCount, 2);
    assert.equal(analytics.likedProfileCount, 3);
    assert.equal(analytics.likeCount, 3);
    assert.equal(analytics.matchCount, 1);
    assert.equal(analytics.matchedProfileCount, 2);

    const general = analytics.tickets.find((ticket) => ticket.ticketTypeId === IDS.ticket);
    assert.deepEqual(general, {
      ticketTypeId: IDS.ticket,
      code: "general",
      name: "General",
      capacity: 2,
      priceCents: 2500,
      currency: "USD",
      registrationCount: 2,
      paidCount: 2,
      checkedInCount: 1,
      paidRevenueCents: 5000,
    });
    const unassigned = analytics.tickets.find((ticket) => ticket.ticketTypeId === null);
    assert.equal(unassigned?.registrationCount, 2);
    assert.equal(unassigned?.paidCount, 1);
    assert.equal(unassigned?.checkedInCount, 1);
    assert.deepEqual(analytics.sources, [
      { source: "referral", registrationCount: 1, paidCount: 1, checkedInCount: 1 },
      { source: "social", registrationCount: 2, paidCount: 2, checkedInCount: 1 },
      { source: "unknown", registrationCount: 1, paidCount: 0, checkedInCount: 0 },
    ]);

    const missing = await database.query("select * from public.get_event_analytics($1)", [IDS.personA]);
    assert.equal(missing.rows.length, 0);
  } finally {
    await database.close();
  }
});

test("analytics RPC is invoker-only and unavailable to anonymous roles", async () => {
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", MIGRATION), "utf8");
  assert.match(sql, /security invoker[\s\S]*set search_path = ''/i);
  assert.doesNotMatch(sql, /security definer/i);
  assert.match(sql, /revoke execute on function public\.get_event_analytics\(uuid\)[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.get_event_analytics\(uuid\)[\s\S]*to service_role/i);
  assert.doesNotMatch(sql, /create table|create policy/i);
  assert.match(sql, /count\(distinct result\.person_id\)/i);
  assert.match(sql, /count\(distinct recipient\.person_id\)/i);

  const database = await analyticsDatabase();
  try {
    await assert.rejects(
      database.exec(`begin; set local role anon; select * from public.get_event_analytics('${IDS.event}'); rollback;`),
      /permission denied/i,
    );
    await database.exec("rollback;").catch(() => undefined);
  } finally {
    await database.close();
  }
});

test("analytics parser rejects malformed or unsafe database results", () => {
  assert.equal(parseEventAnalytics(null), null);
  assert.equal(parseEventAnalytics({ event_id: IDS.event }), null);
  assert.equal(parseEventAnalytics({
    event_id: IDS.event,
    event_slug: "event",
    event_title: "Event",
    starts_at: "not-a-date",
  }), null);
});
