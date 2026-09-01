export const OUTBOUND_DECISIONS = ["allowed", "delayed", "blocked"] as const;
export type OutboundDecision = (typeof OUTBOUND_DECISIONS)[number];

export type OutboundPolicyResult = {
  invitation_campaign_result_id: string;
  person_id: string;
  person_contact_id: string | null;
  channel: string;
  decision: OutboundDecision;
  decision_code: string;
  decision_reason: string;
  next_available_at: string | null;
};

export const OUTBOUND_DECISION_LABELS: Record<string, string> = {
  within_business_window: "Ready in the America/New_York business window",
  outside_business_window: "Scheduled for the next America/New_York business window",
  campaign_result_ineligible: "Campaign target is not eligible",
  person_suppressed: "Person is suppressed",
  identity_review_required: "Identity requires review",
  channel_not_opted_in: "Selected contact is not opted in",
  channel_not_reachable: "Selected contact is not reachable",
};

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function parseOutboundPolicyResult(value: unknown): OutboundPolicyResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.invitation_campaign_result_id !== "string" ||
    typeof row.person_id !== "string" ||
    !nullableString(row.person_contact_id) ||
    typeof row.channel !== "string" ||
    !OUTBOUND_DECISIONS.includes(row.decision as OutboundDecision) ||
    typeof row.decision_code !== "string" ||
    typeof row.decision_reason !== "string" ||
    !nullableString(row.next_available_at)
  ) return null;
  return row as OutboundPolicyResult;
}

export function outboundDecisionLabel(code: string): string {
  return OUTBOUND_DECISION_LABELS[code] ?? code.replaceAll("_", " ");
}
