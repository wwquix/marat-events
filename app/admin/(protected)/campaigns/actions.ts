"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { validateAdminId } from "@/lib/admin/events";
import { requireAdminSession } from "@/lib/admin/session";
import { normalizeTemplateVariables, renderTemplate } from "@/lib/campaigns/template";
import { DisabledOutboundAdapter, DryRunOutboundAdapter } from "@/lib/outbound/adapters";
import { parseClaimedOutboxRows, type ClaimedOutboxWork } from "@/lib/outbound/claim";
import { dispatchOutboxMessage } from "@/lib/outbound/dispatcher";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const TEMPLATE_CHANNELS = new Set(["email", "sms", "whatsapp", "telegram", "instagram"]);
const RUNTIME_VARIABLES = new Set(["full_name", "event_title", "event_date", "event_time", "venue"]);

function campaignsPath(error?: string, saved?: string): string {
  const params = new URLSearchParams();
  if (error) params.set("error", error);
  if (saved) params.set("saved", saved);
  const query = params.toString();
  return query ? `/admin/campaigns?${query}` : "/admin/campaigns";
}

function campaignPath(id: string, error?: string, saved?: string): string {
  const params = new URLSearchParams();
  if (error) params.set("error", error);
  if (saved) params.set("saved", saved);
  const query = params.toString();
  return query ? `/admin/campaigns/${id}?${query}` : `/admin/campaigns/${id}`;
}

