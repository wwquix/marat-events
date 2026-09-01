import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { outboundDecisionLabel, parseOutboundPolicyResult } from "../lib/outbound/policy";

const EVENT_ID = "10000000-0000-4000-8000-000000000010";
const SEGMENT_ID = "10000000-0000-4000-8000-000000000011";
const CAMPAIGN_ID = "10000000-0000-4000-8000-000000000012";
const ELIGIBLE_PERSON = "20000000-0000-4000-8000-000000000010";
const BLOCKED_PERSON = "20000000-0000-4000-8000-000000000011";
const SUPPRESSED_PERSON = "20000000-0000-4000-8000-000000000012";
const OPTED_OUT_PERSON = "20000000-0000-4000-8000-000000000013";
const UNKNOWN_CONTACTABILITY_PERSON = "20000000-0000-4000-8000-000000000014";
const UNREACHABLE_PERSON = "20000000-0000-4000-8000-000000000015";
const INELIGIBLE_PERSON = "20000000-0000-4000-8000-000000000016";

async function database() {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  const dir = path.join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(path.join(dir, file), "utf8"));
  }
  return db;
}

async function seed(db: PGlite) {
  await db.query(`insert into public.events(id,slug,title,description,venue,starts_at,capacity,price_cents,currency,status) values($1,'outbound-test','Outbound Test','Test','Test','2026-09-01T16:00:00Z',100,100,'USD','published')`, [EVENT_ID]);
  await db.query(`insert into public.audience_segments(id,name,filter_definition,created_by,updated_by) values($1,'Outbound', '{"version":"1"}', 'admin@example.com','admin@example.com')`, [SEGMENT_ID]);
  await db.query(`insert into public.invitation_campaigns(id,event_id,segment_id,name,target_channel,segment_name_snapshot,filter_version,filter_snapshot,created_by) values($1,$2,$3,'Outbound','email','Outbound',1,'{"version":"1"}','admin@example.com')`, [CAMPAIGN_ID, EVENT_ID, SEGMENT_ID]);
  for (const [id, name, consent] of [[ELIGIBLE_PERSON, "Eligible", "opted_in"], [BLOCKED_PERSON, "Blocked", "unknown"]]) {
    await db.query("insert into public.people(id,full_name,suppression_status,identity_status) values($1,$2,'active','resolved')", [id, name]);
    await db.query("insert into public.person_contacts(person_id,channel,value,normalized_value,is_primary,consent_status,contactability_status,source) values($1,'email',$2,$2,true,$3,'reachable','test')", [id, `${name.toLowerCase()}@example.com`, consent]);
  }
  await db.query(`insert into public.invitation_campaign_results(campaign_id,event_id,person_id,person_contact_id,eligibility_status,attribution_token) select $1,$2,p.id,c.id,'eligible',gen_random_uuid() from public.people p join public.person_contacts c on c.person_id=p.id where p.id in ($3,$4)`, [CAMPAIGN_ID, EVENT_ID, ELIGIBLE_PERSON, BLOCKED_PERSON]);
}

async function addCampaignResult(
  db: PGlite,
  personId: string,
  name: string,
  options: { consent?: string; contactability?: string; suppressed?: boolean; eligibility?: "eligible" | "excluded" } = {},
) {
  const eligibility = options.eligibility ?? "eligible";
  await db.query("insert into public.people(id,full_name,suppression_status,identity_status) values($1,$2,$3,'resolved')", [personId, name, options.suppressed ? "suppressed" : "active"]);
  if (eligibility === "eligible") {
    const contact = await db.query<{ id: string }>("insert into public.person_contacts(person_id,channel,value,normalized_value,is_primary,consent_status,contactability_status,source) values($1,'email',$2,$2,true,$3,$4,'test') returning id", [personId, `${name.toLowerCase().replaceAll(" ", ".")}@example.com`, options.consent ?? "opted_in", options.contactability ?? "reachable"]);
    await db.query("insert into public.invitation_campaign_results(campaign_id,event_id,person_id,person_contact_id,eligibility_status,attribution_token) values($1,$2,$3,$4,'eligible',gen_random_uuid())", [CAMPAIGN_ID, EVENT_ID, personId, contact.rows[0].id]);
  } else {
    await db.query("insert into public.invitation_campaign_results(campaign_id,event_id,person_id,eligibility_status,exclusion_reasons) values($1,$2,$3,'excluded',array['phase_2_3_ineligible'])", [CAMPAIGN_ID, EVENT_ID, personId]);
  }
}

