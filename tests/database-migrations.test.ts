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
  "20260818195406_phase_2_segmentation.sql",
  "20260818195538_phase_3_check_in.sql",
  "20260818200000_phase_2_campaign_outbox.sql",
  "20260818201300_phase_4_matching.sql",
  "20260818201528_phase_5_crm.sql",
  "20260818204122_database_integrity_hardening.sql",
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

test("CRM RPCs audit suppression and keep follow-up tasks terminal", async () => {
  const database = await migratedDatabase();

  try {
    const personId = "00000000-0000-4000-8000-000000000301";
    const taskId = "00000000-0000-4000-8000-000000000302";
    await database.query(
      `insert into public.people (id, full_name, email, gender)
       values ($1, 'CRM Guest', 'crm@example.com', 'female')`,
      [personId],
    );
    await database.query(
      `insert into public.follow_up_tasks (id, person_id, title, created_by)
       values ($1, $2, 'Call guest', 'operator@example.com')`,
      [taskId, personId],
    );

    const suppressed = await database.query<{ set_person_suppression: boolean }>(
      "select public.set_person_suppression($1, $2, $3, $4)",
      [personId, "suppressed", "explicit request", "operator@example.com"],
    );
    assert.equal(suppressed.rows[0]?.set_person_suppression, true);

    const duplicate = await database.query<{ set_person_suppression: boolean }>(
      "select public.set_person_suppression($1, $2, $3, $4)",
      [personId, "suppressed", "duplicate request", "operator@example.com"],
    );
    assert.equal(duplicate.rows[0]?.set_person_suppression, false);

    const reactivated = await database.query<{ set_person_suppression: boolean }>(
      "select public.set_person_suppression($1, $2, $3, $4)",
      [personId, "active", "operator verified reactivation", "operator@example.com"],
    );
    assert.equal(reactivated.rows[0]?.set_person_suppression, true);

    const person = await database.query<{ suppression_status: string; suppression_reason: string | null }>(
      "select suppression_status, suppression_reason from public.people where id = $1",
      [personId],
    );
    assert.deepEqual(person.rows[0], { suppression_status: "active", suppression_reason: null });

    const suppressionEvents = await database.query<{
      previous_status: string;
      new_status: string;
      reason: string;
    }>(
      `select previous_status, new_status, reason
       from public.person_suppression_events
       where person_id = $1
       order by changed_at, id`,
      [personId],
    );
    assert.deepEqual(suppressionEvents.rows, [
      { previous_status: "active", new_status: "suppressed", reason: "explicit request" },
      { previous_status: "suppressed", new_status: "active", reason: "operator verified reactivation" },
    ]);

    const completed = await database.query<{ set_follow_up_task_status: boolean }>(
      "select public.set_follow_up_task_status($1, $2, $3)",
      [taskId, "completed", "operator@example.com"],
    );
    assert.equal(completed.rows[0]?.set_follow_up_task_status, true);

    const repeated = await database.query<{ set_follow_up_task_status: boolean }>(
      "select public.set_follow_up_task_status($1, $2, $3)",
      [taskId, "completed", "operator@example.com"],
    );
    assert.equal(repeated.rows[0]?.set_follow_up_task_status, false);

    await assert.rejects(
      database.query("select public.set_follow_up_task_status($1, $2, $3)", [
        taskId,
        "cancelled",
        "operator@example.com",
      ]),
      /follow_up_task_terminal/,
    );
  } finally {
    await database.close();
  }
});

