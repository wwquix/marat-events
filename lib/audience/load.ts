export const RANGE_REQUEST_SIZE = 1_000;

export type RangeFetchResult<T> = Readonly<{
  data: readonly T[] | null;
  count: number | null;
  error: unknown | null;
}>;

export type RangeFetcher<T> = (
  fromInclusive: number,
  toInclusive: number,
) => Promise<RangeFetchResult<T>>;

type LoadCompleteRangeOptions<T> = Readonly<{
  maxTotal: number;
  fetchRange: RangeFetcher<T>;
}>;

function loadError(reason: string): Error {
  return new Error(`Unable to load complete range: ${reason}.`);
}

export async function loadCompleteRange<T>({
  maxTotal,
  fetchRange,
}: LoadCompleteRangeOptions<T>): Promise<T[]> {
  if (!Number.isInteger(maxTotal) || maxTotal < 0) {
    throw loadError("invalid maximum");
  }

  const rows: T[] = [];
  let expectedTotal: number | null = null;

  do {
    const remaining = expectedTotal === null ? RANGE_REQUEST_SIZE : expectedTotal - rows.length;
    const requestSize = Math.min(RANGE_REQUEST_SIZE, Math.max(remaining, 1));
    const fromInclusive = rows.length;
    const toInclusive = fromInclusive + requestSize - 1;

    let result: RangeFetchResult<T>;
    try {
      result = await fetchRange(fromInclusive, toInclusive);
    } catch {
      throw loadError("range request failed");
    }

    if (result.error || !Array.isArray(result.data)) {
      throw loadError("range request failed");
    }

    const exactCount = result.count;
    if (
      typeof exactCount !== "number" ||
      !Number.isFinite(exactCount) ||
      !Number.isInteger(exactCount) ||
      exactCount < 0 ||
      exactCount > maxTotal
    ) {
      throw loadError("invalid exact count");
    }

    if (expectedTotal === null) {
      expectedTotal = exactCount;
    } else if (exactCount !== expectedTotal) {
      throw loadError("exact count changed");
    }

    if (result.data.length > requestSize || rows.length + result.data.length > expectedTotal) {
      throw loadError("range overrun");
    }

    if (result.data.length === 0 && rows.length < expectedTotal) {
      throw loadError("empty page before exact total");
    }

    rows.push(...result.data);
  } while (expectedTotal === null || rows.length < expectedTotal);

  if (rows.length !== expectedTotal) {
    throw loadError("final count mismatch");
  }

  return rows;
}
