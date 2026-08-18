"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { validateAdminId } from "@/lib/admin/events";
import { requireAdminSession } from "@/lib/admin/session";
import {
  validateFollowUpTask,
  validatePersonNote,
  validatePersonTag,
  validateSuppressionReason,
} from "@/lib/crm/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function personPath(personId: string, result?: string): string {
  const query = result ? `?result=${encodeURIComponent(result)}` : "";
  return `/admin/people/${personId}${query}`;
}

function readId(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? validateAdminId(value) : null;
}

function refreshPerson(personId: string): void {
  revalidatePath("/admin/people");
  revalidatePath(personPath(personId));
}

export async function createPersonNoteAction(formData: FormData) {
  const session = await requireAdminSession();
  const personId = readId(formData, "person_id");
  const note = validatePersonNote(formData.get("body"));
  if (!personId) redirect("/admin/people");
  if (!note.ok) redirect(personPath(personId, "invalid_note"));

  const { error } = await createSupabaseServerClient().from("person_notes").insert({
    person_id: personId,
    body: note.value,
    created_by: session.email,
  });

  refreshPerson(personId);
  redirect(personPath(personId, error ? "database_error" : "note_created"));
}

export async function createFollowUpTaskAction(formData: FormData) {
  const session = await requireAdminSession();
  const personId = readId(formData, "person_id");
  if (!personId) redirect("/admin/people");

  const task = validateFollowUpTask({
    title: formData.get("title"),
    details: formData.get("details"),
    dueAt: formData.get("due_at"),
    assignedTo: formData.get("assigned_to"),
  });
  if (!task.ok) redirect(personPath(personId, "invalid_task"));

  const { error } = await createSupabaseServerClient().from("follow_up_tasks").insert({
    person_id: personId,
    title: task.value.title,
    details: task.value.details,
    due_at: task.value.dueAt,
    assigned_to: task.value.assignedTo,
    created_by: session.email,
  });

  refreshPerson(personId);
  redirect(personPath(personId, error ? "database_error" : "task_created"));
}

export async function setFollowUpTaskStatusAction(formData: FormData) {
  const session = await requireAdminSession();
  const personId = readId(formData, "person_id");
  const taskId = readId(formData, "task_id");
  const rawStatus = formData.get("status");
  const status = rawStatus === "completed" || rawStatus === "cancelled" ? rawStatus : null;
  if (!personId || !taskId || !status) redirect("/admin/people");

  const { error } = await createSupabaseServerClient().rpc("set_follow_up_task_status", {
    p_task_id: taskId,
    p_status: status,
    p_changed_by: session.email,
  });

  refreshPerson(personId);
  redirect(personPath(personId, error ? "database_error" : `task_${status}`));
}

export async function assignPersonTagAction(formData: FormData) {
  const session = await requireAdminSession();
  const personId = readId(formData, "person_id");
  const tag = validatePersonTag(formData.get("tag"));
  if (!personId) redirect("/admin/people");
  if (!tag.ok) redirect(personPath(personId, "invalid_tag"));

  const supabase = createSupabaseServerClient();
  let tagId: string | null = null;
  const existing = await supabase
    .from("person_tags")
    .select("id")
    .eq("normalized_name", tag.value.normalizedName)
    .maybeSingle();

  if (!existing.error && existing.data && validateAdminId(existing.data.id)) {
    tagId = existing.data.id;
  } else if (!existing.error) {
    const inserted = await supabase
      .from("person_tags")
      .insert({
        name: tag.value.name,
        normalized_name: tag.value.normalizedName,
        created_by: session.email,
      })
      .select("id")
      .single();

    if (!inserted.error && inserted.data && validateAdminId(inserted.data.id)) {
      tagId = inserted.data.id;
    } else if (inserted.error?.code === "23505") {
      const concurrent = await supabase
        .from("person_tags")
        .select("id")
        .eq("normalized_name", tag.value.normalizedName)
        .maybeSingle();
      tagId = !concurrent.error && concurrent.data && validateAdminId(concurrent.data.id)
        ? concurrent.data.id
        : null;
    }
  }

  if (!tagId) redirect(personPath(personId, "database_error"));
  const { error } = await supabase.from("person_tag_assignments").upsert(
    { person_id: personId, tag_id: tagId, assigned_by: session.email },
    { onConflict: "person_id,tag_id", ignoreDuplicates: true },
  );

  refreshPerson(personId);
  redirect(personPath(personId, error ? "database_error" : "tag_assigned"));
}

export async function removePersonTagAction(formData: FormData) {
  await requireAdminSession();
  const personId = readId(formData, "person_id");
  const tagId = readId(formData, "tag_id");
  if (!personId || !tagId) redirect("/admin/people");

  const { error } = await createSupabaseServerClient()
    .from("person_tag_assignments")
    .delete()
    .eq("person_id", personId)
    .eq("tag_id", tagId);

  refreshPerson(personId);
  redirect(personPath(personId, error ? "database_error" : "tag_removed"));
}

export async function setPersonSuppressionAction(formData: FormData) {
  const session = await requireAdminSession();
  const personId = readId(formData, "person_id");
  const rawStatus = formData.get("status");
  const status = rawStatus === "active" || rawStatus === "suppressed" ? rawStatus : null;
  const reason = validateSuppressionReason(formData.get("reason"));
  if (!personId || !status) redirect("/admin/people");
  if (!reason.ok) redirect(personPath(personId, "invalid_suppression"));

  const { error } = await createSupabaseServerClient().rpc("set_person_suppression", {
    p_person_id: personId,
    p_status: status,
    p_reason: reason.value,
    p_changed_by: session.email,
  });

  refreshPerson(personId);
  redirect(personPath(personId, error ? "database_error" : "suppression_updated"));
}