test("policy centralizes consent and New York DST business window decisions", async () => {
  const db = await database();
  try {
    await seed(db);
    const result = await db.query<{ decision: string; decision_code: string; next_available_at: string | null }>(`select decision,decision_code,next_available_at from public.evaluate_outbound_policy((select id from public.invitation_campaign_results where person_id=$1),'2026-03-08T12:00:00Z')`, [ELIGIBLE_PERSON]);
    assert.deepEqual(result.rows[0].decision, "delayed");
    assert.equal(new Date(result.rows[0].next_available_at!).toISOString(), "2026-03-09T13:00:00.000Z");
    const blocked = await db.query<{ decision: string; decision_code: string }>(`select decision,decision_code from public.evaluate_outbound_policy((select id from public.invitation_campaign_results where person_id=$1),'2026-03-09T14:00:00Z')`, [BLOCKED_PERSON]);
    assert.deepEqual(blocked.rows[0], { decision: "blocked", decision_code: "channel_not_opted_in" });
  } finally { await db.close(); }
});

test("policy fails closed for every current consent/contact/person/campaign exclusion", async () => {
  const db = await database();
  try {
    await seed(db);
    await addCampaignResult(db, SUPPRESSED_PERSON, "Suppressed", { suppressed: true });
    await addCampaignResult(db, OPTED_OUT_PERSON, "Opted Out", { consent: "opted_out" });
    await addCampaignResult(db, UNKNOWN_CONTACTABILITY_PERSON, "Unknown Contactability", { contactability: "unknown" });
    await addCampaignResult(db, UNREACHABLE_PERSON, "Unreachable", { contactability: "unreachable" });
    await addCampaignResult(db, INELIGIBLE_PERSON, "Ineligible", { eligibility: "excluded" });
    const policies = await db.query<{ person_id: string; decision: string; decision_code: string }>("select evaluation.person_id,evaluation.decision,evaluation.decision_code from public.invitation_campaign_results r cross join lateral public.evaluate_outbound_policy(r.id,'2026-03-09T14:00:00Z') evaluation where r.campaign_id=$1 order by evaluation.person_id", [CAMPAIGN_ID]);
    const byPerson = new Map(policies.rows.map((row) => [row.person_id, row]));
    assert.equal(byPerson.get(SUPPRESSED_PERSON)?.decision_code, "person_suppressed");
    assert.equal(byPerson.get(OPTED_OUT_PERSON)?.decision_code, "channel_not_opted_in");
    assert.equal(byPerson.get(BLOCKED_PERSON)?.decision_code, "channel_not_opted_in");
    assert.equal(byPerson.get(UNKNOWN_CONTACTABILITY_PERSON)?.decision_code, "channel_not_reachable");
    assert.equal(byPerson.get(UNREACHABLE_PERSON)?.decision_code, "channel_not_reachable");
    assert.equal(byPerson.get(INELIGIBLE_PERSON)?.decision_code, "campaign_result_ineligible");
    assert.equal(byPerson.get(ELIGIBLE_PERSON)?.decision, "allowed");
    const weekday = await db.query<{ next_time: string }>("select public.next_outbound_send_time('2026-03-09T14:00:00Z') as next_time");
    assert.equal(new Date(weekday.rows[0].next_time).toISOString(), "2026-03-09T14:00:00.000Z");
  } finally { await db.close(); }
});

