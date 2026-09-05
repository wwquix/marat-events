import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { normalizeCheckInToken } from "../lib/checkin/token";
import {
  canonicalMatchingPair,
  decideMatchingAccess,
  decideMatchingLike,
} from "../lib/matching/policy";
import { parseMatchingParticipantState } from "../lib/matching/state";
import {
  generateMatchingToken,
  hashMatchingToken,
  isMatchingToken,
  matchingParticipantPath,
  normalizeMatchingToken,
} from "../lib/matching/token";

const MIGRATION = "20260818201300_phase_4_matching.sql";
const NOW = new Date("2026-08-18T20:00:00.000Z");

const IDS = {
  eventOne: "00000000-0000-4000-8000-000000000401",
  eventTwo: "00000000-0000-4000-8000-000000000402",
  registrationA: "00000000-0000-4000-8000-000000000411",
  registrationB: "00000000-0000-4000-8000-000000000412",
  registrationC: "00000000-0000-4000-8000-000000000413",
  registrationPending: "00000000-0000-4000-8000-000000000414",
  registrationNotCheckedIn: "00000000-0000-4000-8000-000000000415",
} as const;

async function matchingDatabase(): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;

    create table public.events (
      id uuid primary key,
      title text not null,
      starts_at timestamptz not null
    );

    create table public.registrations (
      id uuid primary key,
      event_id uuid not null references public.events(id) on delete cascade,
      payment_status text not null,
      unique (id, event_id)
    );

    create table public.registration_check_ins (
      id uuid primary key default gen_random_uuid(),
      registration_id uuid not null,
      event_id uuid not null,
      status text not null,
      foreign key (registration_id, event_id)
        references public.registrations(id, event_id)
        on delete cascade
    );

    grant select on table public.events to service_role;
    grant select, update on table public.registrations to service_role;
    grant select on table public.registration_check_ins to service_role;
  `);
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", MIGRATION), "utf8");
  await database.exec(sql);
  return database;
}

async function issueToken(
  database: PGlite,
  eventId: string,
  registrationId: string,
  tokenHash: string,
): Promise<string> {
  const result = await database.query<{ token_id: string }>(
    "select * from public.issue_matching_participant_token($1, $2, $3, $4, null)",
    [eventId, registrationId, tokenHash, "operator@example.com"],
  );
  const tokenId = result.rows[0]?.token_id;
  assert.match(tokenId ?? "", /^[0-9a-f-]{36}$/i);
  return tokenId;
}

async function activate(
  database: PGlite,
  tokenHash: string,
  displayName: string,
): Promise<string> {
  const result = await database.query<{ profile_public_id: string }>(
    "select * from public.activate_matching_participant($1, $2, $3)",
    [tokenHash, displayName, `${displayName} bio`],
  );
  const publicId = result.rows[0]?.profile_public_id;
  assert.match(publicId ?? "", /^[0-9a-f-]{36}$/i);
  return publicId;
}

async function participantState(database: PGlite, tokenHash: string): Promise<Record<string, unknown>> {
  const result = await database.query<{ state: Record<string, unknown> }>(
    "select public.get_matching_participant_state($1) as state",
    [tokenHash],
  );
  const state = result.rows[0]?.state;
  assert.ok(state);
  return state;
}

test("matching bearer tokens are separate, opaque, random, and hash-only", () => {
  const tokens = Array.from({ length: 32 }, () => generateMatchingToken());
  assert.equal(new Set(tokens).size, tokens.length);

  for (const token of tokens) {
    assert.equal(isMatchingToken(token), true);
    assert.match(token, /^mt_[A-Za-z0-9_-]{43}$/);
    assert.equal(normalizeCheckInToken(token), null);
    assert.equal(normalizeMatchingToken(token), token);
    assert.equal(normalizeMatchingToken(`https://events.example.test${matchingParticipantPath(token)}`), token);

    const hash = hashMatchingToken(token);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash.includes(token), false);
  }
});

