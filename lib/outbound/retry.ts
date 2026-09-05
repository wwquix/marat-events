export type OutboundErrorCategory =
  | "timeout"
  | "rate_limited"
  | "provider_unavailable"
  | "invalid_destination"
  | "rejected"
  | "policy"
  | "unknown";

export type OutboundErrorClassification = "retryable" | "permanent";

export function classifyOutboundError(category: OutboundErrorCategory): OutboundErrorClassification {
  return category === "timeout" || category === "rate_limited" || category === "provider_unavailable"
    ? "retryable"
    : "permanent";
}

export function retryDelayMs(attemptNumber: number, baseDelayMs = 60_000, maxDelayMs = 6 * 60 * 60 * 1_000): number {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error("Attempt number must be a positive integer.");
  }
  if (baseDelayMs <= 0 || maxDelayMs < baseDelayMs) {
    throw new Error("Invalid retry delay configuration.");
  }

  return Math.min(baseDelayMs * 2 ** (attemptNumber - 1), maxDelayMs);
}

export function scheduleRetry(attemptNumber: number, now: Date): string {
  if (Number.isNaN(now.getTime())) {
    throw new Error("Invalid retry timestamp.");
  }
  return new Date(now.getTime() + retryDelayMs(attemptNumber)).toISOString();
}
