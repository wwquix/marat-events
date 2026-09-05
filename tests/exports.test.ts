import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildExportCsv, exportFilename } from "../lib/exports/csv";
import {
  ExportLimitExceededError,
  ExportLoadError,
  loadBoundedExportRows,
} from "../lib/exports/paging";

function cappedFetcher<T>(rows: T[], cap: number, requests: Array<[number, number]>) {
  return async (fromInclusive: number, toInclusive: number) => {
    requests.push([fromInclusive, toInclusive]);
    const cappedTo = Math.min(toInclusive, fromInclusive + cap - 1);
    return { data: rows.slice(fromInclusive, cappedTo + 1), error: null };
  };
}

test("export paging loads exactly 5,000 rows through lower hosted caps", async () => {
  const source = Array.from({ length: 5000 }, (_, index) => ({ id: index }));
  const requests: Array<[number, number]> = [];
  const rows = await loadBoundedExportRows(cappedFetcher(source, 137, requests));

  assert.equal(rows.length, 5000);
  assert.deepEqual(rows[0], { id: 0 });
  assert.deepEqual(rows.at(-1), { id: 4999 });
  assert.deepEqual(requests[0], [0, 499]);
  assert.deepEqual(requests.at(-1), [5000, 5000]);
  assert.ok(requests.some(([from]) => from === 137));
});

test("export paging rejects row 5,001 and database failures", async () => {
  const oversized = Array.from({ length: 5001 }, (_, index) => index);
  await assert.rejects(
    loadBoundedExportRows(cappedFetcher(oversized, 211, [])),
    ExportLimitExceededError,
  );
  await assert.rejects(
    loadBoundedExportRows(async () => ({ data: null, error: { code: "database_error" } })),
    ExportLoadError,
  );
  await assert.rejects(
    loadBoundedExportRows(async () => ({ data: [1, 2], error: null }), { maxRows: 10, pageSize: 1 }),
    ExportLoadError,
  );
});

test("CSV export neutralizes spreadsheet formulas and uses safe filenames", () => {
  const csv = buildExportCsv(
    ["name", "note"],
    [
      ["=2+2", "  +SUM(A1:A2)"],
      ["\t@command", 'quoted "value"'],
      ["normal", "line\nbreak"],
    ],
  );
  assert.match(csv, /"'=2\+2"/);
  assert.match(csv, /"'  \+SUM\(A1:A2\)"/);
  assert.match(csv, /"'\t@command"/);
  assert.match(csv, /"quoted ""value"""/);
  assert.equal(exportFilename("Unsafe / Event", "campaign results", "=Q3"), "unsafe-event-campaign-results-q3.csv");
  assert.throws(
    () => buildExportCsv(["id"], Array.from({ length: 5001 }, (_, index) => [index])),
    ExportLimitExceededError,
  );
});

test("event exports authenticate before privileged reads and remain private", () => {
  const route = readFileSync(
    path.join(
      process.cwd(),
      "app",
      "admin",
      "(protected)",
      "analytics",
      "[eventId]",
      "export",
      "[kind]",
      "route.ts",
    ),
    "utf8",
  );
  const sessionCheck = route.indexOf("await getAdminSession()");
  const clientCreation = route.indexOf("createSupabaseServerClient()", sessionCheck);
  assert.ok(sessionCheck >= 0 && clientCreation > sessionCheck);
  assert.match(route, /Cache-Control": "private, no-store"/);
  assert.match(route, /X-Content-Type-Options": "nosniff"/);
  assert.match(route, /loadBoundedExportRows/g);
  assert.match(route, /\.order\("created_at"[\s\S]*\.order\("id"/);
  assert.doesNotMatch(route, /NEXT_PUBLIC_|SUPABASE_SECRET_KEY|service_role/i);
});
