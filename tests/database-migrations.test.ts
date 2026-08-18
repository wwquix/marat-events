import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

const CORE_MIGRATIONS = [
  "20260814000000_initial_events.sql",
  "20260814203000_phase_1_registration_core.sql",
  "20260814212500_registration_identity_snapshots.sql",
  "20260815053500_phase_2_audience_schema.sql",
  "20260815055000_phase_2_import_preview.sql",
  "20260815063744_phase_2_import_review_commit.sql",
  "20260818193000_phase_2_identity_integrity.sql",
  "20260818195538_phase_3_check_in.sql",
] as const;

async function migratedDatabase(): Promise<PGlite> {
  const database = new PGlite();
  await database.exec("create role anon; create role authenticated; create role service_role;");

  for (const migration of CORE_MIGRATIONS) {
    const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", migration), "utf8");
    await database.exec(sql);
  }

  return database;
}

test("core migrations execute and canonical identity RPC fails closed on cross-owner input", async () => {
  const database = await migratedDatabase();

  try {
    const firstPerson = "00000000-0000-4000-8000-000000000101";
    const secondPerson = "00000000-0000-4000-8000-000000000102";
    await database.query(
      `insert into public.people (id, full_name, email, phone, gender)
       values ($1, 'Original Name', 'owner@example.com', '+1 212 555 0101', 'female'),
              ($2, 'Other Person', 'other@example.com', '+1 212 555 0102', 'male')`,
      [firstPerson, secondPerson],
    );
    await database.query(
      `insert into public.person_contacts
         (person_id, channel, value, normalized_value, consent_status, contactability_status)
       values
         ($1, 'email', 'owner@example.com', 'owner@example.com', 'unknown', 'unknown'),
         ($1, 'phone', '+1 212 555 0101', '12125550101', 'unknown', 'unknown'),
         ($2, 'email', 'other@example.com', 'other@example.com', 'unknown', 'unknown'),
         ($2, 'phone', '+1 212 555 0102', '12125550102', 'unknown', 'unknown')`,
      [firstPerson, secondPerson],
    );

    const sameOwner = await database.query<{ resolve_registration_person: string }>(
      "select public.resolve_registration_person($1, $2, $3, $4)",
      ["Untrusted Replacement", "owner@example.com", "+1 212 555 0101", "female"],
    );
    assert.equal(sameOwner.rows[0]?.resolve_registration_person, firstPerson);

    const original = await database.query<{ full_name: string }>(
      "select full_name from public.people where id = $1",
      [firstPerson],
    );
    assert.equal(original.rows[0]?.full_name, "Original Name");

    await assert.rejects(
      database.query("select public.resolve_registration_person($1, $2, $3, $4)", [
        "Conflicting Input",
        "owner@example.com",
        "+1 212 555 0102",
        "female",
      ]),
      /ambiguous_registration_identity/,
    );

    const created = await database.query<{ resolve_registration_person: string }>(
      "select public.resolve_registration_person($1, $2, $3, $4)",
      ["New Guest", "new@example.com", "+1 212 555 0199", "female"],
    );
    const createdPersonId = created.rows[0]?.resolve_registration_person;
    assert.match(createdPersonId ?? "", /^[0-9a-f-]{36}$/i);

    const contacts = await database.query<{ consent_status: string; contactability_status: string }>(
      `select consent_status, contactability_status
       from public.person_contacts
       where person_id = $1
       order by channel`,
      [createdPersonId],
    );
    assert.equal(contacts.rows.length, 2);
    assert.ok(contacts.rows.every((row) => row.consent_status === "unknown"));
    assert.ok(contacts.rows.every((row) => row.contactability_status === "unknown"));
  } finally {
    await database.close();
  }
});

