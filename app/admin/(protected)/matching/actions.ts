"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { validateAdminId } from "@/lib/admin/events";
import { requireAdminSession } from "@/lib/admin/session";
import {
  generateMatchingToken,
  hashMatchingToken,
  matchingParticipantPath,
} from "@/lib/matching/token";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function adminMatchingPath(eventId: string, result?: string): string {
  const query = result ? `?result=${encodeURIComponent(result)}` : "";
  return `/admin/matching/${eventId}${query}`;
}

function readId(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? validateAdminId(value) : null;
}

export async function issueMatchingTokenAction(formData: FormData) {
  const session = await requireAdminSession();
  const eventId = readId(formData, "event_id");
  const registrationId = readId(formData, "registration_id");
  if (!eventId || !registrationId) redirect("/admin");

  const token = generateMatchingToken();
  const { error } = await createSupabaseServerClient().rpc("issue_matching_participant_token", {
    p_event_id: eventId,
    p_registration_id: registrationId,
    p_token_hash: hashMatchingToken(token),
    p_issued_by: session.email,
    p_expires_at: null,
  });

  if (error) redirect(adminMatchingPath(eventId, "token_issue_failed"));
  revalidatePath(adminMatchingPath(eventId));
  redirect(matchingParticipantPath(token));
}

export async function revokeMatchingTokenAction(formData: FormData) {
  const session = await requireAdminSession();
  const eventId = readId(formData, "event_id");
  const tokenId = readId(formData, "token_id");
  if (!eventId || !tokenId) redirect("/admin");

  const { data, error } = await createSupabaseServerClient().rpc("revoke_matching_participant_token", {
    p_event_id: eventId,
    p_token_id: tokenId,
    p_revoked_by: session.email,
    p_reason: "operator_revoked",
  });

  revalidatePath(adminMatchingPath(eventId));
  redirect(adminMatchingPath(eventId, !error && data === true ? "token_revoked" : "token_revoke_failed"));
}