test("dry run persists policy-only snapshots and enqueue is idempotent", async () => {
  const db = await database();
  try {
    await seed(db);
    const dry = await db.query<{ value: { dry_run_id: string; total_count: number; allowed_count: number; blocked_count: number } }>("select public.create_outbound_dry_run($1,'admin@example.com','2026-03-09T14:00:00Z') as value", [CAMPAIGN_ID]);
    assert.deepEqual(dry.rows[0].value, { dry_run_id: dry.rows[0].value.dry_run_id, total_count: 2, allowed_count: 1, blocked_count: 1, delayed_count: 0, already_queued_count: 0 });
    assert.equal((await db.query<{ count: number }>("select count(*)::integer as count from public.outbound_messages")).rows[0].count, 0);
    await db.query("select public.enqueue_invitation_campaign($1,'admin@example.com','2026-03-09T14:00:00Z')", [CAMPAIGN_ID]);
    await db.query("select public.enqueue_invitation_campaign($1,'admin@example.com','2026-03-09T14:00:00Z')", [CAMPAIGN_ID]);
    await Promise.all([
      db.query("select public.enqueue_invitation_campaign($1,'admin@example.com','2026-03-09T14:00:00Z')", [CAMPAIGN_ID]),
      db.query("select public.enqueue_invitation_campaign($1,'admin@example.com','2026-03-09T14:00:00Z')", [CAMPAIGN_ID]),
    ]);
    const statuses = await db.query<{ status: string; count: number }>("select status,count(*)::integer as count from public.outbound_messages group by status order by status");
    assert.deepEqual(statuses.rows, [{ status: "blocked", count: 1 }, { status: "ready", count: 1 }]);
    const blocked = await db.query<{ terminal_at: string | null }>("select terminal_at from public.outbound_messages where status='blocked'");
    assert.ok(blocked.rows[0].terminal_at);
    assert.equal((await db.query<{ count: number }>("select count(*)::integer as count from public.outbound_audit_log where action='sent'")).rows[0].count, 0);
  } finally { await db.close(); }
});

test("delayed dry runs report queue state and scheduled decisions without sending", async () => {
  const db = await database();
  try {
    await seed(db);
    const first = await db.query<{ value: { dry_run_id: string; delayed_count: number; already_queued_count: number } }>("select public.create_outbound_dry_run($1,'admin@example.com','2026-03-08T12:00:00Z') as value", [CAMPAIGN_ID]);
    assert.equal(first.rows[0].value.delayed_count, 1);
    assert.equal(first.rows[0].value.already_queued_count, 0);
    assert.equal((await db.query<{ count: number }>("select count(*)::integer as count from public.outbound_messages")).rows[0].count, 0);
    await db.query("select public.enqueue_invitation_campaign($1,'admin@example.com','2026-03-08T12:00:00Z')", [CAMPAIGN_ID]);
    assert.equal((await db.query<{ count: number }>("select count(*)::integer as count from public.outbound_audit_log where action='scheduled'")).rows[0].count, 1);
    await db.query("update public.outbound_messages set available_at='2026-03-08T12:00:00Z' where status='scheduled'");
    assert.equal((await db.query("select * from public.claim_outbound_messages('worker',10,30,'2026-03-08T12:00:00Z')")).rows.length, 0);
    assert.equal((await db.query<{ count: number }>("select count(*)::integer as count from public.outbound_audit_log where action='scheduled'")).rows[0].count, 2);
    const second = await db.query<{ value: { already_queued_count: number } }>("select public.create_outbound_dry_run($1,'admin@example.com','2026-03-08T12:00:00Z') as value", [CAMPAIGN_ID]);
    assert.equal(second.rows[0].value.already_queued_count, 2);
    const detail = await db.query<{ decision: string; next_available_at: string | null }>("select decision,next_available_at from public.outbound_dry_run_results where dry_run_id=$1 and decision='delayed'", [first.rows[0].value.dry_run_id]);
    assert.equal(detail.rows.length, 1);
    assert.equal(new Date(detail.rows[0].next_available_at!).toISOString(), "2026-03-09T13:00:00.000Z");
  } finally { await db.close(); }
});

