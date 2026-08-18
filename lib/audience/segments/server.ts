import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";

import {
  MAX_AUDIENCE_SEGMENT_PREVIEW_ROWS,
  TRUSTED_AUDIENCE_CHANNELS,
  loadCompleteAudienceRpcRows,
  type AudienceContactSignal,
  type AudienceRegistrationSignal,
  type AudienceSegmentCandidate,
  type AudienceSegmentReasonCode,
  type TrustedAudienceChannel,
} from "../segments";

const RPC_LIMIT = MAX_AUDIENCE_SEGMENT_PREVIEW_ROWS + 1;
const CONTACT_CONSENT = ["unknown", "opted_in", "opted_out"] as const;
const CONTACTABILITY = ["unknown", "reachable", "unreachable", "suppressed"] as const;
const PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded"] as const;
const REASON_CODES: AudienceSegmentReasonCode[] = [
  "excluded_manual",
  "excluded_selection_archived",
  "excluded_suppressed",
  "excluded_identity_review_required",
  "excluded_required_channel_missing",
  "excluded_required_channel_opted_out",
  "excluded_required_channel_consent_unknown",
  "excluded_required_channel_suppressed",
  "excluded_required_channel_unreachable",
  "excluded_required_channel_contactability_unknown",
  "excluded_gender",
  "excluded_city",
  "excluded_source",
  "excluded_import_batch",
  "excluded_contact_channel",
  "excluded_contact_channel_opted_out",
  "excluded_consent",
  "excluded_contactability",
  "excluded_contact_policy_combination",
  "excluded_prior_registration",
  "included_manual",
  "included_manual_override",
  "included_criteria_match",
  "included_consent_unknown",
  "included_contactability_unknown",
];

type SelectionPreviewRow = {
  personId: string;
  fullName: string;
  eligible: boolean;
  reasonCodes: AudienceSegmentReasonCode[];
  requiredChannel: TrustedAudienceChannel;
  usableContactId: string | null;
  usableContactValue: string | null;
  usableContactNormalizedValue: string | null;
  usableContactConsentStatus: "opted_in" | null;
  usableContactContactabilityStatus: "reachable" | null;
  suppressionStatus: "active" | "suppressed";
  identityStatus: "resolved" | "review_required";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOneOf<T extends readonly string[]>(value: unknown, options: T): value is T[number] {
  return typeof value === "string" && options.includes(value as T[number]);
}

function nullableText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function parseContact(value: unknown): AudienceContactSignal | null {
  if (!isRecord(value)) return null;
  if (
    !isOneOf(value.channel, TRUSTED_AUDIENCE_CHANNELS) ||
    !isOneOf(value.consent_status, CONTACT_CONSENT) ||
    !isOneOf(value.contactability_status, CONTACTABILITY)
  ) {
    return null;
  }
  return {
    channel: value.channel,
    consentStatus: value.consent_status,
    contactabilityStatus: value.contactability_status,
  };
}

function parseRegistration(value: unknown): AudienceRegistrationSignal | null {
  if (!isRecord(value) || typeof value.event_id !== "string" || !isOneOf(value.payment_status, PAYMENT_STATUSES)) {
    return null;
  }
  return { eventId: value.event_id, paymentStatus: value.payment_status };
}

function parseCandidate(value: unknown): AudienceSegmentCandidate | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.contacts) || !Array.isArray(value.prior_registrations)) return null;
  const contacts = value.contacts.map(parseContact);
  const registrations = value.prior_registrations.map(parseRegistration);
  const city = nullableText(value.city);
  const source = nullableText(value.source);
  const importBatchId = nullableText(value.import_batch_id);
  if (
    typeof value.person_id !== "string" ||
    typeof value.full_name !== "string" ||
    !(value.gender === null || value.gender === "male" || value.gender === "female") ||
    city === undefined ||
    source === undefined ||
    importBatchId === undefined ||
    !(value.suppression_status === "active" || value.suppression_status === "suppressed") ||
    !(value.identity_status === "resolved" || value.identity_status === "review_required") ||
    contacts.some((contact) => contact === null) ||
    registrations.some((registration) => registration === null)
  ) {
    return null;
  }
  return {
    personId: value.person_id,
    fullName: value.full_name,
    gender: value.gender,
    city,
    source,
    importBatchId,
    suppressionStatus: value.suppression_status,
    identityStatus: value.identity_status,
    contacts: contacts as AudienceContactSignal[],
    priorRegistrations: registrations as AudienceRegistrationSignal[],
  };
}