test("check-in RPCs enforce payment, event scope, revocation, and duplicate safety", async () => {
  const database = await migratedDatabase();

  try {
    const eventOne = "00000000-0000-4000-8000-000000000201";
    const eventTwo = "00000000-0000-4000-8000-000000000202";
    const paidRegistration = "00000000-0000-4000-8000-000000000211";
    const manualRegistration = "00000000-0000-4000-8000-000000000212";
    const pendingRegistration = "00000000-0000-4000-8000-000000000213";

    await database.query(
      `insert into public.events
         (id, slug, title, description, venue, starts_at, price_cents, currency, status)
       values
         ($1, 'check-in-one', 'Check-in One', '', 'Venue', '2026-09-01T20:00:00Z', 1000, 'USD', 'published'),
         ($2, 'check-in-two', 'Check-in Two', '', 'Venue', '2026-09-02T20:00:00Z', 1000, 'USD', 'published')`,
      [eventOne, eventTwo],
    );
    await database.query(
      `insert into public.registrations
         (id, event_id, full_name, email, amount_cents, currency, payment_status, paid_at)
       values
         ($1, $4, 'Paid Guest', 'paid@example.com', 1000, 'USD', 'paid', now()),
         ($2, $4, 'Manual Guest', 'manual@example.com', 1000, 'USD', 'paid', now()),
         ($3, $4, 'Pending Guest', 'pending@example.com', 1000, 'USD', 'pending', null)`,
      [paidRegistration, manualRegistration, pendingRegistration, eventOne],
    );

    const firstHash = "a".repeat(64);
    const secondHash = "b".repeat(64);
    await database.query(
      "select * from public.issue_registration_check_in_token($1, $2, $3, null)",
      [paidRegistration, firstHash, "operator@example.com"],
    );

    const checked = await database.query<{ outcome: string }>(
      "select * from public.process_registration_check_in($1, $2, $3)",
      [eventOne, firstHash, "operator@example.com"],
    );
    assert.equal(checked.rows[0]?.outcome, "checked_in");

    const duplicate = await database.query<{ outcome: string }>(
      "select * from public.process_registration_check_in($1, $2, $3)",
      [eventOne, firstHash, "operator@example.com"],
    );
    assert.equal(duplicate.rows[0]?.outcome, "already_checked_in");

    const reissued = await database.query<{ token_id: string }>(
      "select * from public.issue_registration_check_in_token($1, $2, $3, null)",
      [paidRegistration, secondHash, "operator@example.com"],
    );
    const wrongEvent = await database.query<{ outcome: string }>(
      "select * from public.process_registration_check_in($1, $2, $3)",
      [eventTwo, secondHash, "operator@example.com"],
    );
    assert.equal(wrongEvent.rows[0]?.outcome, "wrong_event");

    await database.query(
      "select public.revoke_registration_check_in_token($1, $2, $3)",
      [reissued.rows[0]?.token_id, "operator@example.com", "test_revoke"],
    );
    const revoked = await database.query<{ outcome: string }>(
      "select * from public.process_registration_check_in($1, $2, $3)",
      [eventOne, secondHash, "operator@example.com"],
    );
    assert.equal(revoked.rows[0]?.outcome, "revoked");

    const manual = await database.query<{ outcome: string }>(
      "select * from public.manual_registration_check_in($1, $2, $3)",
      [eventOne, manualRegistration, "operator@example.com"],
    );
    assert.equal(manual.rows[0]?.outcome, "checked_in");

    await assert.rejects(
      database.query("select * from public.issue_registration_check_in_token($1, $2, $3, null)", [
        pendingRegistration,
        "c".repeat(64),
        "operator@example.com",
      ]),
      /registration_not_paid/,
    );

    const activeCheckIns = await database.query<{ count: number }>(
      "select count(*)::integer as count from public.registration_check_ins where status = 'checked_in'",
    );
    assert.equal(activeCheckIns.rows[0]?.count, 2);

    const attempts = await database.query<{ count: number }>(
      "select count(*)::integer as count from public.check_in_attempts",
    );
    assert.equal(attempts.rows[0]?.count, 5);
  } finally {
    await database.close();
  }
});
