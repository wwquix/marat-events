export const ATTENDEE_MAX_ROWS = 5_000;
export const ATTENDEE_FETCH_SIZE = 1_000;
export const ATTENDEE_PAGE_SIZE = 100;

export type AttendeeRangeResult<T> = Readonly<{
  data: readonly T[] | null;
  count: number | null;
  error: unknown | null;
}>;

export type AttendeeRangeFetcher<T> = (
  fromInclusive: number,
  toInclusive: number,
) => Promise<AttendeeRangeResult<T>>;

export type AttendeeLoadErrorCode =
  | "query_failed"
  | "invalid_total"
  | "limit_exceeded"
  | "incomplete_result";

export class AttendeeLoadError extends Error {
  readonly code: AttendeeLoadErrorCode;

  constructor(code: AttendeeLoadErrorCode) {
    super(code);
    this.name = "AttendeeLoadError";
    this.code = code;
  }
}

export function validateAttendeeTotal(count: number | null): number {
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new AttendeeLoadError("invalid_total");
  }
  if (count > ATTENDEE_MAX_ROWS) {
    throw new AttendeeLoadError("limit_exceeded");
  }
  return count;
}

export async function loadCompleteAttendeeRows<T>(
  fetchRange: AttendeeRangeFetcher<T>,
  rowKey: (row: T) => string,
): Promise<T[]> {
  const rows: T[] = [];
  const seenKeys = new Set<string>();
  let expectedTotal: number | null = null;

  do {
    const remaining = expectedTotal === null ? ATTENDEE_FETCH_SIZE : expectedTotal - rows.length;
    const requestSize = Math.min(ATTENDEE_FETCH_SIZE, Math.max(remaining, 1));
    const fromInclusive = rows.length;
    const toInclusive = fromInclusive + requestSize - 1;

    let result: AttendeeRangeResult<T>;
    try {
      result = await fetchRange(fromInclusive, toInclusive);
    } catch {
      throw new AttendeeLoadError("query_failed");
    }

    if (result.error || !Array.isArray(result.data)) {
      throw new AttendeeLoadError("query_failed");
    }

    const exactTotal = validateAttendeeTotal(result.count);
    if (expectedTotal === null) {
      expectedTotal = exactTotal;
    } else if (exactTotal !== expectedTotal) {
      throw new AttendeeLoadError("incomplete_result");
    }

    const batch = result.data as readonly T[];
    if (batch.length > requestSize || rows.length + batch.length > expectedTotal) {
      throw new AttendeeLoadError("incomplete_result");
    }
    if (batch.length === 0 && rows.length < expectedTotal) {
      throw new AttendeeLoadError("incomplete_result");
    }

    for (const row of batch) {
      const key = rowKey(row);
      if (!key || seenKeys.has(key)) {
        throw new AttendeeLoadError("incomplete_result");
      }
      seenKeys.add(key);
      rows.push(row);
    }
  } while (expectedTotal === null || rows.length < expectedTotal);

  if (rows.length !== expectedTotal) {
    throw new AttendeeLoadError("incomplete_result");
  }

  return rows;
}

export function parseAttendeePage(value: string | string[] | undefined): number {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first || !/^\d+$/.test(first)) return 1;

  const page = Number(first);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export type AttendeePage<T> = Readonly<{
  rows: T[];
  page: number;
  totalPages: number;
  totalRows: number;
  firstRow: number;
  lastRow: number;
}>;

export function paginateAttendeeRows<T>(rows: readonly T[], requestedPage: number): AttendeePage<T> {
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / ATTENDEE_PAGE_SIZE));
  const safeRequestedPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const page = Math.min(safeRequestedPage, totalPages);
  const start = (page - 1) * ATTENDEE_PAGE_SIZE;
  const pageRows = rows.slice(start, start + ATTENDEE_PAGE_SIZE);

  return {
    rows: pageRows,
    page,
    totalPages,
    totalRows,
    firstRow: pageRows.length === 0 ? 0 : start + 1,
    lastRow: start + pageRows.length,
  };
}
