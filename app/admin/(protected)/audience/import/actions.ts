"use server";

import { createHash } from "node:crypto";
import { redirect } from "next/navigation";

import {
  commitImport,
  identityKey,
  normalizePhone,
  validateImport,
  type AudienceImportCommitResult,
  type ExistingIdentityIndex,
  type TrustedIdentityChannel,
} from "@/lib/audience/import";
import { validateAdminId } from "@/lib/admin/events";
import { requireAdminSession } from "@/lib/admin/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const IDENTITY_CHANNELS: TrustedIdentityChannel[] = ["email", "phone"];
const PAGE_SIZE = 1000;

type PersonIdentityRow = { id: string; email: string | null; phone: string | null };
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
      .select("id,email,phone")
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
    const phone = normalizePhone(person.phone ?? undefined);
    if (phone) {
      addIdentity(index, identityKey("phone", phone.normalized), person.id);
    }
  }

  for (const contact of contacts) {
    if (!IDENTITY_CHANNELS.includes(contact.channel as TrustedIdentityChannel)) continue;
    addIdentity(
      index,
      identityKey(contact.channel as TrustedIdentityChannel, contact.normalized_value),
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

  let csvText: string;
  let fileSha256: string;
  let preview: ReturnType<typeof validateImport>;
  let existingIdentities: ExistingIdentityIndex;

  try {
    existingIdentities = await buildExistingIdentityIndex();
  } catch {
    redirect(importHomePath("database"));
  }

  try {
    const bytes = Buffer.from(await upload.arrayBuffer());
    csvText = bytes.toString("utf8");
    fileSha256 = createHash("sha256").update(bytes).digest("hex");
    preview = validateImport(csvText, existingIdentities);
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
      row_count: preview.rows.length,
      created_by: session.email,
      file_sha256: fileSha256,
    })
    .select("id")
    .single();

  if (batchError || !batch || typeof batch.id !== "string") {
    redirect(importHomePath("database"));
  }

  const batchId = batch.id;
  const databaseRows = preview.rows.map((row) => ({
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

function parseCommitResult(value: unknown): AudienceImportCommitResult {
  if (!value || typeof value !== "object") throw new Error("Invalid audience import commit result.");
  const result = value as Record<string, unknown>;
  if (
    typeof result.batchId !== "string" ||
    typeof result.alreadyCommitted !== "boolean" ||
    typeof result.createdPeople !== "number" ||
    typeof result.reusedPeople !== "number" ||
    typeof result.reviewRows !== "number"
  ) {
    throw new Error("Invalid audience import commit result.");
  }

  return {
    batchId: result.batchId,
    alreadyCommitted: result.alreadyCommitted,
    createdPeople: result.createdPeople,
    reusedPeople: result.reusedPeople,
    reviewRows: result.reviewRows,
  };
}

export async function commitAudienceImportAction(formData: FormData) {
  await requireAdminSession();
  const batchId = validateAdminId(formData.get("batch_id"));
  const confirmed = formData.get("confirmed") === "yes";
  if (!batchId || !confirmed) redirect(importHomePath("invalid"));

  let result: AudienceImportCommitResult;
  try {
    result = await commitImport(
      {
        async commitBatch(id) {
          const { data, error } = await createSupabaseServerClient().rpc("commit_audience_import", {
            p_batch_id: id,
          });
          if (error) throw new Error("Unable to commit audience import.");
          return parseCommitResult(data);
        },
      },
      { batchId, confirmed: true },
    );
  } catch {
    redirect(`/admin/audience/import/${batchId}?error=commit`);
  }

  const params = new URLSearchParams({
    committed: result.alreadyCommitted ? "existing" : "yes",
    created: String(result.createdPeople),
    reused: String(result.reusedPeople),
    review: String(result.reviewRows),
  });
  redirect(`/admin/audience/import/${result.batchId}?${params.toString()}`);
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
