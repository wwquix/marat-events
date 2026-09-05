import type { OutboundAdapterMode } from "@/lib/outbound/adapters";
import type { DispatchableOutboxMessage } from "@/lib/outbound/dispatcher";
import {
  DEFAULT_SENDING_TIME_ZONE,
  type ContactabilityStatus,
  type ConsentStatus,
  type IdentityStatus,
  type OutboundChannel,
  type SendingWindow,
  type SuppressionStatus,
} from "@/lib/outbound/policy";

export type ClaimedOutboxWork = {
  message: DispatchableOutboxMessage;
  mode: OutboundAdapterMode;
  sendingWindow: SendingWindow;
  attemptNumber: number;
};

const CHANNELS = new Set<OutboundChannel>(["email", "sms", "whatsapp", "telegram", "instagram"]);
const CONSENT_STATUSES = new Set<ConsentStatus>(["unknown", "opted_in", "opted_out"]);
const CONTACTABILITY_STATUSES = new Set<ContactabilityStatus>([
  "unknown",
  "reachable",
  "unreachable",
  "suppressed",
]);
const SUPPRESSION_STATUSES = new Set<SuppressionStatus>(["active", "suppressed"]);
const IDENTITY_STATUSES = new Set<IdentityStatus>(["resolved", "review_required"]);

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function parseClaimedOutboxRows(value: unknown): ClaimedOutboxWork[] {
  if (!Array.isArray(value)) {
    throw new Error("Malformed outbox claim result.");
  }

  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Malformed outbox claim row.");
    }
    const row = item as Record<string, unknown>;
    const channel = row.channel;
    const mode = row.delivery_mode;
    const suppressionStatus = row.live_suppression_status;
    const identityStatus = row.live_identity_status;
    const consentStatus = row.live_consent_status;
    const contactabilityStatus = row.live_contactability_status;
    const weekdays = row.allowed_weekdays;
    const startMinute = row.sending_window_start_minute;
    const endMinute = row.sending_window_end_minute;
    const attemptNumber = row.attempt_number;

    if (
      !isString(row.id) ||
      !isString(row.idempotency_key) ||
      !isString(channel) ||
      !CHANNELS.has(channel as OutboundChannel) ||
      !isString(row.destination_snapshot) ||
      (row.subject_snapshot !== null && !isString(row.subject_snapshot)) ||
      !isString(row.body_snapshot) ||
      (mode !== "disabled" && mode !== "dry_run") ||
      !isString(suppressionStatus) ||
      !SUPPRESSION_STATUSES.has(suppressionStatus as SuppressionStatus) ||
      !isString(identityStatus) ||
      !IDENTITY_STATUSES.has(identityStatus as IdentityStatus) ||
      !isString(consentStatus) ||
      !CONSENT_STATUSES.has(consentStatus as ConsentStatus) ||
      !isString(contactabilityStatus) ||
      !CONTACTABILITY_STATUSES.has(contactabilityStatus as ContactabilityStatus) ||
      typeof row.destination_current !== "boolean" ||
      typeof row.destination_unique_owner !== "boolean" ||
      row.sending_time_zone !== DEFAULT_SENDING_TIME_ZONE ||
      !Number.isInteger(startMinute) ||
      !Number.isInteger(endMinute) ||
      !Array.isArray(weekdays) ||
      weekdays.some((day) => !Number.isInteger(day) || (day as number) < 0 || (day as number) > 6) ||
      !Number.isInteger(attemptNumber) ||
      (attemptNumber as number) < 1 ||
      (attemptNumber as number) > 5
    ) {
      throw new Error("Malformed outbox claim row.");
    }

    return {
      message: {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        state: "claimed",
        channel,
        expectedChannel: channel as OutboundChannel,
        destination: row.destination_snapshot,
        subject: row.subject_snapshot as string | null,
        body: row.body_snapshot,
        suppressionStatus: suppressionStatus as SuppressionStatus,
        identityStatus: identityStatus as IdentityStatus,
        consentStatus: consentStatus as ConsentStatus,
        contactabilityStatus: contactabilityStatus as ContactabilityStatus,
        destinationCurrent: row.destination_current,
        destinationUniqueOwner: row.destination_unique_owner,
      },
      mode,
      sendingWindow: {
        timeZone: DEFAULT_SENDING_TIME_ZONE,
        startMinute: startMinute as number,
        endMinute: endMinute as number,
        allowedWeekdays: weekdays as number[],
      },
      attemptNumber: attemptNumber as number,
    };
  });
}
