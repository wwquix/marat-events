import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  canOfferNewPersonResolution,
  paginateAudienceImportRows,
  preflightAudienceImport,
  summarizeImportRows,
  trustedContactKey,
  type ImportCommitRow,
  type ReviewResolutionAction,
} from "../lib/audience/commit";

const PERSON_ONE = "00000000-0000-4000-8000-000000000001";
const PERSON_TWO = "00000000-0000-4000-8000-000000000002";

function row(
  id: string,
  options: {
    previewDecision?: ImportCommitRow["previewDecision"];
    decision?: ImportCommitRow["decision"];
    email?: string;
    name?: string;
    candidates?: string[];
    resolution?: ReviewResolutionAction | null;
    resolvedPersonId?: string | null;
  } = {},
): ImportCommitRow {
  const email = options.email ?? `${id}@example.com`;
  return {
    id,
    previewDecision: options.previewDecision ?? "new_person",
    decision: options.decision ?? options.previewDecision ?? "new_person",
    candidatePersonIds: options.candidates ?? [],
    normalizedData: {
      fullName: options.name ?? `Person ${id}`,
      contacts: email
        ? [{ channel: "email", value: email, normalizedValue: email.toLowerCase() }]
        : [],
    },
    resolutionAction: options.resolution ?? null,
    resolvedPersonId: options.resolvedPersonId ?? null,
    committedPersonId: options.decision === "committed" ? PERSON_ONE : null,
  };
}

test("unresolved review blocks commit", () => {
  const result = preflightAudienceImport(
    "preview",
    [row("review", { previewDecision: "review" })],
    new Map(),
  );
  assert.deepEqual(result, { ok: false, reason: "unresolved_review", rowId: "review" });
});

test("explicit reuse resolution accepts only an actual candidate", () => {
  const valid = row("reuse", {
    previewDecision: "review",
    candidates: [PERSON_ONE, PERSON_TWO],
    resolution: "reuse_person",
    resolvedPersonId: PERSON_ONE,
  });
  const identityOwners = new Map([["email:reuse@example.com", new Set([PERSON_ONE])]]);
  assert.deepEqual(preflightAudienceImport("preview", [valid], identityOwners), {
    ok: true,
    idempotent: false,
  });

  const invalid = { ...valid, resolvedPersonId: "00000000-0000-4000-8000-000000000099" };
  assert.deepEqual(preflightAudienceImport("preview", [invalid], identityOwners), {
    ok: false,
    reason: "invalid_reuse_target",
    rowId: "reuse",
  });
});

test("explicit new-person and exclude resolutions produce the expected commit summary", () => {
  const rows = [
    row("new", { previewDecision: "review", resolution: "new_person" }),
    row("skip", { previewDecision: "review", resolution: "exclude" }),
    row("invalid", { previewDecision: "invalid" }),
  ];

  assert.deepEqual(preflightAudienceImport("preview", rows, new Map()), {
    ok: true,
    idempotent: false,
  });
  assert.deepEqual(summarizeImportRows(rows), {
    total: 3,
    newPeople: 1,
    reusedPeople: 0,
    unresolvedReview: 0,
    resolvedReview: 2,
    invalid: 1,
    excluded: 1,
    committed: 0,
  });
});

test("duplicate trusted identifiers cannot create two new people", () => {
  const rows = [row("first", { email: "same@example.com" }), row("second", { email: "same@example.com" })];
  assert.deepEqual(preflightAudienceImport("preview", rows, new Map()), {
    ok: false,
    reason: "conflicting_planned_identifier_ownership",
    rowId: "second",
  });
});

test("one batch identifier cannot be planned for two different reused people", () => {
  const shared = "shared@example.com";
  const rows = [
    row("first", {
      previewDecision: "review",
      email: shared,
      candidates: [PERSON_ONE, PERSON_TWO],
      resolution: "reuse_person",
      resolvedPersonId: PERSON_ONE,
    }),
    row("second", {
      previewDecision: "review",
      email: shared,
      candidates: [PERSON_ONE, PERSON_TWO],
      resolution: "reuse_person",
      resolvedPersonId: PERSON_TWO,
    }),
  ];

  assert.deepEqual(preflightAudienceImport("preview", rows, new Map()), {
    ok: false,
    reason: "conflicting_planned_identifier_ownership",
    rowId: "second",
  });
});

test("duplicate rows may idempotently attach one identifier to the same reused person", () => {
  const rows = ["first", "second"].map((id) =>
    row(id, {
      previewDecision: "review",
      email: "shared@example.com",
      candidates: [PERSON_ONE, PERSON_TWO],
      resolution: "reuse_person",
      resolvedPersonId: PERSON_ONE,
    }),
  );

  assert.deepEqual(preflightAudienceImport("preview", rows, new Map()), {
    ok: true,
    idempotent: false,
  });
});

test("duplicate review rows allow one new person only after the other is explicitly excluded", () => {
  const first = row("first", { previewDecision: "review", email: "same@example.com" });
  const second = row("second", { previewDecision: "review", email: "same@example.com" });
  assert.equal(canOfferNewPersonResolution(first, [first, second]), false);

  const excluded = { ...second, resolutionAction: "exclude" as const };
  assert.equal(canOfferNewPersonResolution(first, [first, excluded]), true);
});

