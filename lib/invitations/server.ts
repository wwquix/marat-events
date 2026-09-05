import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { hashInvitationToken, parseInvitationToken } from "@/lib/invitations/token";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type IssuedCampaignInvitation = {
  status: "issued" | "already_issued";
  tokenId: string;
  campaignId: string;
  campaignRecipientId: string;
  eventId: string;
  expiresAt: string;
};

export type PendingRegistrationResult = {
  registrationId: string;
  attributed: boolean;
  campaignRecipientId: string | null;
};

type IssueCampaignInvitationInput = {
  requestId: string;
  campaignRecipientId: string;
  invitationToken: string;
  expiresAt: string;
  issuedBy: string;
};

type RevokeCampaignInvitationInput = {
  tokenId: string;
  revokedBy: string;
  reason: string;
};

type CreatePendingRegistrationInput = {
  eventId: string;
  personId: string;
  ticketTypeId: string;
  fullName: string;
  email: string;
  phone: string;
  age: number;
  gender: "male" | "female";
  amountCents: number;
  currency: string;
  invitationToken: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function parseIssuedCampaignInvitation(value: unknown): IssuedCampaignInvitation | null {
  const row = asRecord(value);
  if (
    !row ||
    (row.status !== "issued" && row.status !== "already_issued") ||
    !isUuid(row.token_id) ||
    !isUuid(row.campaign_id) ||
    !isUuid(row.campaign_recipient_id) ||
    !isUuid(row.event_id) ||
    typeof row.expires_at !== "string" ||
    Number.isNaN(Date.parse(row.expires_at))
  ) {
    return null;
  }

  return {
    status: row.status,
    tokenId: row.token_id,
    campaignId: row.campaign_id,
    campaignRecipientId: row.campaign_recipient_id,
    eventId: row.event_id,
    expiresAt: row.expires_at,
  };
}

function parsePendingRegistrationResult(value: unknown): PendingRegistrationResult | null {
  const row = asRecord(value);
  if (!row || !isUuid(row.registration_id) || typeof row.attributed !== "boolean") {
    return null;
  }

  if (row.attributed && !isUuid(row.campaign_recipient_id)) return null;
  if (!row.attributed && row.campaign_recipient_id !== null) return null;

  return {
    registrationId: row.registration_id,
    attributed: row.attributed,
    campaignRecipientId: row.campaign_recipient_id as string | null,
  };
}

export async function issueCampaignInvitation(
  supabase: SupabaseClient,
  input: IssueCampaignInvitationInput,
): Promise<IssuedCampaignInvitation> {
  const invitationToken = parseInvitationToken(input.invitationToken);
  if (!invitationToken) throw new Error("Invalid invitation token.");

  const { data, error } = await supabase.rpc("issue_campaign_invitation_token", {
    p_request_id: input.requestId,
    p_campaign_recipient_id: input.campaignRecipientId,
    p_token_hash: hashInvitationToken(invitationToken),
    p_expires_at: input.expiresAt,
    p_issued_by: input.issuedBy,
  });

  const result = error ? null : parseIssuedCampaignInvitation(data);
  if (!result) throw new Error("Unable to issue campaign invitation.");
  return result;
}

export async function revokeCampaignInvitation(
  supabase: SupabaseClient,
  input: RevokeCampaignInvitationInput,
): Promise<"revoked" | "already_revoked"> {
  const { data, error } = await supabase.rpc("revoke_campaign_invitation_token", {
    p_token_id: input.tokenId,
    p_revoked_by: input.revokedBy,
    p_reason: input.reason,
  });
  const row = error ? null : asRecord(data);

  if (
    !row ||
    (row.status !== "revoked" && row.status !== "already_revoked") ||
    !isUuid(row.token_id)
  ) {
    throw new Error("Unable to revoke campaign invitation.");
  }

  return row.status;
}

export async function createPendingRegistrationWithInvitation(
  supabase: SupabaseClient,
  input: CreatePendingRegistrationInput,
): Promise<PendingRegistrationResult> {
  const invitationToken = parseInvitationToken(input.invitationToken);
  const { data, error } = await supabase.rpc(
    "create_pending_registration_with_invitation",
    {
      p_event_id: input.eventId,
      p_person_id: input.personId,
      p_ticket_type_id: input.ticketTypeId,
      p_full_name: input.fullName,
      p_email: input.email,
      p_phone: input.phone,
      p_age: input.age,
      p_gender: input.gender,
      p_amount_cents: input.amountCents,
      p_currency: input.currency,
      p_invitation_token_hash: invitationToken
        ? hashInvitationToken(invitationToken)
        : null,
    },
  );

  const result = error ? null : parsePendingRegistrationResult(data);
  if (!result) throw new Error("Unable to create pending registration.");
  return result;
}