test("claim leases, retry bounds, terminal state, audit append-only, and ACLs fail closed", async () => {
  const db = await database();
  try {
    await seed(db);
    await db.query("select public.enqueue_invitation_campaign($1,'admin@example.com','2026-03-09T14:00:00Z')", [CAMPAIGN_ID]);
    const claim = await db.query<{ id: string; claim_token: string; attempts: number; last_attempt_at: string }>("select id,claim_token,attempts,last_attempt_at from public.claim_outbound_messages('worker-a',1,300,'2026-03-09T14:00:00Z')");
    assert.equal(claim.rows.length, 1);
    assert.equal(new Date(claim.rows[0].last_attempt_at).toISOString(), "2026-03-09T14:00:00.000Z");
    assert.equal((await db.query("select * from public.claim_outbound_messages('worker-b',1,300,'2026-03-09T14:00:01Z')")).rows.length, 0);
    await db.query("select public.report_outbound_failure($1,$2,'provider_timeout','timeout',true,'2026-03-09T14:01:00Z')", [claim.rows[0].id, claim.rows[0].claim_token]);
    const retried = await db.query<{ id: string; claim_token: string; attempts: number }>("select id,claim_token,attempts from public.claim_outbound_messages('worker-a',1,300,'2026-03-09T14:02:00Z')");
    await db.query("select public.report_outbound_failure($1,$2,'provider_timeout','timeout',false,'2026-03-09T14:03:00Z')", [retried.rows[0].id, retried.rows[0].claim_token]);
    await assert.rejects(db.query("update public.outbound_messages set status='ready' where id=$1", [claim.rows[0].id]));
    await assert.rejects(db.query("delete from public.outbound_audit_log"));
    const acl = await db.query<{ anon_execute: boolean; authenticated_execute: boolean; service_execute: boolean; policies: number; rls_tables: number }>(`select has_function_privilege('anon','public.enqueue_invitation_campaign(uuid,text,timestamp with time zone)','execute') anon_execute,has_function_privilege('authenticated','public.claim_outbound_messages(text,integer,integer,timestamp with time zone)','execute') authenticated_execute,has_function_privilege('service_role','public.create_outbound_dry_run(uuid,text,timestamp with time zone)','execute') service_execute,(select count(*)::integer from pg_catalog.pg_policies where tablename in ('outbound_messages','outbound_dry_runs','outbound_dry_run_results','outbound_audit_log')) policies,(select count(*)::integer from pg_catalog.pg_class where relname in ('outbound_messages','outbound_dry_runs','outbound_dry_run_results','outbound_audit_log') and relrowsecurity) rls_tables`);
    assert.deepEqual(acl.rows[0], { anon_execute: false, authenticated_execute: false, service_execute: true, policies: 0, rls_tables: 4 });
    const functionAcl = await db.query<{ unsafe_functions: number; exposed_helpers: number }>(`select count(*) filter (where p.proname in ('create_outbound_dry_run','enqueue_invitation_campaign','claim_outbound_messages','report_outbound_failure','cancel_outbound_message','mark_outbound_message_sent') and (has_function_privilege('public',p.oid,'execute') or has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute') or not has_function_privilege('service_role',p.oid,'execute')))::integer as unsafe_functions,count(*) filter (where p.proname in ('next_outbound_send_time','evaluate_outbound_policy','outbound_message_transition_guard','outbound_audit_log_append_only') and has_function_privilege('service_role',p.oid,'execute'))::integer as exposed_helpers from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`);
    assert.equal(functionAcl.rows[0].unsafe_functions, 0);
    assert.equal(functionAcl.rows[0].exposed_helpers, 0);
  } finally { await db.close(); }
});

test("expired lease is recovered deterministically before a different worker claims", async () => {
  const db = await database();
  try {
    await seed(db);
    await db.query("select public.enqueue_invitation_campaign($1,'admin@example.com','2026-03-09T14:00:00Z')", [CAMPAIGN_ID]);
    await db.query("select * from public.claim_outbound_messages('crashed-worker',1,30,'2026-03-09T14:00:00Z')");
    const recovered = await db.query<{ claimed_by: string; attempts: number }>("select claimed_by,attempts from public.claim_outbound_messages('recovery-worker',1,30,'2026-03-09T14:00:31Z')");
    assert.deepEqual(recovered.rows[0], { claimed_by: "recovery-worker", attempts: 2 });
    assert.equal((await db.query<{ count: number }>("select count(*)::integer as count from public.outbound_audit_log where action='lease_recovered'")).rows[0].count, 1);
  } finally { await db.close(); }
});