function parseSelectionPreview(value: unknown): SelectionPreviewRow | null {
  if (!isRecord(value)) return null;
  const reasonCodes = Array.isArray(value.reason_codes) ? value.reason_codes : [];
  const usableContactId = nullableText(value.usable_contact_id);
  const usableContactValue = nullableText(value.usable_contact_value);
  const usableContactNormalizedValue = nullableText(value.usable_contact_normalized_value);
  if (
    typeof value.person_id !== "string" ||
    typeof value.full_name !== "string" ||
    typeof value.eligible !== "boolean" ||
    reasonCodes.length === 0 ||
    !reasonCodes.every((reason) => isOneOf(reason, REASON_CODES)) ||
    !isOneOf(value.required_channel, TRUSTED_AUDIENCE_CHANNELS) ||
    usableContactId === undefined ||
    usableContactValue === undefined ||
    usableContactNormalizedValue === undefined ||
    !(value.usable_contact_consent_status === null || value.usable_contact_consent_status === "opted_in") ||
    !(
      value.usable_contact_contactability_status === null ||
      value.usable_contact_contactability_status === "reachable"
    ) ||
    !(value.suppression_status === "active" || value.suppression_status === "suppressed") ||
    !(value.identity_status === "resolved" || value.identity_status === "review_required")
  ) {
    return null;
  }
  if (
    !reasonCodes.every(
      (reason) =>
        typeof reason === "string" &&
        reason.startsWith(value.eligible ? "included_" : "excluded_"),
    )
  ) {
    return null;
  }
  const hasUsableContact = usableContactId !== null;
  if (
    hasUsableContact !==
    (usableContactValue !== null &&
      usableContactNormalizedValue !== null &&
      value.usable_contact_consent_status === "opted_in" &&
      value.usable_contact_contactability_status === "reachable")
  ) {
    return null;
  }
  if (
    value.eligible &&
    (!usableContactId ||
      !usableContactValue ||
      !usableContactNormalizedValue ||
      value.usable_contact_consent_status !== "opted_in" ||
      value.usable_contact_contactability_status !== "reachable")
  ) {
    return null;
  }
  return {
    personId: value.person_id,
    fullName: value.full_name,
    eligible: value.eligible,
    reasonCodes: reasonCodes as AudienceSegmentReasonCode[],
    requiredChannel: value.required_channel,
    usableContactId,
    usableContactValue,
    usableContactNormalizedValue,
    usableContactConsentStatus: value.usable_contact_consent_status,
    usableContactContactabilityStatus: value.usable_contact_contactability_status,
    suppressionStatus: value.suppression_status,
    identityStatus: value.identity_status,
  };
}

function validateBoundedRows<T extends { personId: string }>(
  data: unknown,
  parser: (value: unknown) => T | null,
): T[] {
  if (!Array.isArray(data) || data.length > MAX_AUDIENCE_SEGMENT_PREVIEW_ROWS) {
    throw new Error("Audience preview exceeds the supported safety limit.");
  }
  const rows = data.map(parser);
  if (rows.some((row) => row === null)) {
    throw new Error("Audience preview data is malformed.");
  }
  const parsedRows = rows as T[];
  if (new Set(parsedRows.map((row) => row.personId)).size !== parsedRows.length) {
    throw new Error("Audience preview data is malformed.");
  }
  return parsedRows;
}

async function loadSegmentRpcRows(
  functionName: string,
  args: Record<string, string | number | null>,
): Promise<unknown[]> {
  const supabase = createSupabaseServerClient();
  return loadCompleteAudienceRpcRows<unknown>(async (fromInclusive, toInclusive) => {
    const { data, count, error } = await supabase
      .rpc(functionName, args, { count: "exact" })
      .order("person_id", { ascending: true })
      .range(fromInclusive, toInclusive);
    return { data, count, error };
  });
}

export async function loadAudienceSegmentCandidates(
  priorRegistrationEventId: string | null,
): Promise<AudienceSegmentCandidate[]> {
  const data = await loadSegmentRpcRows("get_audience_segment_candidates", {
    p_limit: RPC_LIMIT,
    p_prior_registration_event_id: priorRegistrationEventId,
  });
  return validateBoundedRows(data, parseCandidate);
}

export async function loadEventAudienceSelectionPreview(selectionId: string): Promise<SelectionPreviewRow[]> {
  const data = await loadSegmentRpcRows("preview_event_audience_selection", {
    p_selection_id: selectionId,
    p_limit: RPC_LIMIT,
  });
  return validateBoundedRows(data, parseSelectionPreview);
}

export type { SelectionPreviewRow };
