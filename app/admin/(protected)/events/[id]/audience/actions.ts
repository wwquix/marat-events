"use server";

import { redirect } from "next/navigation";

import { validateAdminId } from "@/lib/admin/events";
import { requireAdminSession } from "@/lib/admin/session";
import {
  isUuid,
  normalizeSegmentFilter,
  parseSegmentContactChannel,
} from "@/lib/audience/segmentation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function audiencePath(eventId: string, result: string, campaignId?: string): string {
  const params = new URLSearchParams({ result });
  if (campaignId) params.set("campaign", campaignId);
  return `/admin/events/${eventId}/audience?${params.toString()}`;
}

function readText(formData: FormData, key: string, maxLength: number): string | null {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function readOptionalText(formData: FormData, key: string, maxLength: number): string | null | undefined {
  const value = formData.get(key);
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized || null : undefined;
}

function textValues(formData: FormData, key: string): string[] {
  return formData.getAll(key).filter((value): value is string => typeof value === "string");
}

export async function commitInvitationCampaignAction(formData: FormData) {
  const session = await requireAdminSession();
  const eventId = validateAdminId(formData.get("event_id"));
  if (!eventId) redirect("/admin");

  const rawSegmentId = formData.get("segment_id");
  const segmentId = typeof rawSegmentId === "string" && rawSegmentId.length > 0 ? validateAdminId(rawSegmentId) : null;
  const segmentName = readText(formData, "segment_name", 160);
  const segmentDescription = readOptionalText(formData, "segment_description", 1000);
  const campaignName = readText(formData, "campaign_name", 160);
  const targetChannel = parseSegmentContactChannel(formData.get("target_channel"));
  const filter = normalizeSegmentFilter({
    genders: textValues(formData, "genders"),
    cities: textValues(formData, "cities"),
    occupations: textValues(formData, "occupations"),
    educations: textValues(formData, "educations"),
    sources: textValues(formData, "sources"),
    sourceReferences: textValues(formData, "source_references"),
    importBatchIds: textValues(formData, "import_batch_ids"),
  });

  if (
    (typeof rawSegmentId === "string" && rawSegmentId.length > 0 && !segmentId) ||
    !segmentName ||
    segmentDescription === undefined ||
    !campaignName ||
    !targetChannel ||
    !filter
  ) {
    redirect(audiencePath(eventId, "invalid"));
  }

  const { data, error } = await createSupabaseServerClient().rpc("commit_invitation_campaign", {
    p_event_id: eventId,
    p_segment_id: segmentId,
    p_segment_name: segmentName,
    p_segment_description: segmentDescription,
    p_campaign_name: campaignName,
    p_target_channel: targetChannel,
    p_filter: filter,
    p_committed_by: session.email,
  });

  const result = data as { campaign_id?: unknown } | null;
  if (error || !result || !isUuid(result.campaign_id)) {
    redirect(audiencePath(eventId, "commit_blocked"));
  }

  redirect(audiencePath(eventId, "committed", result.campaign_id));
}
