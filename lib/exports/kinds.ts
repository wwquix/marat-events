export const EVENT_EXPORT_KINDS = ["audience", "attendees", "campaign-results", "event-summary", "matches"] as const;

export type EventExportKind = (typeof EVENT_EXPORT_KINDS)[number];

export function parseEventExportKind(value: unknown): EventExportKind | null {
  return typeof value === "string" && (EVENT_EXPORT_KINDS as readonly string[]).includes(value)
    ? (value as EventExportKind)
    : null;
}
