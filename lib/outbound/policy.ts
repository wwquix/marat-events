export const DEFAULT_SENDING_TIME_ZONE = "America/New_York";

export type OutboundChannel = "email" | "sms" | "whatsapp" | "telegram" | "instagram";
export type ConsentStatus = "unknown" | "opted_in" | "opted_out";
export type ContactabilityStatus = "unknown" | "reachable" | "unreachable" | "suppressed";
export type SuppressionStatus = "active" | "suppressed";
export type IdentityStatus = "resolved" | "review_required";

export type SendingWindow = {
  timeZone: typeof DEFAULT_SENDING_TIME_ZONE;
  startMinute: number;
  endMinute: number;
  allowedWeekdays: readonly number[];
};

export type OutboundPolicyReason =
  | "allowed"
  | "person_suppressed"
  | "identity_review_required"
  | "contact_opted_out"
  | "unknown_consent"
  | "unusable_channel"
  | "missing_destination"
  | "unknown_contactability"
  | "contact_unreachable"
  | "contact_suppressed"
  | "stale_destination"
  | "outside_sending_window"
  | "duplicate_destination_ownership";

export type OutboundPolicyDecision =
  | { decision: "allow"; reason: "allowed" }
  | { decision: "block"; reason: Exclude<OutboundPolicyReason, "allowed" | "outside_sending_window"> }
  | { decision: "defer"; reason: "outside_sending_window"; availableAt: string };

export type OutboundPolicyInput = {
  channel: string;
  expectedChannel: OutboundChannel;
  destination: string | null;
  suppressionStatus: SuppressionStatus;
  identityStatus: IdentityStatus;
  consentStatus: ConsentStatus;
  contactabilityStatus: ContactabilityStatus;
  destinationCurrent: boolean;
  destinationUniqueOwner: boolean;
  now: Date;
  sendingWindow: SendingWindow;
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function validateSendingWindow(window: SendingWindow): void {
  if (window.timeZone !== DEFAULT_SENDING_TIME_ZONE) {
    throw new Error("Unsupported sending time zone.");
  }
  if (
    !Number.isInteger(window.startMinute) ||
    !Number.isInteger(window.endMinute) ||
    window.startMinute < 0 ||
    window.startMinute > 1_439 ||
    window.endMinute < 0 ||
    window.endMinute > 1_439 ||
    window.allowedWeekdays.length === 0 ||
    window.allowedWeekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  ) {
    throw new Error("Invalid sending window.");
  }
}

function localClock(date: Date, timeZone: string): { weekday: number; minute: number } {
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid policy timestamp.");
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_INDEX[values.weekday];
  const hour = Number(values.hour);
  const minute = Number(values.minute);

  if (weekday === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error("Unable to evaluate sending window.");
  }

  return { weekday, minute: hour * 60 + minute };
}

export function isWithinSendingWindow(date: Date, window: SendingWindow): boolean {
  validateSendingWindow(window);
  const local = localClock(date, window.timeZone);
  const allowedDays = new Set(window.allowedWeekdays);

  if (window.startMinute === window.endMinute) {
    return allowedDays.has(local.weekday);
  }

  if (window.startMinute < window.endMinute) {
    return allowedDays.has(local.weekday) && local.minute >= window.startMinute && local.minute < window.endMinute;
  }

  if (local.minute >= window.startMinute) {
    return allowedDays.has(local.weekday);
  }

  const previousWeekday = (local.weekday + 6) % 7;
  return local.minute < window.endMinute && allowedDays.has(previousWeekday);
}

export function nextSendingWindowStart(date: Date, window: SendingWindow): Date {
  validateSendingWindow(window);
  if (isWithinSendingWindow(date, window)) {
    return new Date(date.getTime());
  }

  const firstMinute = Math.floor(date.getTime() / 60_000) * 60_000 + 60_000;
  const maxMinutes = 9 * 24 * 60;
  let previousInside = false;

  for (let offset = 0; offset < maxMinutes; offset += 1) {
    const candidate = new Date(firstMinute + offset * 60_000);
    const inside = isWithinSendingWindow(candidate, window);
    if (inside && !previousInside) {
      return candidate;
    }
    previousInside = inside;
  }

  throw new Error("Unable to locate the next sending window.");
}

function hasUsableDestination(channel: OutboundChannel, destination: string): boolean {
  if (channel === "email") {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination);
  }
  if (channel === "sms" || channel === "whatsapp") {
    return /^\+[1-9]\d{7,14}$/.test(destination);
  }
  if (channel === "telegram") {
    return /^@[a-zA-Z0-9_]{5,32}$/.test(destination);
  }
  return /^@?[a-zA-Z0-9._]{1,30}$/.test(destination);
}

export function evaluateOutboundPolicy(input: OutboundPolicyInput): OutboundPolicyDecision {
  if (input.suppressionStatus !== "active") {
    return { decision: "block", reason: "person_suppressed" };
  }
  if (input.identityStatus !== "resolved") {
    return { decision: "block", reason: "identity_review_required" };
  }
  if (input.consentStatus === "opted_out") {
    return { decision: "block", reason: "contact_opted_out" };
  }
  if (input.consentStatus !== "opted_in") {
    return { decision: "block", reason: "unknown_consent" };
  }
  if (input.channel !== input.expectedChannel) {
    return { decision: "block", reason: "unusable_channel" };
  }

  const destination = input.destination?.trim() ?? "";
  if (!destination) {
    return { decision: "block", reason: "missing_destination" };
  }
  if (!hasUsableDestination(input.expectedChannel, destination)) {
    return { decision: "block", reason: "unusable_channel" };
  }
  if (input.destinationUniqueOwner !== true) {
    return { decision: "block", reason: "duplicate_destination_ownership" };
  }
  if (input.destinationCurrent !== true) {
    return { decision: "block", reason: "stale_destination" };
  }
  if (input.contactabilityStatus === "suppressed") {
    return { decision: "block", reason: "contact_suppressed" };
  }
  if (input.contactabilityStatus === "unreachable") {
    return { decision: "block", reason: "contact_unreachable" };
  }
  if (input.contactabilityStatus !== "reachable") {
    return { decision: "block", reason: "unknown_contactability" };
  }
  if (!isWithinSendingWindow(input.now, input.sendingWindow)) {
    return {
      decision: "defer",
      reason: "outside_sending_window",
      availableAt: nextSendingWindowStart(input.now, input.sendingWindow).toISOString(),
    };
  }

  return { decision: "allow", reason: "allowed" };
}
