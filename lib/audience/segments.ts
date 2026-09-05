import { loadCompleteRange, type RangeFetcher } from "./load";

export const MAX_AUDIENCE_SEGMENT_PREVIEW_ROWS = 5_000;

export function loadCompleteAudienceRpcRows<T>(fetchRange: RangeFetcher<T>): Promise<T[]> {
  return loadCompleteRange({
    maxTotal: MAX_AUDIENCE_SEGMENT_PREVIEW_ROWS,
    fetchRange,
  });
}

export const TRUSTED_AUDIENCE_CHANNELS = [
  "email",
  "phone",
  "sms",
  "instagram",
  "linkedin",
  "whatsapp",
  "telegram",
] as const;

export type TrustedAudienceChannel = (typeof TRUSTED_AUDIENCE_CHANNELS)[number];
export type AudienceConsentRequirement = "any" | "opted_in" | "unknown";
export type AudienceContactabilityRequirement = "any" | "reachable" | "unknown";
export type AudienceRegistrationRequirement = "any" | "paid";
export type AudienceSelectionStatus = "draft" | "archived";
export type AudienceOverrideDecision = "include" | "exclude";

export type AudienceSegmentCriteria = {
  gender: "male" | "female" | null;
  city: string | null;
  source: string | null;
  importBatchId: string | null;
  contactChannel: TrustedAudienceChannel | null;
  consentRequirement: AudienceConsentRequirement;
  contactabilityRequirement: AudienceContactabilityRequirement;
  priorRegistrationEventId: string | null;
  priorRegistrationPaymentStatus: AudienceRegistrationRequirement;
};

export type AudienceContactSignal = {
  channel: TrustedAudienceChannel;
  consentStatus: "unknown" | "opted_in" | "opted_out";
  contactabilityStatus: "unknown" | "reachable" | "unreachable" | "suppressed";
};

export type AudienceRegistrationSignal = {
  eventId: string;
  paymentStatus: "pending" | "paid" | "failed" | "refunded";
};

export type AudienceSegmentCandidate = {
  personId: string;
  fullName: string;
  gender: "male" | "female" | null;
  city: string | null;
  source: string | null;
  importBatchId: string | null;
  suppressionStatus: "active" | "suppressed";
  identityStatus: "resolved" | "review_required";
  contacts: AudienceContactSignal[];
  priorRegistrations: AudienceRegistrationSignal[];
};

export type AudienceSegmentOverride = {
  personId: string;
  decision: AudienceOverrideDecision;
};

export type AudienceSegmentReasonCode =
  | "excluded_manual"
  | "excluded_selection_archived"
  | "excluded_suppressed"
  | "excluded_identity_review_required"
  | "excluded_required_channel_missing"
  | "excluded_required_channel_opted_out"
  | "excluded_required_channel_consent_unknown"
  | "excluded_required_channel_suppressed"
  | "excluded_required_channel_unreachable"
  | "excluded_required_channel_contactability_unknown"
  | "excluded_gender"
  | "excluded_city"
  | "excluded_source"
  | "excluded_import_batch"
  | "excluded_contact_channel"
  | "excluded_contact_channel_opted_out"
  | "excluded_consent"
  | "excluded_contactability"
  | "excluded_contact_policy_combination"
  | "excluded_prior_registration"
  | "included_manual"
  | "included_manual_override"
  | "included_criteria_match"
  | "included_consent_unknown"
  | "included_contactability_unknown";

export type AudienceSegmentEvaluation = {
  personId: string;
  fullName: string;
  included: boolean;
  reasonCodes: AudienceSegmentReasonCode[];
  overrideDecision: AudienceOverrideDecision | null;
};

export type AudienceSegmentCriteriaValidation =
  | { ok: true; value: AudienceSegmentCriteria }
  | { ok: false; issues: string[] };

type CriteriaInput = Partial<Record<keyof AudienceSegmentCriteria, unknown>>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > maxLength) return undefined;
  return normalized;
}

function isTrustedChannel(value: unknown): value is TrustedAudienceChannel {
  return TRUSTED_AUDIENCE_CHANNELS.includes(value as TrustedAudienceChannel);
}