test("an expired lease at its retry bound becomes permanent and cannot be reclaimed", async () => {
  const db = await database();
  try {
    await seed(db);
    await db.query("select public.enqueue_invitation_campaign($1,'admin@example.com','2026-03-09T14:00:00Z')", [CAMPAIGN_ID]);
    await db.query("update public.outbound_messages set max_attempts=1 where status='ready'");
    await db.query("select * from public.claim_outbound_messages('crashed-worker',1,30,'2026-03-09T14:00:00Z')");
    assert.equal((await db.query("select * from public.claim_outbound_messages('recovery-worker',1,30,'2026-03-09T14:00:31Z')")).rows.length, 0);
    const terminal = await db.query<{ status: string; terminal_at: string | null }>("select status,terminal_at from public.outbound_messages where attempts=1");
    assert.deepEqual(terminal.rows[0].status, "permanent_failed");
    assert.ok(terminal.rows[0].terminal_at);
    assert.equal((await db.query<{ count: number }>("select count(*)::integer as count from public.outbound_audit_log where action='permanent_failed'")).rows[0].count, 1);
  } finally { await db.close(); }
});

test("state RPCs enforce sent, cancelled, blocked, terminal, and exhausted-lease boundaries", async () => {
  const db = await database();
  try {
    await seed(db);
    await db.query("select public.enqueue_invitation_campaign($1,'admin@example.com','2026-03-09T14:00:00Z')", [CAMPAIGN_ID]);
    const blocked = await db.query<{ id: string }>("select id from public.outbound_messages where status='blocked'");
    assert.equal((await db.query("select * from public.claim_outbound_messages('worker',10,30,'2026-03-09T14:00:00Z')")).rows.length, 1);
    await assert.rejects(db.query("select public.cancel_outbound_message($1,'operator')", [blocked.rows[0].id]));
    const processing = await db.query<{ id: string; claim_token: string }>("select id,claim_token from public.outbound_messages where status='processing'");
    await db.query("select public.mark_outbound_message_sent($1,$2,'future-provider','receipt-1','2026-03-09T14:00:01Z')", [processing.rows[0].id, processing.rows[0].claim_token]);
    await assert.rejects(db.query("update public.outbound_messages set status='ready' where id=$1", [processing.rows[0].id]));
    await assert.rejects(db.query("update public.outbound_messages set status='permanent_failed' where id=$1", [blocked.rows[0].id]));

    const db2 = await database();
    try {
      await seed(db2);
      await db2.query("select public.enqueue_invitation_campaign($1,'admin@example.com','2026-03-09T14:00:00Z')", [CAMPAIGN_ID]);
      const ready = await db2.query<{ id: string }>("select id from public.outbound_messages where status='ready'");
      await db2.query("select public.cancel_outbound_message($1,'operator')", [ready.rows[0].id]);
      assert.equal((await db2.query("select * from public.claim_outbound_messages('worker',1,30,'2026-03-09T14:00:00Z')")).rows.length, 0);
    } finally { await db2.close(); }
  } finally { await db.close(); }
});