test("matching policy fails closed and canonicalizes pairs deterministically", () => {
  const valid = {
    tokenFound: true,
    tokenStatus: "active" as const,
    expiresAt: new Date("2026-08-19T20:00:00.000Z"),
    paymentStatus: "paid",
    checkedIn: true,
  };

  assert.equal(decideMatchingAccess({ ...valid, tokenFound: false }, NOW), "invalid_token");
  assert.equal(decideMatchingAccess({ ...valid, tokenStatus: "revoked" }, NOW), "revoked");
  assert.equal(decideMatchingAccess({ ...valid, expiresAt: NOW }, NOW), "expired");
  assert.equal(decideMatchingAccess({ ...valid, paymentStatus: "pending" }, NOW), "unpaid");
  assert.equal(decideMatchingAccess({ ...valid, checkedIn: false }, NOW), "not_checked_in");
  assert.equal(decideMatchingAccess(valid, NOW), "valid");

  const pair = canonicalMatchingPair("profile-b", "profile-a");
  assert.deepEqual(pair, ["profile-a", "profile-b"]);
  assert.throws(() => canonicalMatchingPair("same", "same"));

  const like = {
    sourceProfileId: "profile-a",
    sourceEventId: "event-a",
    targetProfileId: "profile-b",
    targetEventId: "event-a",
    targetActive: true,
    reverseLikeExists: false,
  };
  assert.equal(decideMatchingLike(like), "liked");
  assert.equal(decideMatchingLike({ ...like, reverseLikeExists: true }), "matched");
  assert.equal(decideMatchingLike({ ...like, targetActive: false }), "target_unavailable");
  assert.equal(decideMatchingLike({ ...like, targetEventId: "event-b" }), "cross_event");
  assert.equal(decideMatchingLike({ ...like, targetProfileId: "profile-a" }), "self_like");
});

test("participant state parser drops untrusted one-sided and contact fields", () => {
  const raw = {
    event: { id: IDS.eventOne, title: "Event", startsAt: "2026-09-01T20:00:00.000Z" },
    profile: {
      publicId: "00000000-0000-4000-8000-000000000421",
      displayName: "Alice",
      bio: null,
      activatedAt: "2026-09-01T20:00:00.000Z",
      registrationId: IDS.registrationA,
      email: "alice@example.com",
    },
    candidates: [{
      publicId: "00000000-0000-4000-8000-000000000422",
      displayName: "Bob",
      bio: null,
      likedByMe: false,
      inboundLike: true,
      likerCount: 1,
      phone: "+1 212 555 0100",
    }],
    matches: [],
    inboundLikes: [{ publicId: "00000000-0000-4000-8000-000000000422" }],
  };

  const parsed = parseMatchingParticipantState(raw);
  assert.ok(parsed);
  const serialized = JSON.stringify(parsed);
  assert.doesNotMatch(serialized, /inbound|likerCount|registrationId|alice@example|phone/i);
  assert.equal(parsed.candidates[0]?.likedByMe, false);
});

