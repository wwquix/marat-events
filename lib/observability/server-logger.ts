import "server-only";

import { createSafeLogRecord, type LogLevel } from "./redaction";

export function logServerEvent(level: LogLevel, event: string, context: unknown = {}): void {
  const record = createSafeLogRecord(level, event, context);
  const line = JSON.stringify(record);

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.info(line);
}
