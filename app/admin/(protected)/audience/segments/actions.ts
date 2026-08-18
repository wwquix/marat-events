"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdminSession } from "@/lib/admin/session";
import {
  criteriaFromSegmentRow,
  validateAudienceSegmentCriteria,
  type AudienceSegmentCriteria,
  type AudienceSelectionStatus,
  type TrustedAudienceChannel,
} from "@/lib/audience/segments";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readId(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

function readText(value: FormDataEntryValue | null, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function readDescription(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || value.length > 2_000) return null;
  return value.trim();
}

function readVersion(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

function readCriteria(formData: FormData) {
  return validateAudienceSegmentCriteria({
    gender: formData.get("gender"),
    city: formData.get("city"),
    source: formData.get("source"),
    importBatchId: formData.get("import_batch_id"),
    contactChannel: formData.get("contact_channel"),
    consentRequirement: formData.get("consent_requirement"),
    contactabilityRequirement: formData.get("contactability_requirement"),
    priorRegistrationEventId: formData.get("prior_registration_event_id"),
    priorRegistrationPaymentStatus: formData.get("prior_registration_payment_status"),
  });
}

function criteriaColumns(criteria: AudienceSegmentCriteria) {
  return {
    gender: criteria.gender,
    city: criteria.city,
    source: criteria.source,
    import_batch_id: criteria.importBatchId,
    contact_channel: criteria.contactChannel,
    consent_requirement: criteria.consentRequirement,
    contactability_requirement: criteria.contactabilityRequirement,
    prior_registration_event_id: criteria.priorRegistrationEventId,
    prior_registration_payment_status: criteria.priorRegistrationPaymentStatus,
  };
}

function selectionSnapshotColumns(criteria: AudienceSegmentCriteria) {
  return {
    snapshot_gender: criteria.gender,
    snapshot_city: criteria.city,
    snapshot_source: criteria.source,
    snapshot_import_batch_id: criteria.importBatchId,
    snapshot_contact_channel: criteria.contactChannel,
    snapshot_consent_requirement: criteria.consentRequirement,
    snapshot_contactability_requirement: criteria.contactabilityRequirement,
    snapshot_prior_registration_event_id: criteria.priorRegistrationEventId,
    snapshot_prior_registration_payment_status: criteria.priorRegistrationPaymentStatus,
  };
}

function segmentPath(segmentId: string, params?: Record<string, string>): string {
  const query = new URLSearchParams(params);
  return `/admin/audience/segments/${segmentId}${query.size > 0 ? `?${query}` : ""}`;
}

function selectionPath(selectionId: string, params?: Record<string, string>): string {
  const query = new URLSearchParams(params);
  return `/admin/audience/segments/selections/${selectionId}${query.size > 0 ? `?${query}` : ""}`;
}

export async function createAudienceSegmentAction(formData: FormData) {
  const session = await requireAdminSession();
  const name = readText(formData.get("name"), 160);
  const description = readDescription(formData.get("description"));
  const criteria = readCriteria(formData);
  if (!name || description === null || !criteria.ok) {
    redirect("/admin/audience/segments/new?error=invalid");
  }

  const { data, error } = await createSupabaseServerClient()
    .from("audience_segments")
    .insert({
      name,
      description,
      ...criteriaColumns(criteria.value),
      created_by: session.email,
      updated_by: session.email,
    })
    .select("id")
    .single();
  if (error || !data || typeof data.id !== "string") {
    redirect(`/admin/audience/segments/new?error=${error?.code === "23505" ? "name_exists" : "database"}`);
  }

  revalidatePath("/admin/audience/segments");
  redirect(segmentPath(data.id, { saved: "created" }));
}

export async function updateAudienceSegmentAction(formData: FormData) {
  const session = await requireAdminSession();
  const segmentId = readId(formData.get("segment_id"));
  const version = readVersion(formData.get("version"));
  const name = readText(formData.get("name"), 160);
  const description = readDescription(formData.get("description"));
  const criteria = readCriteria(formData);
  if (!segmentId || !version || !name || description === null || !criteria.ok) {
    redirect(segmentId ? segmentPath(segmentId, { error: "invalid" }) : "/admin/audience/segments?error=invalid");
  }

  const { data, error } = await createSupabaseServerClient()
    .from("audience_segments")
    .update({
      name,
      description,
      ...criteriaColumns(criteria.value),
      version: version + 1,
      updated_by: session.email,
      updated_at: new Date().toISOString(),
    })
    .eq("id", segmentId)
    .eq("version", version)
    .select("id")
    .maybeSingle();
  if (error || !data) {
    redirect(
      segmentPath(segmentId, {
        error: error?.code === "23505" ? "name_exists" : error ? "database" : "stale",
      }),
    );
  }

  revalidatePath("/admin/audience/segments");
  revalidatePath(segmentPath(segmentId));
  redirect(segmentPath(segmentId, { saved: "updated" }));
}

export async function createEventAudienceSelectionAction(formData: FormData) {
  const session = await requireAdminSession();
  const segmentId = readId(formData.get("segment_id"));
  const eventId = readId(formData.get("event_id"));
  const name = readText(formData.get("name"), 160);
  const requiredChannel = formData.get("required_channel");
  if (
    !segmentId ||
    !eventId ||
    !name ||
    typeof requiredChannel !== "string" ||
    !(["email", "phone", "sms", "instagram", "linkedin", "whatsapp", "telegram"] as const).includes(
      requiredChannel as TrustedAudienceChannel,
    )
  ) {
    redirect(segmentId ? `${segmentPath(segmentId)}/preview?error=invalid` : "/admin/audience/segments?error=invalid");
  }

  const supabase = createSupabaseServerClient();
  const { data: segment, error: segmentError } = await supabase
    .from("audience_segments")
    .select(
      "id,version,gender,city,source,import_batch_id,contact_channel,consent_requirement,contactability_requirement,prior_registration_event_id,prior_registration_payment_status",
    )
    .eq("id", segmentId)
    .maybeSingle();
  const criteria = segment ? criteriaFromSegmentRow(segment) : { ok: false as const, issues: ["missing"] };
  if (segmentError || !segment || !criteria.ok || typeof segment.version !== "number") {
    redirect(`${segmentPath(segmentId)}/preview?error=database`);
  }

  const { data, error } = await supabase
    .from("event_audience_selections")
    .insert({
      event_id: eventId,
      segment_id: segmentId,
      name,
      segment_version: segment.version,
      ...selectionSnapshotColumns(criteria.value),
      required_channel: requiredChannel,
      status: "draft",
      created_by: session.email,
      updated_by: session.email,
    })
    .select("id")
    .single();
  if (error || !data || typeof data.id !== "string") {
    redirect(
      `${segmentPath(segmentId)}/preview?error=${error?.code === "23505" ? "selection_exists" : "database"}`,
    );
  }

  revalidatePath("/admin/audience/segments");
  redirect(selectionPath(data.id, { saved: "created" }));
}

export async function updateEventAudienceSelectionAction(formData: FormData) {
  const session = await requireAdminSession();
  const selectionId = readId(formData.get("selection_id"));
  const name = readText(formData.get("name"), 160);
  const requiredChannel = formData.get("required_channel");
  const status = formData.get("status");
  if (
    !selectionId ||
    !name ||
    typeof requiredChannel !== "string" ||
    !(["email", "phone", "sms", "instagram", "linkedin", "whatsapp", "telegram"] as const).includes(
      requiredChannel as TrustedAudienceChannel,
    ) ||
    (status !== "draft" && status !== "archived")
  ) {
    redirect(selectionId ? selectionPath(selectionId, { error: "invalid" }) : "/admin/audience/segments?error=invalid");
  }

  const { data, error } = await createSupabaseServerClient()
    .from("event_audience_selections")
    .update({
      name,
      required_channel: requiredChannel,
      status: status as AudienceSelectionStatus,
      updated_by: session.email,
      updated_at: new Date().toISOString(),
    })
    .eq("id", selectionId)
    .select("id")
    .maybeSingle();
  if (error || !data) {
    redirect(selectionPath(selectionId, { error: error?.code === "23505" ? "name_exists" : "database" }));
  }

  revalidatePath("/admin/audience/segments");
  revalidatePath(selectionPath(selectionId));
  redirect(selectionPath(selectionId, { saved: "updated" }));
}

export async function setEventAudienceSelectionOverrideAction(formData: FormData) {
  const session = await requireAdminSession();
  const selectionId = readId(formData.get("selection_id"));
  const personId = readId(formData.get("person_id"));
  const decision = formData.get("decision");
  const noteValue = formData.get("note");
  const note = typeof noteValue === "string" && noteValue.length <= 1_000 ? noteValue.trim() : null;
  if (
    !selectionId ||
    !personId ||
    note === null ||
    (decision !== "include" && decision !== "exclude" && decision !== "clear")
  ) {
    redirect(selectionId ? selectionPath(selectionId, { error: "invalid_override" }) : "/admin/audience/segments");
  }

  const supabase = createSupabaseServerClient();
  if (decision === "clear") {
    const { error } = await supabase
      .from("event_audience_selection_overrides")
      .delete()
      .eq("selection_id", selectionId)
      .eq("person_id", personId);
    if (error) redirect(selectionPath(selectionId, { error: "database" }));
  } else {
    const { data: existing, error: loadError } = await supabase
      .from("event_audience_selection_overrides")
      .select("id")
      .eq("selection_id", selectionId)
      .eq("person_id", personId)
      .maybeSingle();
    if (loadError) redirect(selectionPath(selectionId, { error: "database" }));

    const mutation = existing
      ? supabase
          .from("event_audience_selection_overrides")
          .update({ decision, note, updated_by: session.email, updated_at: new Date().toISOString() })
          .eq("id", existing.id)
      : supabase.from("event_audience_selection_overrides").insert({
          selection_id: selectionId,
          person_id: personId,
          decision,
          note,
          created_by: session.email,
          updated_by: session.email,
        });
    const { error } = await mutation;
    if (error) redirect(selectionPath(selectionId, { error: "database" }));
  }

  revalidatePath(selectionPath(selectionId));
  redirect(selectionPath(selectionId, { saved: "override" }));
}