test("matching RPCs enforce eligibility, privacy, event scope, idempotency, and race-safe mutual matches", async () => {
  const database = await matchingDatabase();

  try {
    await database.query(
      `insert into public.events (id, title, starts_at)
       values ($1, 'Event One', now() + interval '1 day'),
              ($2, 'Event Two', now() + interval '1 day')`,
      [IDS.eventOne, IDS.eventTwo],
    );
    await database.query(
      `insert into public.registrations (id, event_id, payment_status)
       values ($1, $6, 'paid'),
              ($2, $6, 'paid'),
              ($3, $7, 'paid'),
              ($4, $6, 'pending'),
              ($5, $6, 'paid')`,
      [
        IDS.registrationA,
        IDS.registrationB,
        IDS.registrationC,
        IDS.registrationPending,
        IDS.registrationNotCheckedIn,
        IDS.eventOne,
        IDS.eventTwo,
      ],
    );
    await database.query(
      `insert into public.registration_check_ins (registration_id, event_id, status)
       values ($1, $5, 'checked_in'),
              ($2, $5, 'checked_in'),
              ($3, $6, 'checked_in'),
              ($4, $5, 'checked_in')`,
      [IDS.registrationA, IDS.registrationB, IDS.registrationC, IDS.registrationPending, IDS.eventOne, IDS.eventTwo],
    );

    await database.exec("set role service_role;");

    await assert.rejects(
      issueToken(database, IDS.eventOne, IDS.registrationPending, "d".repeat(64)),
      /matching_registration_not_paid/,
    );
    await assert.rejects(
      issueToken(database, IDS.eventOne, IDS.registrationNotCheckedIn, "e".repeat(64)),
      /matching_registration_not_checked_in/,
    );

    const hashes = { a: "a".repeat(64), b: "b".repeat(64), c: "c".repeat(64) };
    const tokenA = await issueToken(database, IDS.eventOne, IDS.registrationA, hashes.a);
    const tokenB = await issueToken(database, IDS.eventOne, IDS.registrationB, hashes.b);
    await issueToken(database, IDS.eventTwo, IDS.registrationC, hashes.c);

    const publicA = await activate(database, hashes.a, "Alice");
    const publicB = await activate(database, hashes.b, "Bob");
    const publicC = await activate(database, hashes.c, "Carla");
    assert.equal(await activate(database, hashes.a, "Alice"), publicA);

    const initialStateA = await participantState(database, hashes.a);
    const initialCandidates = initialStateA.candidates as Array<Record<string, unknown>>;
    assert.deepEqual(initialCandidates.map((candidate) => candidate.publicId), [publicB]);
    assert.equal(JSON.stringify(initialStateA).includes(publicC), false);

    const firstLike = await database.query<{ outcome: string }>(
      "select * from public.record_matching_like($1, $2)",
      [hashes.a, publicB],
    );
    assert.equal(firstLike.rows[0]?.outcome, "liked");

    const stateBWithIncomingLike = await participantState(database, hashes.b);
    const candidateA = (stateBWithIncomingLike.candidates as Array<Record<string, unknown>>)[0];
    assert.equal(candidateA?.publicId, publicA);
    assert.equal(candidateA?.likedByMe, false);
    assert.deepEqual(stateBWithIncomingLike.matches, []);

    const duplicateLike = await database.query<{ outcome: string }>(
      "select * from public.record_matching_like($1, $2)",
      [hashes.a, publicB],
    );
    assert.equal(duplicateLike.rows[0]?.outcome, "liked");
    const oneLike = await database.query<{ count: number }>(
      "select count(*)::integer as count from public.matching_likes",
    );
    assert.equal(oneLike.rows[0]?.count, 1);

    await assert.rejects(
      database.query("select * from public.record_matching_like($1, $2)", [hashes.a, publicA]),
      /matching_self_like/,
    );
    await assert.rejects(
      database.query("select * from public.record_matching_like($1, $2)", [hashes.a, publicC]),
      /matching_cross_event_like/,
    );

    await database.exec("reset role; delete from public.matching_likes; delete from public.matching_matches; set role service_role;");
    const oppositeLikes = await Promise.all([
      database.query<{ outcome: string }>("select * from public.record_matching_like($1, $2)", [hashes.a, publicB]),
      database.query<{ outcome: string }>("select * from public.record_matching_like($1, $2)", [hashes.b, publicA]),
    ]);
    assert.deepEqual(oppositeLikes.map((result) => result.rows[0]?.outcome).sort(), ["liked", "matched"]);

    const storedMatch = await database.query<{
      count: number;
      canonical: boolean;
      notification_status: string;
    }>(
      `select count(*)::integer as count,
              bool_and(profile_one_id < profile_two_id) as canonical,
              min(notification_status) as notification_status
       from public.matching_matches`,
    );
    assert.equal(storedMatch.rows[0]?.count, 1);
    assert.equal(storedMatch.rows[0]?.canonical, true);
    assert.equal(storedMatch.rows[0]?.notification_status, "pending");

    const mutualStateA = await participantState(database, hashes.a);
    const mutualMatches = mutualStateA.matches as Array<Record<string, unknown>>;
    assert.equal(mutualMatches.length, 1);
    assert.equal(mutualMatches[0]?.participantPublicId, publicB);

    const profileIds = await database.query<{ public_id: string; id: string; event_id: string }>(
      "select public_id, id, event_id from public.matching_participant_profiles order by public_id",
    );
    const profileA = profileIds.rows.find((row) => row.public_id === publicA);
    const profileC = profileIds.rows.find((row) => row.public_id === publicC);
    assert.ok(profileA && profileC);
    await assert.rejects(
      database.query(
        `insert into public.matching_likes (event_id, liker_profile_id, liked_profile_id)
         values ($1, $2, $3)`,
        [IDS.eventOne, profileA.id, profileC.id],
      ),
      /foreign key|violates/i,
    );
    await assert.rejects(
      database.query(
        `insert into public.matching_likes (event_id, liker_profile_id, liked_profile_id)
         values ($1, $2, $2)`,
        [IDS.eventOne, profileA.id],
      ),
      /check constraint|violates/i,
    );

    const revoked = await database.query<{ revoke_matching_participant_token: boolean }>(
      "select public.revoke_matching_participant_token($1, $2, $3, $4)",
      [IDS.eventOne, tokenB, "operator@example.com", "test_revoke"],
    );
    assert.equal(revoked.rows[0]?.revoke_matching_participant_token, true);
    await assert.rejects(participantState(database, hashes.b), /matching_token_revoked/);

    const stateAfterRevocation = await participantState(database, hashes.a);
    assert.deepEqual(stateAfterRevocation.candidates, []);
    assert.deepEqual(stateAfterRevocation.matches, []);

    await database.query(
      `update public.matching_participant_tokens
       set issued_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
       where token_hash = $1`,
      [hashes.c],
    );
    await assert.rejects(participantState(database, hashes.c), /matching_token_expired/);

    const storedTokens = await database.query<{ token_hash: string }>(
      "select token_hash from public.matching_participant_tokens order by token_hash",
    );
    assert.ok(storedTokens.rows.every((row) => /^[0-9a-f]{64}$/.test(row.token_hash)));
    assert.equal(JSON.stringify(storedTokens.rows).includes("mt_"), false);

    await database.exec("reset role;");
    await assert.rejects(
      database.exec("begin; set local role anon; select * from public.matching_participant_profiles; rollback;"),
      /permission denied|row-level security/i,
    );
    await database.exec("rollback;").catch(() => undefined);
    await assert.rejects(
      database.exec(`begin; set local role anon; select public.get_matching_participant_state('${hashes.a}'); rollback;`),
      /permission denied/i,
    );
    await database.exec("rollback;").catch(() => undefined);

    assert.match(tokenA, /^[0-9a-f-]{36}$/i);
  } finally {
    await database.close();
  }
});

