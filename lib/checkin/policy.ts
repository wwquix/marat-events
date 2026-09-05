export type CheckInOutcome =
  | "checked_in"
  | "already_checked_in"
  | "invalid_token"
  | "wrong_event"
  | "unpaid"
  | "revoked"
  | "expired"
  | "manual_not_found";

export type CheckInEligibility = Readonly<{
  tokenFound: boolean;
  eventMatches: boolean;
  tokenStatus: "active" | "revoked";
  expiresAt: Date | null;
  paymentStatus: string;
  checkedInAt: Date | null;
}>;

const CHECK_IN_OUTCOMES = new Set<CheckInOutcome>([
  "checked_in",
  "already_checked_in",
  "invalid_token",
  "wrong_event",
  "unpaid",
  "revoked",
  "expired",
  "manual_not_found",
]);

export function isCheckInOutcome(value: unknown): value is CheckInOutcome {
  return typeof value === "string" && CHECK_IN_OUTCOMES.has(value as CheckInOutcome);
}

export function decideTokenCheckIn(
  eligibility: CheckInEligibility,
  now: Date,
): CheckInOutcome {
  if (!eligibility.tokenFound) return "invalid_token";
  if (!eligibility.eventMatches) return "wrong_event";
  if (eligibility.tokenStatus === "revoked") return "revoked";
  if (eligibility.expiresAt && eligibility.expiresAt.getTime() <= now.getTime()) return "expired";
  if (eligibility.paymentStatus !== "paid") return "unpaid";
  if (eligibility.checkedInAt) return "already_checked_in";
  return "checked_in";
}

export function checkInOutcomeMessage(outcome: CheckInOutcome): string {
  switch (outcome) {
    case "checked_in":
      return "Check-in recorded.";
    case "already_checked_in":
      return "This registration was already checked in.";
    case "wrong_event":
      return "This ticket belongs to a different event.";
    case "unpaid":
      return "Only paid registrations can check in.";
    case "revoked":
      return "This check-in token has been revoked.";
    case "expired":
      return "This check-in token has expired.";
    case "manual_not_found":
      return "The selected registration is not available for this event.";
    default:
      return "The check-in token is invalid.";
  }
}
