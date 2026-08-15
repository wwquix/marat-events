export type CsvCell = string | number | null | undefined;

function neutralizeSpreadsheetFormula(value: string): string {
  if (/^[\t\r\n ]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

export function csvCell(value: CsvCell): string {
  const text = neutralizeSpreadsheetFormula(value === null || value === undefined ? "" : String(value));
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildCsv(headers: readonly string[], rows: readonly CsvCell[][]): string {
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ];

  // UTF-8 BOM keeps Excel-compatible Unicode names/emails readable.
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function csvDownloadFilename(eventSlug: string): string {
  const safeSlug = eventSlug.replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "event";
  return `${safeSlug}-attendees.csv`;
}