test("matching migration and admin actions keep privileged access closed", () => {
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", MIGRATION), "utf8");
  const adminActions = readFileSync(
    path.join(process.cwd(), "app", "admin", "(protected)", "matching", "actions.ts"),
    "utf8",
  );
  const publicActions = readFileSync(
    path.join(process.cwd(), "app", "match", "[token]", "actions.ts"),
    "utf8",
  );
  const publicPage = readFileSync(path.join(process.cwd(), "app", "match", "[token]", "page.tsx"), "utf8");

  for (const table of [
    "matching_participant_tokens",
    "matching_participant_profiles",
    "matching_likes",
    "matching_matches",
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, "i"));
  }

  assert.doesNotMatch(sql, /create policy/i);
  assert.doesNotMatch(sql, /security definer/i);
  assert.ok((sql.match(/security invoker/gi) ?? []).length >= 6);
  assert.ok((sql.match(/set search_path = ''/gi) ?? []).length >= 6);
  assert.match(sql, /foreign key \(liker_profile_id, event_id\)[\s\S]*references public\.matching_participant_profiles\(id, event_id\)/i);
  assert.match(sql, /foreign key \(liked_profile_id, event_id\)[\s\S]*references public\.matching_participant_profiles\(id, event_id\)/i);
  assert.match(sql, /check \(liker_profile_id <> liked_profile_id\)/i);
  assert.match(sql, /check \(profile_one_id < profile_two_id\)/i);
  assert.match(sql, /unique \(event_id, profile_one_id, profile_two_id\)/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /on conflict \(event_id, liker_profile_id, liked_profile_id\) do nothing/i);
  assert.match(sql, /create trigger matching_matches_mutual_likes_trigger/i);
  assert.match(sql, /matching_match_requires_mutual_likes/i);
  assert.match(sql, /notification_status text not null default 'pending'/i);
  assert.match(sql, /grant execute on function public\.record_matching_like\(text, uuid\)[\s\S]*to service_role/i);

  const stateFunction = sql.slice(sql.indexOf("create or replace function public.get_matching_participant_state"));
  assert.match(stateFunction, /own_like\.liker_profile_id = selected_profile\.id/i);
  assert.doesNotMatch(stateFunction, /own_like\.liked_profile_id = selected_profile\.id/i);

  const exportedAdminActions = adminActions.match(/export async function \w+Action/g) ?? [];
  const sessionChecks = adminActions.match(/await requireAdminSession\(\)/g) ?? [];
  assert.equal(exportedAdminActions.length, 2);
  assert.equal(sessionChecks.length, exportedAdminActions.length);

  assert.doesNotMatch(publicActions, /NEXT_PUBLIC_|console\.(?:log|info|debug)/i);
  assert.ok(publicActions.indexOf("hashMatchingToken(token)") < publicActions.indexOf("createSupabaseServerClient()"));
  assert.doesNotMatch(publicPage, /\.from\("matching_likes"\)|registration_id|email|phone|liker_count/i);
});