test("database hardening enforces event scope, payment identity, private access, and immutable imports", async () => {
  const database = await migratedDatabase();

  try {
    const eventOne = "00000000-0000-4000-8000-000000000501";
    const eventTwo = "00000000-0000-4000-8000-000000000502";
    const ticketOne = "00000000-0000-4000-8000-000000000503";
    await database.query(
      `insert into public.events
         (id, slug, title, description, venue, starts_at, price_cents, currency, status)
       values
         ($1, 'integrity-one', 'Integrity One', '', 'Venue', now() + interval '1 day', 1000, 'USD', 'draft'),
         ($2, 'integrity-two', 'Integrity Two', '', 'Venue', now() + interval '1 day', 1000, 'USD', 'draft')`,
      [eventOne, eventTwo],
    );
    await database.query(
      `insert into public.ticket_types
         (id, event_id, code, name, price_cents, currency)
       values ($1, $2, 'general', 'General', 1000, 'USD')`,
      [ticketOne, eventOne],
    );

    await assert.rejects(
      database.query(
        `insert into public.registrations
           (event_id, ticket_type_id, full_name, email, amount_cents, currency)
         values ($1, $2, 'Wrong Event', 'wrong@example.com', 1000, 'USD')`,
        [eventTwo, ticketOne],
      ),
      /registrations_ticket_event_id_fkey/i,
    );

    await database.query(
      `insert into public.registrations
         (event_id, full_name, email, stripe_payment_intent_id, amount_cents, currency)
       values ($1, 'First Payment', 'first-payment@example.com', 'pi_test_unique', 1000, 'USD')`,
      [eventOne],
    );
    await assert.rejects(
      database.query(
        `insert into public.registrations
           (event_id, full_name, email, stripe_payment_intent_id, amount_cents, currency)
         values ($1, 'Duplicate Payment', 'second-payment@example.com', 'pi_test_unique', 1000, 'USD')`,
        [eventTwo],
      ),
      /registrations_stripe_payment_intent_unique_idx/i,
    );
    await assert.rejects(
      database.query(
        `insert into public.events
           (slug, title, description, venue, starts_at, price_cents, currency, status)
         values ('invalid-status', 'Invalid', '', 'Venue', now() + interval '1 day', 0, 'USD', 'active')`,
      ),
      /events_status_known_check/i,
    );

    const partialBatch = "00000000-0000-4000-8000-000000000510";
    await database.query(
      `insert into public.audience_import_batches
         (id, source_type, source_label, row_count, created_by)
       values ($1, 'csv', 'Partial batch', 2, 'operator@example.com')`,
      [partialBatch],
    );
    await database.query(
      `insert into public.audience_import_rows
         (batch_id, row_number, decision, preview_decision)
       values ($1, 1, 'invalid', 'invalid')`,
      [partialBatch],
    );
    await assert.rejects(
      database.query(
        `update public.audience_import_batches
         set status = 'committed', committed_at = now(), committed_by = 'operator@example.com'
         where id = $1`,
        [partialBatch],
      ),
      /import_batch_row_count_mismatch/i,
    );

    const committedBatch = "00000000-0000-4000-8000-000000000511";
    const committedRow = "00000000-0000-4000-8000-000000000512";
    await database.query(
      `insert into public.audience_import_batches
         (id, source_type, source_label, row_count, created_by)
       values ($1, 'csv', 'Committed batch', 1, 'operator@example.com')`,
      [committedBatch],
    );
    await database.query(
      `insert into public.audience_import_rows
         (id, batch_id, row_number, decision, preview_decision)
       values ($1, $2, 1, 'invalid', 'invalid')`,
      [committedRow, committedBatch],
    );
    await database.query(
      `update public.audience_import_batches
       set status = 'committed', committed_at = now(), committed_by = 'operator@example.com'
       where id = $1`,
      [committedBatch],
    );

    await assert.rejects(
      database.query("update public.audience_import_batches set source_label = 'Changed' where id = $1", [
        committedBatch,
      ]),
      /committed_import_batch_immutable/i,
    );
    await assert.rejects(
      database.query("delete from public.audience_import_rows where id = $1", [committedRow]),
      /committed_import_history_immutable/i,
    );

    const reviewBatch = "00000000-0000-4000-8000-000000000513";
    const reviewRow = "00000000-0000-4000-8000-000000000514";
    await database.query(
      `insert into public.audience_import_batches
         (id, source_type, source_label, row_count, created_by)
       values ($1, 'csv', 'Review batch', 1, 'operator@example.com')`,
      [reviewBatch],
    );
    await database.query(
      `insert into public.audience_import_rows
         (id, batch_id, row_number, normalized_data, decision, preview_decision)
       values ($1, $2, 1, '{"contacts": []}'::jsonb, 'review', 'review')`,
      [reviewRow, reviewBatch],
    );
    await database.query(
      `insert into public.identity_review_queue
         (import_batch_id, audience_import_row_id, incoming_row_number, conflict_type)
       values ($1, $2, 1, 'manual_review')`,
      [reviewBatch, reviewRow],
    );
    await database.query(
      "select public.resolve_audience_import_review($1, 'exclude', null, 'operator@example.com', 'explicit exclusion')",
      [reviewRow],
    );
    await assert.rejects(
      database.query(
        "update public.identity_review_queue set resolution_note = 'rewritten' where audience_import_row_id = $1",
        [reviewRow],
      ),
      /import_review_resolution_immutable/i,
    );

    const normalBatch = "00000000-0000-4000-8000-000000000515";
    const normalRow = "00000000-0000-4000-8000-000000000516";
    await database.query(
      `insert into public.audience_import_batches
         (id, source_type, source_label, row_count, created_by)
       values ($1, 'csv', 'Normal commit', 1, 'operator@example.com')`,
      [normalBatch],
    );
    await database.query(
      `insert into public.audience_import_rows
         (id, batch_id, row_number, normalized_data, decision, preview_decision)
       values (
         $1,
         $2,
         1,
         '{"fullName":"Imported Guest","email":"imported@example.com","phone":null,"gender":"female","city":null,"occupation":null,"education":null,"profileUrl":null,"source":"test","sourceReference":null,"contacts":[{"channel":"email","value":"imported@example.com","normalizedValue":"imported@example.com"}]}'::jsonb,
         'new_person',
         'new_person'
       )`,
      [normalRow, normalBatch],
    );
    const committed = await database.query<{ result: Record<string, unknown> }>(
      "select public.commit_audience_import($1, 'operator@example.com') as result",
      [normalBatch],
    );
    assert.equal(committed.rows[0]?.result.status, "committed");
    assert.equal(committed.rows[0]?.result.committed_rows, 1);

    const committedState = await database.query<{
      status: string;
      decision: string;
      committed_person_id: string | null;
    }>(
      `select batch.status, import_row.decision, import_row.committed_person_id
       from public.audience_import_batches as batch
       join public.audience_import_rows as import_row on import_row.batch_id = batch.id
       where batch.id = $1`,
      [normalBatch],
    );
    assert.equal(committedState.rows[0]?.status, "committed");
    assert.equal(committedState.rows[0]?.decision, "committed");
    assert.match(committedState.rows[0]?.committed_person_id ?? "", /^[0-9a-f-]{36}$/i);

    await database.exec("set role anon;");
    await assert.rejects(database.query("select id from public.people limit 1"), /permission denied/i);
    await database.exec("reset role;");
  } finally {
    await database.close();
  }
});