test("database FK/idempotency and service table privileges reject unsafe direct use", async () => {
  const db = await database();
  try {
    await seed(db);
    await addCampaignResult(db, INELIGIBLE_PERSON, "Ineligible", { eligibility: "excluded" });
    await db.query("select public.enqueue_invitation_campaign($1,'admin@example.com','2026-03-09T14:00:00Z')", [CAMPAIGN_ID]);
    const row = await db.query<{ event_id: string; campaign_id: string; invitation_campaign_result_id: string; person_id: string; person_contact_id: string; channel: string; available_at: string }>("select event_id,campaign_id,invitation_campaign_result_id,person_id,person_contact_id,channel,available_at from public.outbound_messages where status='ready'");
    await assert.rejects(db.query("insert into public.outbound_messages(event_id,campaign_id,invitation_campaign_result_id,person_id,person_contact_id,channel,purpose,status,idempotency_key,available_at) values($1,$2,$3,$4,$5,$6,'invitation','ready','invite:v1:' || $2 || ':' || $3,$7)", [row.rows[0].event_id,row.rows[0].campaign_id,row.rows[0].invitation_campaign_result_id,row.rows[0].person_id,row.rows[0].person_contact_id,row.rows[0].channel,row.rows[0].available_at]));
    await assert.rejects(db.query("insert into public.outbound_messages(event_id,campaign_id,invitation_campaign_result_id,person_id,person_contact_id,channel,purpose,status,idempotency_key,available_at) values($1,$2,$3,$4,$5,$6,'invitation','ready','different-key',$7)", [row.rows[0].event_id,"30000000-0000-4000-8000-000000000099",row.rows[0].invitation_campaign_result_id,row.rows[0].person_id,row.rows[0].person_contact_id,row.rows[0].channel,row.rows[0].available_at]));
    const mismatchedContact = await db.query<{ id: string }>("select id from public.person_contacts where person_id=$1", [BLOCKED_PERSON]);
    await assert.rejects(db.query("insert into public.outbound_messages(event_id,campaign_id,invitation_campaign_result_id,person_id,person_contact_id,channel,purpose,status,idempotency_key,available_at) values($1,$2,$3,$4,$5,$6,'invitation','ready','contact-mismatch',$7)", [row.rows[0].event_id,row.rows[0].campaign_id,row.rows[0].invitation_campaign_result_id,row.rows[0].person_id,mismatchedContact.rows[0].id,row.rows[0].channel,row.rows[0].available_at]));
    const excluded = await db.query<{ id: string }>("select id from public.invitation_campaign_results where person_id=$1", [INELIGIBLE_PERSON]);
    await assert.rejects(db.query("insert into public.outbound_messages(event_id,campaign_id,invitation_campaign_result_id,person_id,person_contact_id,channel,purpose,status,idempotency_key,available_at,terminal_at) values($1,$2,$3,$4,null,$5,'invitation','blocked','null-contact-result-mismatch',$6,$6)", [row.rows[0].event_id,row.rows[0].campaign_id,excluded.rows[0].id,row.rows[0].person_id,row.rows[0].channel,row.rows[0].available_at]));
    await assert.rejects(db.query("insert into public.outbound_messages(event_id,campaign_id,invitation_campaign_result_id,person_id,person_contact_id,channel,purpose,status,idempotency_key,available_at,terminal_at) values($1,$2,'40000000-0000-4000-8000-000000000099',$3,null,$4,'invitation','blocked','null-contact-result-missing',$5,$5)", [row.rows[0].event_id,row.rows[0].campaign_id,row.rows[0].person_id,row.rows[0].channel,row.rows[0].available_at]));
    const privileges = await db.query<{ mutating_tables: number }>("select count(*)::integer as mutating_tables from pg_catalog.pg_tables t where t.schemaname='public' and t.tablename in ('outbound_messages','outbound_dry_runs','outbound_dry_run_results','outbound_audit_log') and (has_table_privilege('service_role','public.' || quote_ident(t.tablename),'insert') or has_table_privilege('service_role','public.' || quote_ident(t.tablename),'update') or has_table_privilege('service_role','public.' || quote_ident(t.tablename),'delete'))");
    assert.equal(privileges.rows[0].mutating_tables, 0);
  } finally { await db.close(); }
});

test("admin actions require a session and no provider implementation is present", () => {
  const actions = readFileSync(path.join(process.cwd(), "app", "admin", "(protected)", "events", "[id]", "outbound", "actions.ts"), "utf8");
  const page = readFileSync(path.join(process.cwd(), "app", "admin", "(protected)", "events", "[id]", "outbound", "page.tsx"), "utf8");
  const migration = readFileSync(path.join(process.cwd(), "supabase", "migrations", readdirSync(path.join(process.cwd(), "supabase", "migrations")).find((file) => file.includes("safe_outbound"))!), "utf8");
  assert.match(actions, /requireAdminSession\(\)/);
  assert.match(actions, /create_outbound_dry_run/);
  assert.match(actions, /enqueue_invitation_campaign/);
  assert.match(actions, /parseDryRunResponse/);
  assert.match(actions, /dry_run_id/);
  assert.match(page, /Run DRY_RUN/);
  assert.match(page, /Queue status/);
  assert.match(page, /outbound_dry_run_results/);
  assert.match(page, /DRY_RUN details/);
  assert.doesNotMatch(migration, /sendgrid|postmark|resend|fetch\(|http:/i);
  assert.equal(outboundDecisionLabel("person_suppressed"), "Person is suppressed");
  assert.equal(parseOutboundPolicyResult({}), null);
});
