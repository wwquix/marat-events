import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ATTENDEE_PAGE_SIZE,
  AttendeeLoadError,
  loadCompleteAttendeeRows,
  paginateAttendeeRows,
  parseAttendeePage,
  validateAttendeeTotal,
} from "../lib/admin/attendee-pagination";

type Row = { id: string; ordinal: number };

function rows(total: number): Row[] {
  return Array.from({ length: total }, (_, index) => ({
    id: `registration-${index + 1}`,
    ordinal: index + 1,
  }));
}

function cappedFetcher(source: Row[], cap: number, requests: Array<[number, number]>) {
  return async (fromInclusive: number, toInclusive: number) => {
    requests.push([fromInclusive, toInclusive]);
    const cappedTo = Math.min(toInclusive, fromInclusive + cap - 1);
    return {
      data: source.slice(fromInclusive, cappedTo + 1),
      count: source.length,
      error: null,
    };
  };
}

test("complete attendee loading covers the 500, 1,000, 1,550 and 5,000 row boundaries", async () => {
  const cases = [
    { total: 500, ranges: [[0, 999]] },
    { total: 1_000, ranges: [[0, 999]] },
    { total: 1_550, ranges: [[0, 999], [1_000, 1_549]] },
    {
      total: 5_000,
      ranges: [[0, 999], [1_000, 1_999], [2_000, 2_999], [3_000, 3_999], [4_000, 4_999]],
    },
  ] as const;

  for (const { total, ranges } of cases) {
    const source = rows(total);
    const requests: Array<[number, number]> = [];
    const loaded = await loadCompleteAttendeeRows(
      cappedFetcher(source, 1_000, requests),
      (row) => row.id,
    );

    assert.deepEqual(loaded, source);
    assert.deepEqual(requests, ranges);
  }
});

test("complete attendee loading advances by the actual hosted response size", async () => {
  const source = rows(1_550);
  const requests: Array<[number, number]> = [];
  const loaded = await loadCompleteAttendeeRows(
    cappedFetcher(source, 700, requests),
    (row) => row.id,
  );

  assert.deepEqual(loaded, source);
  assert.deepEqual(requests, [
    [0, 999],
    [700, 1_549],
    [1_400, 1_549],
  ]);
});

test("bounded attendee pages make every one of 5,000 rows reachable exactly once", () => {
  const source = rows(5_000);
  const reachable: Row[] = [];

  for (let requestedPage = 1; requestedPage <= 50; requestedPage += 1) {
    const page = paginateAttendeeRows(source, requestedPage);
    assert.equal(page.page, requestedPage);
    assert.equal(page.totalPages, 50);
    assert.ok(page.rows.length <= ATTENDEE_PAGE_SIZE);
    reachable.push(...page.rows);
  }

  assert.deepEqual(reachable, source);
  assert.equal(new Set(reachable.map((row) => row.id)).size, 5_000);

  const clamped = paginateAttendeeRows(source, 999);
  assert.equal(clamped.page, 50);
  assert.equal(clamped.firstRow, 4_901);
  assert.equal(clamped.lastRow, 5_000);
});

test("attendee loading fails closed on invalid totals, limits and incomplete pages", async () => {
  assert.throws(
    () => validateAttendeeTotal(null),
    (error) => error instanceof AttendeeLoadError && error.code === "invalid_total",
  );
  assert.throws(
    () => validateAttendeeTotal(5_001),
    (error) => error instanceof AttendeeLoadError && error.code === "limit_exceeded",
  );

  let call = 0;
  await assert.rejects(
    loadCompleteAttendeeRows<Row>(
      async () => {
        call += 1;
        return {
          data: call === 1 ? rows(500) : [],
          count: 1_000,
          error: null,
        };
      },
      (row) => row.id,
    ),
    (error) => error instanceof AttendeeLoadError && error.code === "incomplete_result",
  );

  await assert.rejects(
    loadCompleteAttendeeRows<Row>(
      async () => ({ data: [rows(1)[0], rows(1)[0]], count: 2, error: null }),
      (row) => row.id,
    ),
    (error) => error instanceof AttendeeLoadError && error.code === "incomplete_result",
  );
});

test("attendee page parsing rejects malformed and unsafe page values", () => {
  assert.equal(parseAttendeePage("2"), 2);
  assert.equal(parseAttendeePage(["3", "4"]), 3);
  assert.equal(parseAttendeePage("0"), 1);
  assert.equal(parseAttendeePage("1.5"), 1);
  assert.equal(parseAttendeePage("1e2"), 1);
  assert.equal(parseAttendeePage("999999999999999999999"), 1);
});

test("admin attendee page and export use complete paging with deterministic ordering", () => {
  const pageSource = readFileSync(
    path.join(process.cwd(), "app/admin/(protected)/events/[id]/attendees/page.tsx"),
    "utf8",
  );
  const exportSource = readFileSync(
    path.join(process.cwd(), "app/admin/(protected)/events/[id]/attendees/export/route.ts"),
    "utf8",
  );

  assert.doesNotMatch(pageSource, /\.limit\(500\)/);
  assert.match(pageSource, /loadCompleteAttendeeRows/);
  assert.match(pageSource, /paginateAttendeeRows/);
  assert.match(pageSource, /\.order\("created_at", \{ ascending: false \}\)[\s\S]*\.order\("id", \{ ascending: true \}\)/);

  assert.match(exportSource, /validateAttendeeTotal/);
  assert.match(exportSource, /loadCompleteAttendeeRows/);
  assert.match(exportSource, /"Cache-Control": "private, no-store"/);
  assert.match(exportSource, /\.order\("created_at", \{ ascending: false \}\)[\s\S]*\.order\("id", \{ ascending: true \}\)/);
});
