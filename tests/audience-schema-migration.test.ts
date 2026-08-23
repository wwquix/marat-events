import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/20260823130603_finish_phase_2_audience_schema.sql", import.meta.url),
  "utf8",
);

test("audience identity states preserve existing literals and add merge outcomes", () => {
  assert.match(
    migration,
    /identity_status in \('resolved', 'review_required', 'merged', 'rejected'\)/,
  );
  assert.doesNotMatch(migration, /alter column identity_status set default/);
});

test("person merges reject self references and merge chains", () => {
  assert.match(migration, /people_no_self_merge_check/);
  assert.match(migration, /if target_status = 'merged'/);
  assert.match(migration, /where person\.merged_into_person_id = new\.id/);
  assert.match(migration, /create trigger people_merge_target_invariant/);
});

test("trusted email and phone ownership fails closed before the unique index", () => {
  const precheckPosition = migration.indexOf("Trusted audience identifiers have conflicting owners.");
  const uniqueIndexPosition = migration.indexOf("person_contacts_trusted_identifier_owner_unique_idx");

  assert.ok(precheckPosition >= 0);
  assert.ok(uniqueIndexPosition > precheckPosition);
  assert.match(migration, /where channel in \('email', 'phone'\)/);
  assert.match(migration, /detail = conflicts::text/);
});

test("committed file fingerprints and SQL commit are idempotent and server-only", () => {
  assert.match(migration, /audience_import_batches_committed_file_sha256_unique_idx/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /import_planned_identifiers/);
  assert.match(migration, /assigns one trusted identifier to multiple planned rows/);
  assert.match(migration, /create function public\.commit_audience_import/);
  assert.match(migration, /security invoker/);
  assert.match(
    migration,
    /revoke all on function public\.commit_audience_import\(uuid\) from public, anon, authenticated/,
  );
  assert.match(migration, /grant execute on function public\.commit_audience_import\(uuid\) to service_role/);
});