export function validateAudienceSegmentCriteria(input: CriteriaInput): AudienceSegmentCriteriaValidation {
  const issues: string[] = [];

  const gender = input.gender === "" || input.gender === null || input.gender === undefined ? null : input.gender;
  if (gender !== null && gender !== "male" && gender !== "female") issues.push("invalid_gender");

  const city = optionalText(input.city, 120);
  if (city === undefined) issues.push("invalid_city");

  const source = optionalText(input.source, 160);
  if (source === undefined) issues.push("invalid_source");

  const importBatchId = optionalText(input.importBatchId, 36);
  if (importBatchId && !UUID_PATTERN.test(importBatchId)) issues.push("invalid_import_batch_id");

  const contactChannel =
    input.contactChannel === "" || input.contactChannel === null || input.contactChannel === undefined
      ? null
      : input.contactChannel;
  if (contactChannel !== null && !isTrustedChannel(contactChannel)) issues.push("invalid_contact_channel");

  const consentRequirement = input.consentRequirement ?? "any";
  if (!(["any", "opted_in", "unknown"] as const).includes(consentRequirement as AudienceConsentRequirement)) {
    issues.push("invalid_consent_requirement");
  }

  const contactabilityRequirement = input.contactabilityRequirement ?? "any";
  if (
    !(["any", "reachable", "unknown"] as const).includes(
      contactabilityRequirement as AudienceContactabilityRequirement,
    )
  ) {
    issues.push("invalid_contactability_requirement");
  }

  const priorRegistrationEventId = optionalText(input.priorRegistrationEventId, 36);
  if (priorRegistrationEventId && !UUID_PATTERN.test(priorRegistrationEventId)) {
    issues.push("invalid_prior_registration_event_id");
  }

  const priorRegistrationPaymentStatus = input.priorRegistrationPaymentStatus ?? "any";
  if (!(["any", "paid"] as const).includes(priorRegistrationPaymentStatus as AudienceRegistrationRequirement)) {
    issues.push("invalid_prior_registration_payment_status");
  }

  if (
    contactChannel === null &&
    (consentRequirement !== "any" || contactabilityRequirement !== "any")
  ) {
    issues.push("contact_channel_required");
  }

  if (priorRegistrationEventId === null && priorRegistrationPaymentStatus !== "any") {
    issues.push("prior_registration_event_required");
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      gender: gender as AudienceSegmentCriteria["gender"],
      city: city ?? null,
      source: source ?? null,
      importBatchId: importBatchId ?? null,
      contactChannel: contactChannel as TrustedAudienceChannel | null,
      consentRequirement: consentRequirement as AudienceConsentRequirement,
      contactabilityRequirement: contactabilityRequirement as AudienceContactabilityRequirement,
      priorRegistrationEventId: priorRegistrationEventId ?? null,
      priorRegistrationPaymentStatus: priorRegistrationPaymentStatus as AudienceRegistrationRequirement,
    },
  };
}

export function criteriaFromSegmentRow(row: Record<string, unknown>): AudienceSegmentCriteriaValidation {
  return validateAudienceSegmentCriteria({
    gender: row.gender,
    city: row.city,
    source: row.source,
    importBatchId: row.import_batch_id,
    contactChannel: row.contact_channel,
    consentRequirement: row.consent_requirement,
    contactabilityRequirement: row.contactability_requirement,
    priorRegistrationEventId: row.prior_registration_event_id,
    priorRegistrationPaymentStatus: row.prior_registration_payment_status,
  });
}

export function criteriaFromSelectionRow(row: Record<string, unknown>): AudienceSegmentCriteriaValidation {
  return validateAudienceSegmentCriteria({
    gender: row.snapshot_gender,
    city: row.snapshot_city,
    source: row.snapshot_source,
    importBatchId: row.snapshot_import_batch_id,
    contactChannel: row.snapshot_contact_channel,
    consentRequirement: row.snapshot_consent_requirement,
    contactabilityRequirement: row.snapshot_contactability_requirement,
    priorRegistrationEventId: row.snapshot_prior_registration_event_id,
    priorRegistrationPaymentStatus: row.snapshot_prior_registration_payment_status,
  });
}

