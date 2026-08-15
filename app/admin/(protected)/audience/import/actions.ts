"use server";

import { redirect } from "next/navigation";

import {
  classifyAudienceRows,
  csvRecords,
  identityKey,
  type ContactChannel,
  type ExistingIdentityIndex,
} from "@/lib/audience/import";
import { validateAdminId } from "@/lib/admin/events";
import { requireAdminSession } from "@/lib/admin/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const IDENTITY_CHANNELS: ContactChannel[] = ["email", "phone", "instagram", "linkedin"];
const PAGE_SIZE = 1000;

type PersonIdentityRow = { id: string; email: string | null };
type ContactIdentityRow = { person_id: string; channel: string; normalized_value: string };

function importHomePath(error?: string): string {
  return error ? `/admin/audience/import?error=${encodeURIComponent(error)}` : "/admin/audience/import";
}

function readShortText(formData: FormData, key: string, maxLength: number): string | null {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function readOptionalText(formData: FormData, key: string, maxLength: number): string | null | undefined {
  const value = formData.get(key);
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length <= maxLength ? normalized : undefined;
}

async function loadAllPeople(): Promise<PersonIdentityRow[]> {
  const supabase = createSupabaseServerClient();
  const rows: PersonIdentityRow[] = [];

  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("people")
      .select("id,email")
      .order("id", { ascending: true })
      .range(start, start + PAGE_SIZE - 1);

    if (error) throw new Error("Unable to load audience identities.");
    const page = (data ?? []) as PersonIdentityRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function loadAllIdentityContacts(): Promise<ContactIdentityRow[]> {
  const supabase = createSupabaseServerClient();
  const rows: ContactIdentityRow[] = [];

  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("person_contacts")
      .select("person_id,channel,normalized_value")
      .in("channel", IDENTITY_CHANNELS)
      .order("id", { ascending: true })
      .range(start, start + PAGE_SIZE - 1);

    if (error) throw new Error("Unable to load audience contacts.");
    const page = (data ?? []) as ContactIdentityRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function addIdentity(index: ExistingIdentityIndex, key: string, personId: string) {
  const ids = index.get(key) ?? new Set<string>();
  ids.add(personId);
  index.set(key, ids);
}

async function buildExistingIdentityIndex(): Promise<ExistingIdentityIndex> {
  const [people, contacts] = await Promise.all([loadAllPeople(), loadAllIdentityContacts()]);
  const index: ExistingIdentityIndex = new Map();

  for (const person of people) {
    if (person.email) {
      addIdentity(index, identityKey("email", person.email.trim().toLowerCase()), person.id);
    }
  }

  for (const contact of contacts) {
    if (!IDENTITY_CHANNELS.includes(contact.channel as ContactChannel)) continue;
    addIdentity(
      index,
      identityKey(contact.channel as ContactChannel, contact.normalized_value),
      contact.person_id,
    );
  }

  return index;
}

async function cleanupFailedBatch(batchId: string) {
  await createSupabaseServerClient().from("audience_import_batches").delete().eq("id", batchId);
}

export async function createAudienceImportPreviewAction(formData: FormData) {
  const session = await requireAdminSession();
  const sourceLabel = readShortText(formData, "source_label", 160);
  const sourceReference = readOptionalText(formData, "source_reference", 500);
  const upload = formData.get("file");

  if (!sourceLabel || sourceReference === undefined || !(upload instanceof File) || upload.size === 0) {
    redirect(importHomePath("invalid"));
  }

  let records: Record<string, string>[];
  let prepared: ReturnType<typeof classifyAudienceRows>;

  try {
    records = csvRecords(await upload.text());
    prepared = classifyAudienceRows(records, await buildExistingIdentityIndex());
  } catch {
    redirect(importHomePath("invalid_csv"));
  }

  const supabase = createSupabaseServerClient();
  const { data: batch, error: batchError } = await supabase
    .from("audience_import_batches")
    .insert({
      source_type: "csv",
      source_label: sourceLabel,
      source_reference: sourceReference,
      status: "preview",
      row_count: prepared.length,
      created_by: session.email,
    })
    .select("id")
    .single();

  if (batchError || !batch || typeof batch.id !== "string") {
    redirect(importHomePath("database"));
  }

  const batchId = batch.id;
  const databaseRows = prepared.map((row) => ({
    batch_id: batchId,
    row_number: row.rowNumber,
    raw_data: row.raw,
    normalized_data: row.normalized ?? {},
    decision: row.decision,
    candidate_person_ids: row.candidatePersonIds,
    errors: row.errors,
  }));

  for (let start = 0; start < databaseRows.length; start += 250) {
    const { error } = await supabase.from("audience_import_rows").insert(databaseRows.slice(start, start + 250));
    if (error) {
      await cleanupFailedBatch(batchId);
      redirect(importHomePath("database"));
    }
  }

  redirect(`/admin/audience/import/${batchId}`);
}

export async function discardAudienceImportPreviewAction(formData: FormData) {
  await requireAdminSession();
  const batchId = validateAdminId(formData.get("batch_id"));
  if (!batchId) redirect(importHomePath("invalid"));

  const { error } = await createSupabaseServerClient()
    .from("audience_import_batches")
    .delete()
    .eq("id", batchId)
    .eq("status", "preview");

  if (error) redirect(`/admin/audience/import/${batchId}?error=database`);
  redirect(importHomePath());
}
