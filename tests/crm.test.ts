import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  normalizePeopleSearch,
  validateFollowUpTask,
  validatePersonNote,
  validatePersonTag,
  validateSuppressionReason,
} from "../lib/crm/validation";

test("CRM text inputs are bounded and normalized", () => {
  assert.equal(normalizePeopleSearch("  Alice   EXAMPLE  "), "alice example");
  assert.deepEqual(validatePersonNote("  Useful   internal note  "), {
    ok: true,
    value: "Useful internal note",
  });
  assert.deepEqual(validatePersonNote("   "), { ok: false });
  assert.deepEqual(validateSuppressionReason("  explicit operator request  "), {
    ok: true,
    value: "explicit operator request",
  });
});

test("follow-up tasks use deterministic New York wall-clock conversion", () => {
  assert.deepEqual(
    validateFollowUpTask({
      title: " Call guest ",
      details: "Confirm accessibility needs",
      dueAt: "2026-08-20T10:30",
      assignedTo: " operator@example.com ",
    }),
    {
      ok: true,
      value: {
        title: "Call guest",
        details: "Confirm accessibility needs",
        dueAt: "2026-08-20T14:30:00.000Z",
        assignedTo: "operator@example.com",
      },
    },
  );
  assert.deepEqual(
    validateFollowUpTask({ title: "DST gap", details: "", dueAt: "2026-03-08T02:30", assignedTo: "" }),
    { ok: false },
  );
});

test("tags are explicit safe labels rather than arbitrary expressions", () => {
  assert.deepEqual(validatePersonTag("  VIP Guest  "), {
    ok: true,
    value: { name: "VIP Guest", normalizedName: "vip guest" },
  });
  assert.deepEqual(validatePersonTag("<script>"), { ok: false });
  assert.deepEqual(validatePersonTag("emoji-🔥"), { ok: false });
});

test("CRM migration preserves audit, terminal tasks, RLS, and service-role boundaries", () => {
  const sql = readFileSync(
    path.join(process.cwd(), "supabase", "migrations", "20260818201528_phase_5_crm.sql"),
    "utf8",
  );

  for (const table of [
    "person_notes",
    "follow_up_tasks",
    "person_tags",
    "person_tag_assignments",
    "person_suppression_events",
  ]) {
    assert.match(sql, new RegExp(`create table public\\.${table}`, "i"));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, "i"));
  }

  assert.match(sql, /check \(previous_status <> new_status\)/i);
  assert.match(sql, /selected_task\.status <> 'open'[\s\S]*follow_up_task_terminal/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /security invoker/gi);
  assert.doesNotMatch(sql, /security definer/i);
  assert.match(sql, /set search_path = ''/i);
  assert.match(sql, /revoke all on function public\.set_person_suppression[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.set_person_suppression[\s\S]*to service_role/i);
});

test("every CRM mutation rechecks the admin session", () => {
  const actions = readFileSync(
    path.join(process.cwd(), "app", "admin", "(protected)", "people", "actions.ts"),
    "utf8",
  );
  const exportedActions = actions.match(/export async function \w+Action/g) ?? [];
  const sessionChecks = actions.match(/await requireAdminSession\(\)/g) ?? [];
  assert.equal(exportedActions.length, 6);
  assert.equal(sessionChecks.length, exportedActions.length);
});

test("people list avoids rendering email or phone in the operational index", () => {
  const page = readFileSync(
    path.join(process.cwd(), "app", "admin", "(protected)", "people", "page.tsx"),
    "utf8",
  );
  assert.doesNotMatch(page, /\{person\.(?:email|phone)\}/);
  assert.match(page, /suppression_status/);
  assert.match(page, /identity_status/);
});
