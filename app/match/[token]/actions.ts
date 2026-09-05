"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isMatchingLikeOutcome } from "@/lib/matching/policy";
import { isMatchingPublicId } from "@/lib/matching/state";
import {
  hashMatchingToken,
  matchingParticipantPath,
  normalizeMatchingToken,
} from "@/lib/matching/token";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function resultPath(token: string, result: string): string {
  const params = new URLSearchParams({ result });
  return `${matchingParticipantPath(token)}?${params.toString()}`;
}

function readToken(formData: FormData): string | null {
  const value = formData.get("token");
  return typeof value === "string" ? normalizeMatchingToken(value) : null;
}

function readText(formData: FormData, name: string, maxLength: number): string | null {
  const value = formData.get(name);
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= maxLength ? normalized : null;
}

function readOptionalText(formData: FormData, name: string, maxLength: number): string | null | undefined {
  const value = formData.get(name);
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.length <= maxLength ? normalized : undefined;
}

function rpcLikeOutcome(data: unknown): "liked" | "matched" | null {
  if (!Array.isArray(data)) return null;
  const first = data[0];
  if (!first || typeof first !== "object" || !("outcome" in first)) return null;
  return isMatchingLikeOutcome(first.outcome) ? first.outcome : null;
}

export async function activateMatchingParticipantAction(formData: FormData) {
  const token = readToken(formData);
  const displayName = readText(formData, "display_name", 80);
  const bio = readOptionalText(formData, "bio", 500);
  if (!token) redirect("/");
  if (!displayName || bio === undefined) redirect(resultPath(token, "activation_invalid"));

  const tokenHash = hashMatchingToken(token);
  const { error } = await createSupabaseServerClient().rpc("activate_matching_participant", {
    p_token_hash: tokenHash,
    p_display_name: displayName,
    p_bio: bio,
  });

  if (error) redirect(resultPath(token, "activation_failed"));
  revalidatePath(matchingParticipantPath(token));
  redirect(resultPath(token, "activated"));
}

export async function likeMatchingParticipantAction(formData: FormData) {
  const token = readToken(formData);
  const targetPublicId = formData.get("target_public_id");
  if (!token) redirect("/");
  if (!isMatchingPublicId(targetPublicId)) redirect(resultPath(token, "like_invalid"));

  const tokenHash = hashMatchingToken(token);
  const { data, error } = await createSupabaseServerClient().rpc("record_matching_like", {
    p_token_hash: tokenHash,
    p_liked_public_id: targetPublicId,
  });
  const outcome = error ? null : rpcLikeOutcome(data);

  revalidatePath(matchingParticipantPath(token));
  redirect(resultPath(token, outcome ?? "like_failed"));
}