function readText(formData: FormData, key: string, maxLength: number): string | null {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

function readOptionalText(formData: FormData, key: string, maxLength: number): string | null | undefined {
  const value = formData.get(key);
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? (text.length <= maxLength ? text : undefined) : null;
}

function readWeekdays(value: FormDataEntryValue | null): number[] | null {
  if (typeof value !== "string") return null;
  const parts = value.split(",").map((day) => day.trim());
  if (parts.length === 0 || parts.some((day) => !/^\d$/.test(day))) return null;
  const days = parts.map(Number);
  const unique = [...new Set(days)].sort((left, right) => left - right);
  return unique.length === days.length && unique.length > 0 && unique.length <= 7 && unique.every((day) => day <= 6)
    ? unique
    : null;
}

function readTime(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
}

function resultId(data: unknown, key: string): string | null {
  if (!data || typeof data !== "object") return null;
  return validateAdminId((data as Record<string, unknown>)[key]);
}

export async function createMessageTemplateVersionAction(formData: FormData) {
  const session = await requireAdminSession();
  const requestId = validateAdminId(formData.get("request_id"));
  const templateKey = readText(formData, "template_key", 120);
  const name = readText(formData, "name", 160);
  const channel = readText(formData, "channel", 30);
  const subject = readOptionalText(formData, "subject_template", 500);
  const body = readText(formData, "body_template", 10_000);
  const variableText = readOptionalText(formData, "variables", 1_000);

  let variables: string[] | null = null;
  if (typeof variableText === "string") {
    try {
      variables = normalizeTemplateVariables(variableText.split(","));
    } catch {
      variables = null;
    }
  } else if (variableText === null) {
    variables = [];
  }

  const validChannel = channel !== null && TEMPLATE_CHANNELS.has(channel);
  const supportedVariables = variables?.every((variable) => RUNTIME_VARIABLES.has(variable)) ?? false;
  const validSubject = validChannel && (channel === "email" ? typeof subject === "string" : subject === null);

  if (
    !requestId ||
    !templateKey ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(templateKey) ||
    !name ||
    !channel ||
    !validChannel ||
    subject === undefined ||
    !validSubject ||
    !body ||
    !variables ||
    !supportedVariables
  ) {
    redirect(campaignsPath("invalid_template"));
  }

  try {
    const dummyValues = Object.fromEntries(variables.map((variable) => [variable, variable]));
    renderTemplate({ subject, body, variables }, dummyValues);
  } catch {
    redirect(campaignsPath("invalid_template"));
  }

  const { error } = await createSupabaseServerClient().rpc("create_message_template_version", {
    p_request_id: requestId,
    p_template_key: templateKey,
    p_name: name,
    p_channel: channel,
    p_subject_template: subject,
    p_body_template: body,
    p_variables: variables,
    p_created_by: session.email,
  });

  if (error) redirect(campaignsPath("template_blocked"));
  revalidatePath("/admin/campaigns");
  redirect(campaignsPath(undefined, "template_created"));
}

export async function createCampaignPreviewAction(formData: FormData) {
  const session = await requireAdminSession();
  const requestId = validateAdminId(formData.get("request_id"));
  const selectionId = validateAdminId(formData.get("selection_id"));
  const templateVersionId = validateAdminId(formData.get("template_version_id"));
  const name = readText(formData, "name", 160);
  const deliveryMode = readText(formData, "delivery_mode", 20);
  const windowStart = readTime(formData.get("sending_window_start"));
  const windowEnd = readTime(formData.get("sending_window_end"));
  const weekdays = readWeekdays(formData.get("allowed_weekdays"));

  if (
    !requestId ||
    !selectionId ||
    !templateVersionId ||
    !name ||
    (deliveryMode !== "disabled" && deliveryMode !== "dry_run") ||
    !windowStart ||
    !windowEnd ||
    !weekdays
  ) {
    redirect(campaignsPath("invalid_campaign"));
  }

  const { data, error } = await createSupabaseServerClient().rpc("create_campaign_preview", {
    p_request_id: requestId,
    p_selection_id: selectionId,
    p_template_version_id: templateVersionId,
    p_name: name,
    p_delivery_mode: deliveryMode,
    p_scheduled_at: new Date().toISOString(),
    p_sending_window_start: windowStart,
    p_sending_window_end: windowEnd,
    p_allowed_weekdays: weekdays,
    p_created_by: session.email,
  });

  const campaignId = resultId(data, "campaign_id");
  if (error || !campaignId) redirect(campaignsPath("campaign_blocked"));
  revalidatePath("/admin/campaigns");
  redirect(campaignPath(campaignId, undefined, "preview_created"));
}

export async function queueCampaignOutboxAction(formData: FormData) {
  const session = await requireAdminSession();
  const campaignId = validateAdminId(formData.get("campaign_id"));
  if (!campaignId) redirect(campaignsPath("invalid_campaign"));

  const { error } = await createSupabaseServerClient().rpc("queue_campaign_outbox", {
    p_campaign_id: campaignId,
    p_queued_by: session.email,
  });

  if (error) redirect(campaignPath(campaignId, "queue_blocked"));
  revalidatePath("/admin/campaigns");
  revalidatePath("/admin/outbox");
  redirect(campaignPath(campaignId, undefined, "queued"));
}

export async function dispatchCampaignBatchAction(formData: FormData) {
  const session = await requireAdminSession();
  const campaignId = validateAdminId(formData.get("campaign_id"));
  if (!campaignId) redirect(campaignsPath("invalid_campaign"));

  const workerId = `admin-foundation:${session.email}`;
  const now = new Date();
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc("claim_campaign_outbox", {
    p_campaign_id: campaignId,
    p_worker_id: workerId,
    p_limit: 50,
    p_now: now.toISOString(),
  });

  if (error) redirect(campaignPath(campaignId, "dispatch_blocked"));

  let claimed: ClaimedOutboxWork[];
  try {
    claimed = parseClaimedOutboxRows(data);
  } catch {
    redirect(campaignPath(campaignId, "dispatch_blocked"));
  }

  for (const work of claimed) {
    const adapter = work.mode === "dry_run" ? new DryRunOutboundAdapter() : new DisabledOutboundAdapter();
    const completedAt = new Date();
    const outcome = await dispatchOutboxMessage(work.message, adapter, completedAt, work.sendingWindow);
    const { error: recordError } = await supabase.rpc("record_outbox_attempt", {
      p_message_id: work.message.id,
      p_worker_id: workerId,
      p_outcome: outcome.state,
      p_result_code: outcome.code,
      p_available_at: outcome.availableAt,
      p_operator_identity: session.email,
      p_completed_at: completedAt.toISOString(),
    });
    if (recordError) redirect(campaignPath(campaignId, "dispatch_blocked"));
  }

  revalidatePath("/admin/campaigns");
  revalidatePath(`/admin/campaigns/${campaignId}`);
  revalidatePath("/admin/outbox");
  redirect(campaignPath(campaignId, undefined, claimed.length === 0 ? "no_due_work" : "batch_processed"));
}
