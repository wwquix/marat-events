"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { validateAdminId } from "@/lib/admin/events";
import { requireAdminSession } from "@/lib/admin/session";
import { isCheckInOutcome, type CheckInOutcome } from "@/lib/checkin/policy";
import {
  checkInTicketPath,
  generateCheckInToken,
  hashCheckInToken,
  normalizeCheckInToken,
} from "@/lib/checkin/token";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function checkInAdminPath(eventId: string, result?: string): string {
  const query = result ? `?result=${encodeURIComponent(result)}` : "";
  return `/admin/check-in/${eventId}${query}`;
}

function readId(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? validateAdminId(value) : null;
}

function rpcOutcome(data: unknown): CheckInOutcome | null {
  if (!Array.isArray(data)) return null;
  const first = data[0];
  if (!first || typeof first !== "object" || !("outcome" in first)) return null;
  return isCheckInOutcome(first.outcome) ? first.outcome : null;
}

export async function issueCheckInTokenAction(formData: FormData) {
  const session = await requireAdminSession();
  const registrationId = readId(formData, "registration_id");
  const eventId = readId(formData, "event_id");
  if (!registrationId || !eventId) redirect("/admin");

  const token = generateCheckInToken();
  const { error } = await createSupabaseServerClient().rpc("issue_registration_check_in_token", {
    p_registration_id: registrationId,
    p_token_hash: hashCheckInToken(token),
    p_issued_by: session.email,
    p_expires_at: null,
  });

  if (error) redirect(checkInAdminPath(eventId, "token_issue_failed"));
  revalidatePath(checkInAdminPath(eventId));
  redirect(checkInTicketPath(token));
}

export async function processTokenCheckInAction(formData: FormData) {
  const session = await requireAdminSession();
  const eventId = readId(formData, "event_id");
  const rawToken = formData.get("token");
  if (!eventId) redirect("/admin");

  const token = typeof rawToken === "string" ? normalizeCheckInToken(rawToken) : null;
  if (!token) redirect(checkInAdminPath(eventId, "invalid_token"));

  const { data, error } = await createSupabaseServerClient().rpc("process_registration_check_in", {
    p_event_id: eventId,
    p_token_hash: hashCheckInToken(token),
    p_operator: session.email,
  });
  const outcome = error ? null : rpcOutcome(data);

  revalidatePath(checkInAdminPath(eventId));
  redirect(checkInAdminPath(eventId, outcome ?? "check_in_failed"));
}

export async function manualCheckInAction(formData: FormData) {
  const session = await requireAdminSession();
  const eventId = readId(formData, "event_id");
  const registrationId = readId(formData, "registration_id");
  if (!eventId || !registrationId) redirect("/admin");

  const { data, error } = await createSupabaseServerClient().rpc("manual_registration_check_in", {
    p_event_id: eventId,
    p_registration_id: registrationId,
    p_operator: session.email,
  });
  const outcome = error ? null : rpcOutcome(data);

  revalidatePath(checkInAdminPath(eventId));
  redirect(checkInAdminPath(eventId, outcome ?? "check_in_failed"));
}

export async function revokeCheckInTokenAction(formData: FormData) {
  const session = await requireAdminSession();
  const eventId = readId(formData, "event_id");
  const tokenId = readId(formData, "token_id");
  if (!eventId || !tokenId) redirect("/admin");

  const { data, error } = await createSupabaseServerClient().rpc("revoke_registration_check_in_token", {
    p_token_id: tokenId,
    p_revoked_by: session.email,
    p_reason: "operator_revoked",
  });

  revalidatePath(checkInAdminPath(eventId));
  redirect(checkInAdminPath(eventId, !error && data === true ? "token_revoked" : "token_revoke_failed"));
}