function normalizedComparable(value: string | null): string | null {
  return value?.trim().replace(/\s+/g, " ").toLowerCase() ?? null;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requiredChannelExclusion(
  contacts: AudienceContactSignal[],
  requiredChannel: TrustedAudienceChannel,
): AudienceSegmentReasonCode | null {
  const channelContacts = contacts.filter((contact) => contact.channel === requiredChannel);
  if (channelContacts.length === 0) return "excluded_required_channel_missing";
  if (
    channelContacts.some(
      (contact) => contact.consentStatus === "opted_in" && contact.contactabilityStatus === "reachable",
    )
  ) {
    return null;
  }
  if (channelContacts.some((contact) => contact.consentStatus === "opted_out")) {
    return "excluded_required_channel_opted_out";
  }
  if (channelContacts.some((contact) => contact.consentStatus === "unknown")) {
    return "excluded_required_channel_consent_unknown";
  }
  if (channelContacts.some((contact) => contact.contactabilityStatus === "suppressed")) {
    return "excluded_required_channel_suppressed";
  }
  if (channelContacts.some((contact) => contact.contactabilityStatus === "unreachable")) {
    return "excluded_required_channel_unreachable";
  }
  return "excluded_required_channel_contactability_unknown";
}

function criteriaReasons(
  candidate: AudienceSegmentCandidate,
  criteria: AudienceSegmentCriteria,
): AudienceSegmentReasonCode[] {
  const reasons: AudienceSegmentReasonCode[] = [];
  if (criteria.gender && candidate.gender !== criteria.gender) reasons.push("excluded_gender");
  if (criteria.city && normalizedComparable(candidate.city) !== normalizedComparable(criteria.city)) {
    reasons.push("excluded_city");
  }
  if (criteria.source && normalizedComparable(candidate.source) !== normalizedComparable(criteria.source)) {
    reasons.push("excluded_source");
  }
  if (criteria.importBatchId && candidate.importBatchId !== criteria.importBatchId) {
    reasons.push("excluded_import_batch");
  }

  if (criteria.contactChannel) {
    const channelContacts = candidate.contacts.filter((contact) => contact.channel === criteria.contactChannel);
    if (channelContacts.length === 0) {
      reasons.push("excluded_contact_channel");
    } else if (channelContacts.every((contact) => contact.consentStatus === "opted_out")) {
      reasons.push("excluded_contact_channel_opted_out");
    } else {
      const contactableByConsent = channelContacts.filter(
        (contact) => contact.consentStatus !== "opted_out",
      );
      const consentMatches =
        criteria.consentRequirement === "any" ||
        contactableByConsent.some(
          (contact) => contact.consentStatus === criteria.consentRequirement,
        );
      const contactabilityMatches =
        criteria.contactabilityRequirement === "any" ||
        contactableByConsent.some(
          (contact) => contact.contactabilityStatus === criteria.contactabilityRequirement,
        );
      const combinedPolicyMatches = contactableByConsent.some(
        (contact) =>
          (criteria.consentRequirement === "any" ||
            contact.consentStatus === criteria.consentRequirement) &&
          (criteria.contactabilityRequirement === "any" ||
            contact.contactabilityStatus === criteria.contactabilityRequirement),
      );
      if (!consentMatches) {
        reasons.push("excluded_consent");
      }
      if (!contactabilityMatches) {
        reasons.push("excluded_contactability");
      }
      if (consentMatches && contactabilityMatches && !combinedPolicyMatches) {
        reasons.push("excluded_contact_policy_combination");
      }
    }
  }

  if (criteria.priorRegistrationEventId) {
    const matches = candidate.priorRegistrations.some(
      (registration) =>
        registration.eventId === criteria.priorRegistrationEventId &&
        (criteria.priorRegistrationPaymentStatus === "any" || registration.paymentStatus === "paid"),
    );
    if (!matches) reasons.push("excluded_prior_registration");
  }

  return reasons;
}

function inclusionWarnings(
  candidate: AudienceSegmentCandidate,
  criteria: AudienceSegmentCriteria,
): AudienceSegmentReasonCode[] {
  if (!criteria.contactChannel) return [];
  const matching = candidate.contacts.filter((contact) => contact.channel === criteria.contactChannel);
  const warnings: AudienceSegmentReasonCode[] = [];
  if (
    criteria.consentRequirement === "any" &&
    matching.length > 0 &&
    !matching.some((contact) => contact.consentStatus === "opted_in") &&
    matching.some((contact) => contact.consentStatus === "unknown")
  ) {
    warnings.push("included_consent_unknown");
  }
  if (
    criteria.contactabilityRequirement === "any" &&
    matching.length > 0 &&
    !matching.some((contact) => contact.contactabilityStatus === "reachable") &&
    matching.some((contact) => contact.contactabilityStatus === "unknown")
  ) {
    warnings.push("included_contactability_unknown");
  }
  return warnings;
}

export function evaluateAudienceSegment(options: {
  candidates: AudienceSegmentCandidate[];
  criteria: AudienceSegmentCriteria;
  overrides?: AudienceSegmentOverride[];
  requiredChannel?: TrustedAudienceChannel | null;
}): AudienceSegmentEvaluation[] {
  const overrideByPerson = new Map(
    (options.overrides ?? []).map((override) => [override.personId, override.decision] as const),
  );

  return [...options.candidates]
    .sort((left, right) => {
      const nameOrder = compareText(normalizedComparable(left.fullName) ?? "", normalizedComparable(right.fullName) ?? "");
      return nameOrder !== 0 ? nameOrder : compareText(left.personId, right.personId);
    })
    .map((candidate): AudienceSegmentEvaluation => {
      const overrideDecision = overrideByPerson.get(candidate.personId) ?? null;
      if (overrideDecision === "exclude") {
        return {
          personId: candidate.personId,
          fullName: candidate.fullName,
          included: false,
          reasonCodes: ["excluded_manual"],
          overrideDecision,
        };
      }
      if (candidate.suppressionStatus === "suppressed") {
        return {
          personId: candidate.personId,
          fullName: candidate.fullName,
          included: false,
          reasonCodes: ["excluded_suppressed"],
          overrideDecision,
        };
      }
      if (candidate.identityStatus === "review_required") {
        return {
          personId: candidate.personId,
          fullName: candidate.fullName,
          included: false,
          reasonCodes: ["excluded_identity_review_required"],
          overrideDecision,
        };
      }
      if (options.requiredChannel) {
        const hardReason = requiredChannelExclusion(candidate.contacts, options.requiredChannel);
        if (hardReason) {
          return {
            personId: candidate.personId,
            fullName: candidate.fullName,
            included: false,
            reasonCodes: [hardReason],
            overrideDecision,
          };
        }
      }

      const mismatchReasons = criteriaReasons(candidate, options.criteria);
      if (mismatchReasons.includes("excluded_contact_channel_opted_out")) {
        return {
          personId: candidate.personId,
          fullName: candidate.fullName,
          included: false,
          reasonCodes: ["excluded_contact_channel_opted_out"],
          overrideDecision,
        };
      }
      if (overrideDecision === "include") {
        return {
          personId: candidate.personId,
          fullName: candidate.fullName,
          included: true,
          reasonCodes: [mismatchReasons.length > 0 ? "included_manual_override" : "included_manual"],
          overrideDecision,
        };
      }
      if (mismatchReasons.length > 0) {
        return {
          personId: candidate.personId,
          fullName: candidate.fullName,
          included: false,
          reasonCodes: mismatchReasons,
          overrideDecision,
        };
      }

      const warnings = inclusionWarnings(candidate, options.criteria);
      return {
        personId: candidate.personId,
        fullName: candidate.fullName,
        included: true,
        reasonCodes: warnings.length > 0 ? warnings : ["included_criteria_match"],
        overrideDecision,
      };
    });
}

export function summarizeAudienceSegment(results: AudienceSegmentEvaluation[]) {
  return results.reduce(
    (summary, result) => {
      summary.total += 1;
      if (result.included) summary.included += 1;
      else summary.excluded += 1;
      return summary;
    },
    { total: 0, included: 0, excluded: 0 },
  );
}
