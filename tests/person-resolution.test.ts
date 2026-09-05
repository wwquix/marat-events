import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseResolvedPersonId } from "../lib/checkout/person";

const MIGRATION_PATH = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260818193000_phase_2_identity_integrity.sql",
);
const migrationSql = readFileSync(MIGRATION_PATH, "utf8");
const functionSql = migrationSql.slice(
  migrationSql.indexOf("create or replace function public.resolve_registration_person"),
  migrationSql.indexOf("revoke execute on function public.resolve_registration_person"),
);

test("accepts only a well-formed UUID from registration-person resolution", () => {
  const personId = "00000000-0000-4000-8000-000000000001";

  assert.equal(parseResolvedPersonId(personId), personId);
  assert.equal(parseResolvedPersonId("not-a-uuid"), null);
  assert.equal(parseResolvedPersonId({ id: personId }), null);
  assert.equal(parseResolvedPersonId(null), null);
});

test("identity resolution uses one transaction lock shared with audience import commit", () => {
  const importMigration = readFileSync(
    path.join(
      process.cwd(),
      "supabase",
      "migrations",
      "20260815063744_phase_2_import_review_commit.sql",
    ),
    "utf8",
  );
  const lockKey = "hashtextextended('marat_audience_import_commit', 0)";

  assert.ok(functionSql.includes(lockKey));
  assert.ok(importMigration.includes(lockKey));
  assert.match(functionSql, /pg_advisory_xact_lock/i);
  assert.match(functionSql, /security invoker[\s\S]*set search_path = ''/i);
});

test("identity resolution considers primary fields and contact rows", () => {
  assert.match(functionSql, /from public\.people as person[\s\S]*person\.email/i);
  assert.match(functionSql, /from public\.people as person[\s\S]*person\.phone/i);
  assert.match(
    functionSql,
    /from public\.person_contacts as contact[\s\S]*contact\.channel = 'email'/i,
  );
  assert.match(
    functionSql,
    /from public\.person_contacts as contact[\s\S]*contact\.channel = 'phone'/i,
  );
});

test("same-owner identifiers collapse while ambiguous or cross-owner identifiers fail closed", () => {
  assert.match(functionSql, /array_agg\(distinct identity\.person_id/i);
  assert.match(functionSql, /cardinality\(matched_person_ids\) > 1/i);
  assert.match(functionSql, /message = 'ambiguous_registration_identity'/i);
  assert.match(functionSql, /cardinality\(matched_person_ids\) = 1/i);
  assert.match(functionSql, /resolved_person_id := matched_person_ids\[1\]/i);
});

test("existing people are never overwritten by unauthenticated checkout identity input", () => {
  assert.doesNotMatch(functionSql, /update\s+public\.people/i);
  assert.match(
    functionSql,
    /if[\s\S]*cardinality\(matched_person_ids\) = 1[\s\S]*else[\s\S]*insert into public\.people/i,
  );
  assert.match(functionSql, /source[\s\S]*'registration_checkout'/i);
});

test("resolution synchronizes missing contacts without inventing consent or contactability", () => {
  assert.match(functionSql, /insert into public\.person_contacts/i);
  assert.match(functionSql, /'email'[\s\S]*normalized_email/i);
  assert.match(functionSql, /'phone'[\s\S]*normalized_phone/i);
  assert.match(functionSql, /consent_status[\s\S]*'unknown'/i);
  assert.match(functionSql, /contactability_status[\s\S]*'unknown'/i);
  assert.match(
    functionSql,
    /on conflict \(person_id, channel, normalized_value\) do nothing/i,
  );
  assert.doesNotMatch(migrationSql, /create\s+unique\s+index[\s\S]{0,160}phone/i);
});

test("migration backfills canonical email and phone contacts idempotently", () => {
  assert.match(migrationSql, /'identity_integrity_backfill'/i);
  assert.match(migrationSql, /lower\(trim\(person\.email\)\)/i);
  assert.match(
    migrationSql,
    /regexp_replace\(person\.phone, '\[\^0-9\]', '', 'g'\)/i,
  );
  assert.equal(
    migrationSql.match(/on conflict \(person_id, channel, normalized_value\) do nothing/gi)
      ?.length,
    3,
  );
});

test("registration-person RPC is executable only by the service role", () => {
  assert.match(
    migrationSql,
    /revoke execute on function public\.resolve_registration_person\(text, text, text, text\) from public/i,
  );
  assert.match(
    migrationSql,
    /revoke execute on function public\.resolve_registration_person\(text, text, text, text\) from anon/i,
  );
  assert.match(
    migrationSql,
    /revoke execute on function public\.resolve_registration_person\(text, text, text, text\) from authenticated/i,
  );
  assert.match(
    migrationSql,
    /grant execute on function public\.resolve_registration_person\(text, text, text, text\) to service_role/i,
  );
});

test("checkout uses the atomic RPC and fails closed on malformed results", () => {
  const checkoutRoute = readFileSync(
    path.join(process.cwd(), "app", "api", "checkout", "route.ts"),
    "utf8",
  );

  assert.match(checkoutRoute, /supabase\.rpc\("resolve_registration_person"/);
  assert.match(checkoutRoute, /parseResolvedPersonId\(personData\)/);
  assert.match(checkoutRoute, /if \(!personId\)[\s\S]*redirectToEvent\(request, slug, "database"\)/);
  assert.doesNotMatch(checkoutRoute, /\.from\("people"\)[\s\S]{0,120}\.insert/);
  assert.doesNotMatch(checkoutRoute, /resolvePersonIdentity/);
});

test("audience preview indexes both primary phone and contact phone identities", () => {
  const actions = readFileSync(
    path.join(
      process.cwd(),
      "app",
      "admin",
      "(protected)",
      "audience",
      "import",
      "actions.ts",
    ),
    "utf8",
  );

  assert.match(actions, /\.select\("id,email,phone"\)/);
  assert.match(actions, /person\.phone\?\.replace\(\/\\D\/g, ""\)/);
  assert.match(actions, /identityKey\("phone", normalizedPhone\)/);
  assert.match(actions, /contact\.normalized_value\.replace\(\/\\D\/g, ""\)/);
});
