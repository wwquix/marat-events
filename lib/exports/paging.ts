export const EXPORT_MAX_ROWS = 5000;
export const EXPORT_PAGE_SIZE = 500;

export type ExportRangeResult<T> = {
  data: T[] | null;
  error: unknown;
};

export type ExportRangeFetcher<T> = (
  fromInclusive: number,
  toInclusive: number,
) => Promise<ExportRangeResult<T>>;

export class ExportLoadError extends Error {
  constructor() {
    super("export_load_failed");
    this.name = "ExportLoadError";
  }
}

export class ExportLimitExceededError extends Error {
  constructor() {
    super("export_limit_exceeded");
    this.name = "ExportLimitExceededError";
  }
}

export async function loadBoundedExportRows<T>(
  fetchRange: ExportRangeFetcher<T>,
  options: { maxRows?: number; pageSize?: number } = {},
): Promise<T[]> {
  const maxRows = options.maxRows ?? EXPORT_MAX_ROWS;
  const pageSize = options.pageSize ?? EXPORT_PAGE_SIZE;
  if (!Number.isInteger(maxRows) || maxRows < 0 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new ExportLoadError();
  }

  const rows: T[] = [];
  let offset = 0;

  while (offset <= maxRows) {
    const toInclusive = Math.min(offset + pageSize - 1, maxRows);
    const result = await fetchRange(offset, toInclusive);
    if (result.error || (result.data !== null && !Array.isArray(result.data))) throw new ExportLoadError();

    const batch = result.data ?? [];
    const requested = toInclusive - offset + 1;
    if (batch.length > requested) throw new ExportLoadError();
    if (batch.length === 0) break;

    rows.push(...batch);
    if (rows.length > maxRows) throw new ExportLimitExceededError();

    // Advance by what the server actually returned. Hosted Data API caps may be lower than our page size.
    offset += batch.length;
  }

  return rows;
}