test("name equality alone never reuses a person", () => {
  const rows = [
    row("first", { name: "Same Name", email: "one@example.com" }),
    row("second", { name: "Same Name", email: "two@example.com" }),
  ];
  assert.deepEqual(preflightAudienceImport("preview", rows, new Map()), {
    ok: true,
    idempotent: false,
  });
});

test("stale preview identity conflicts abort both new and reuse plans", () => {
  const newRow = row("new", { email: "claimed@example.com" });
  const claimedKey = trustedContactKey({ channel: "email", normalizedValue: "claimed@example.com" });
  assert.deepEqual(
    preflightAudienceImport("preview", [newRow], new Map([[claimedKey, new Set([PERSON_ONE])]])),
    { ok: false, reason: "stale_identity_conflict", rowId: "new" },
  );

  const reused = row("reuse", {
    previewDecision: "reuse_person",
    email: "reuse@example.com",
    candidates: [PERSON_ONE],
  });
  assert.deepEqual(
    preflightAudienceImport("preview", [reused], new Map([["email:reuse@example.com", new Set([PERSON_TWO])]])),
    { ok: false, reason: "stale_identity_conflict", rowId: "reuse" },
  );
});

test("committed batches are idempotent and keep committed counts", () => {
  const committed = row("done", {
    previewDecision: "new_person",
    decision: "committed",
  });
  assert.deepEqual(preflightAudienceImport("committed", [committed], new Map()), {
    ok: true,
    idempotent: true,
  });
  assert.equal(summarizeImportRows([committed]).committed, 1);
  assert.equal(summarizeImportRows([committed]).newPeople, 1);
});

test("a review row beyond index 500 is reachable and offers its resolution controls", () => {
  const rows = Array.from({ length: 551 }, (_, index) =>
    row(`row-${index + 1}`, {
      previewDecision: index === 550 ? "review" : "invalid",
    }),
  );
  const page = paginateAudienceImportRows(rows, "2");

  assert.equal(page.page, 2);
  assert.equal(page.startRow, 501);
  assert.equal(page.endRow, 551);
  assert.equal(page.rows.at(-1)?.id, "row-551");
  assert.equal(canOfferNewPersonResolution(page.rows.at(-1)!, rows), true);
});

test("SQL transaction keeps identity and consent invariants explicit", () => {
  const migrationName = readdirSync(path.join(process.cwd(), "supabase", "migrations")).find((name) =>
    name.endsWith("_phase_2_import_review_commit.sql"),
  );
  assert.ok(migrationName);
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", migrationName), "utf8");

  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /status = 'committed'/i);
  assert.match(sql, /stale_new_person_conflict/i);
  assert.match(sql, /stale_reuse_conflict/i);
  assert.match(sql, /planned_identifier_owners/i);
  assert.match(sql, /count\(distinct planned_owner\) > 1/i);
  assert.match(sql, /conflicting_planned_identifier_ownership/i);
  assert.match(sql, /consent_status[\s\S]*'unknown'/i);
  assert.match(sql, /contactability_status[\s\S]*'unknown'/i);
  assert.doesNotMatch(sql, /update\s+public\.people\s+set/i);
  assert.match(sql, /preview_decision <> 'invalid'/i);
  assert.match(sql, /resolution_action, ''\) <> 'exclude'/i);
  assert.match(sql, /revoke execute on function public\.commit_audience_import[\s\S]*from anon/i);
  assert.match(sql, /grant execute on function public\.commit_audience_import[\s\S]*to service_role/i);
  assert.doesNotMatch(sql, /\bcommit\s*;/i);
});

test("paginated review forms preserve the selected page after a resolution", () => {
  const page = readFileSync(
    path.join(process.cwd(), "app", "admin", "(protected)", "audience", "import", "[id]", "page.tsx"),
    "utf8",
  );
  const actions = readFileSync(
    path.join(process.cwd(), "app", "admin", "(protected)", "audience", "import", "actions.ts"),
    "utf8",
  );

  assert.match(page, /name="return_page"/);
  assert.match(page, /paginateAudienceImportRows/);
  assert.match(actions, /readReturnPage\(formData\)/);
  assert.match(actions, /batchPath\(batchId, error \? "resolution_blocked" : "resolved", returnPage\)/);
});

test("every audience import mutation rechecks the admin session", () => {
  const source = readFileSync(
    path.join(process.cwd(), "app", "admin", "(protected)", "audience", "import", "actions.ts"),
    "utf8",
  );
  for (const actionName of [
    "createAudienceImportPreviewAction",
    "discardAudienceImportPreviewAction",
    "resolveAudienceImportReviewAction",
    "commitAudienceImportAction",
  ]) {
    const start = source.indexOf(`export async function ${actionName}`);
    assert.notEqual(start, -1);
    const nextExport = source.indexOf("export async function", start + 1);
    const body = source.slice(start, nextExport === -1 ? undefined : nextExport);
    assert.match(body, /await requireAdminSession\(\)/);
  }
});
