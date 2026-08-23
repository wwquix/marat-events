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
import { loadCompleteRange } from "../lib/audience/load";

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

function cappedRangeFetcher<T>(rows: T[], cap: number, requests: Array<[number, number]>) {
  return async (fromInclusive: number, toInclusive: number) => {
    requests.push([fromInclusive, toInclusive]);
    const cappedTo = Math.min(toInclusive, fromInclusive + cap - 1);
    return {
      data: rows.slice(fromInclusive, cappedTo + 1),
      count: rows.length,
      error: null,
    };
  };
}

test("complete range loading survives the hosted 1,000-row response cap", async () => {
  const cases = [
    { total: 500, ranges: [[0, 999]] },
    { total: 1_000, ranges: [[0, 999]] },
    {
      total: 1_550,
      ranges: [
        [0, 999],
        [1_000, 1_549],
      ],
    },
    {
      total: 5_000,
      ranges: [
        [0, 999],
        [1_000, 1_999],
        [2_000, 2_999],
        [3_000, 3_999],
        [4_000, 4_999],
      ],
    },
  ] as const;

  for (const { total, ranges } of cases) {
    const source = Array.from({ length: total }, (_, index) => index + 1);
    const requests: Array<[number, number]> = [];
    const loaded = await loadCompleteRange({
      maxTotal: 5_000,
      fetchRange: cappedRangeFetcher(source, 1_000, requests),
    });

    assert.deepEqual(loaded, source);
    assert.deepEqual(requests, ranges);
  }
});

test("complete range loading advances by the actual returned row count", async () => {
  const source = Array.from({ length: 1_550 }, (_, index) => index + 1);
  const requests: Array<[number, number]> = [];
  const loaded = await loadCompleteRange({
    maxTotal: 5_000,
    fetchRange: cappedRangeFetcher(source, 700, requests),
  });

  assert.deepEqual(loaded, source);
  assert.deepEqual(requests, [
    [0, 999],
    [700, 1_549],
    [1_400, 1_549],
  ]);
});

test("complete range loading fails closed on incomplete or changing results", async () => {
  const firstPage = Array.from({ length: 1_000 }, (_, index) => index + 1);
  let incompleteCall = 0;
  await assert.rejects(
    loadCompleteRange({
      maxTotal: 5_000,
      fetchRange: async () => {
        incompleteCall += 1;
        return {
          data: incompleteCall === 1 ? firstPage : [],
          count: 1_550,
          error: null,
        };
      },
    }),
    /empty page before exact total/,
  );

  let changedCountCall = 0;
  await assert.rejects(
    loadCompleteRange({
      maxTotal: 5_000,
      fetchRange: async (fromInclusive, toInclusive) => {
        changedCountCall += 1;
        return {
          data: Array.from({ length: toInclusive - fromInclusive + 1 }, (_, index) => fromInclusive + index),
          count: changedCountCall === 1 ? 1_550 : 1_549,
          error: null,
        };
      },
    }),
    /exact count changed/,
  );

  await assert.rejects(
    loadCompleteRange({
      maxTotal: 5_000,
      fetchRange: async () => ({ data: [1, 2], count: 1, error: null }),
    }),
    /range overrun/,
  );
});

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

test("batch-wide policy includes an unresolved review at row 1,550 on operator page 4", () => {
  const rows = Array.from({ length: 1_550 }, (_, index) =>
    row(`row-${index + 1}`, {
      previewDecision: index === 1_549 ? "review" : "invalid",
      candidates: index === 1_549 ? [PERSON_ONE] : [],
    }),
  );
  const summary = summarizeImportRows(rows);
  const page = paginateAudienceImportRows(rows, "4");
  const reviewRow = page.rows.at(-1);

  assert.equal(summary.total, 1_550);
  assert.equal(summary.invalid, 1_549);
  assert.equal(summary.unresolvedReview, 1);
  assert.equal(page.page, 4);
  assert.equal(page.startRow, 1_501);
  assert.equal(page.endRow, 1_550);
  assert.equal(reviewRow?.id, "row-1550");
  assert.equal(canOfferNewPersonResolution(reviewRow!, rows), true);
});

test("500-row operator pages preserve every supported import boundary", () => {
  const cases = [
    { total: 500, requestedPage: "1", totalPages: 1, start: 1, end: 500, lastId: "row-500" },
    { total: 1_000, requestedPage: "2", totalPages: 2, start: 501, end: 1_000, lastId: "row-1000" },
    { total: 1_550, requestedPage: "4", totalPages: 4, start: 1_501, end: 1_550, lastId: "row-1550" },
    { total: 5_000, requestedPage: "10", totalPages: 10, start: 4_501, end: 5_000, lastId: "row-5000" },
  ];

  for (const boundary of cases) {
    const rows = Array.from({ length: boundary.total }, (_, index) => ({ id: `row-${index + 1}` }));
    const page = paginateAudienceImportRows(rows, boundary.requestedPage);

    assert.equal(page.totalPages, boundary.totalPages);
    assert.equal(page.startRow, boundary.start);
    assert.equal(page.endRow, boundary.end);
    assert.equal(page.rows.at(-1)?.id, boundary.lastId);
  }
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
  assert.match(page, /loadCompleteRange/);
  assert.match(page, /allRows\.length !== typedBatch\.row_count/);
  assert.match(page, /\.order\("row_number", \{ ascending: true \}\)[\s\S]*\.order\("id", \{ ascending: true \}\)/);
  assert.match(page, /\.order\("audience_import_row_id", \{ ascending: true \}\)/);
  assert.equal(page.includes(".limit(MAX_IMPORT_ROWS)"), false);
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
