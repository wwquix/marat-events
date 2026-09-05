import { newYorkLocalInputToUtc } from "@/lib/admin/events";

export type ValidationResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false }>;

function normalizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized && normalized.length <= maxLength ? normalized : null;
}

export function normalizePeopleSearch(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, 100).toLocaleLowerCase("en-US");
}

export function validatePersonNote(value: unknown): ValidationResult<string> {
  const note = normalizeText(value, 4_000);
  return note ? { ok: true, value: note } : { ok: false };
}

export type FollowUpTaskInput = Readonly<{
  title: string;
  details: string | null;
  dueAt: string | null;
  assignedTo: string | null;
}>;

export function validateFollowUpTask(input: {
  title: unknown;
  details: unknown;
  dueAt: unknown;
  assignedTo: unknown;
}): ValidationResult<FollowUpTaskInput> {
  const title = normalizeText(input.title, 200);
  if (!title) return { ok: false };

  const details = typeof input.details === "string" && input.details.trim()
    ? input.details.trim().slice(0, 2_001)
    : null;
  if (details && details.length > 2_000) return { ok: false };

  const assignedTo = typeof input.assignedTo === "string" && input.assignedTo.trim()
    ? normalizeText(input.assignedTo, 254)
    : null;
  if (typeof input.assignedTo === "string" && input.assignedTo.trim() && !assignedTo) return { ok: false };

  let dueAt: string | null = null;
  if (typeof input.dueAt === "string" && input.dueAt.trim()) {
    dueAt = newYorkLocalInputToUtc(input.dueAt.trim());
    if (!dueAt) return { ok: false };
  }

  return { ok: true, value: { title, details, dueAt, assignedTo } };
}

export type PersonTagInput = Readonly<{ name: string; normalizedName: string }>;

export function validatePersonTag(value: unknown): ValidationResult<PersonTagInput> {
  const name = normalizeText(value, 60);
  if (!name) return { ok: false };
  const normalizedName = name.normalize("NFKC").toLocaleLowerCase("en-US");
  if (!/^[a-z0-9][a-z0-9 _-]*$/.test(normalizedName)) return { ok: false };
  return { ok: true, value: { name, normalizedName } };
}

export function validateSuppressionReason(value: unknown): ValidationResult<string> {
  const reason = normalizeText(value, 500);
  return reason ? { ok: true, value: reason } : { ok: false };
}
