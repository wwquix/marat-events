import { buildCsv, type CsvCell } from "@/lib/admin/csv";

import { EXPORT_MAX_ROWS, ExportLimitExceededError } from "./paging";

export type ExportCsvCell = CsvCell;

export function buildExportCsv(headers: readonly string[], rows: readonly ExportCsvCell[][]): string {
  if (rows.length > EXPORT_MAX_ROWS) throw new ExportLimitExceededError();
  return buildCsv(headers, rows);
}

export function exportFilename(eventSlug: string, kind: string, qualifier?: string): string {
  const safePart = (value: string) => value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const parts = [safePart(eventSlug) || "event", safePart(kind) || "export"];
  const safeQualifier = qualifier ? safePart(qualifier) : "";
  if (safeQualifier) parts.push(safeQualifier);
  return `${parts.join("-")}.csv`;
}
