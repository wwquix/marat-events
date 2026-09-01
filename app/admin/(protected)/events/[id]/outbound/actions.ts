"use server";

import { redirect } from "next/navigation";

import { validateAdminId } from "@/lib/admin/events";
import { requireAdminSession } from "@/lib/admin/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function outboundPath(eventId: string, result: string, campaignId?: string, dryRunId?: string): string {
  const params = new URLSearchParams({ result });
  if (campaignId) params.set("campaign", campaignId);
  if (dryRunId) params.set("run", dryRunId);
  return `/admin/events/${eventId}/outbound?${params.toString()}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseDryRunResponse(value: unknown): { dryRunId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (!UUID_PATTERN.test(String(result.dry_run_id))) return null;
  for (const key of ["total_count", "allowed_count", "blocked_count", "delayed_count", "already_queued_count"]) {
    if (typeof result[key] !== "number" || !Number.isSafeInteger(result[key]) || result[key] < 0) return null;
  }
  return { dryRunId: String(result.dry_run_id) };
}

async function campaignMutation(formData: FormData, rpc: "create_outbound_dry_run" | "enqueue_invitation_campaign") {
  const session = await requireAdminSession();
  const eventId = validateAdminId(formData.get("event_id"));
  const campaignId = validateAdminId(formData.get("campaign_id"));
  if (!eventId || !campaignId) redirect("/admin");
  const supabase = createSupabaseServerClient();
  const { data: campaign, error: campaignError } = await supabase
    .from("invitation_campaigns")
    .select("event_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignError || !campaign || campaign.event_id !== eventId) {
    redirect(outboundPath(eventId, "blocked", campaignId));
  }
  const { data, error } = await supabase.rpc(rpc, {
    p_campaign_id: campaignId,
    p_requested_by: session.email,
  });
  if (error) redirect(outboundPath(eventId, "blocked", campaignId));
  if (rpc === "create_outbound_dry_run") {
    const parsed = parseDryRunResponse(data);
    if (!parsed) redirect(outboundPath(eventId, "blocked", campaignId));
    redirect(outboundPath(eventId, "dry_run_created", campaignId, parsed.dryRunId));
  }
  redirect(outboundPath(eventId, "enqueued", campaignId));
}

export async function createOutboundDryRunAction(formData: FormData) {
  await campaignMutation(formData, "create_outbound_dry_run");
}

export async function enqueueInvitationCampaignAction(formData: FormData) {
  await campaignMutation(formData, "enqueue_invitation_campaign");
}
