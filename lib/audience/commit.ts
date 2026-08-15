export type ReviewResolutionAction = "reuse_person" | "new_person" | "exclude";

export type ImportPreviewDecision =
  | "new_person"
  | "reuse_person"
  | "review"
  | "invalid"
  | "committed";

export type ImportCommitRow = {
  id: string;
  previewDecision: ImportPreviewDecision;
  decision: ImportPreviewDecision;
  candidatePersonIds: string[];
  normalizedData: Record<string, unknown>;
  resolutionAction: ReviewResolutionAction | null;
  resolvedPersonId: string | null;
  committedPersonId?: string | null;
};

export type TrustedContact = {
  channel: "email" | "phone" | "instagram" | "linkedin";
  normalizedValue: string;
};

export type ImportCommitSummary = {
  total: number;
  newPeople: number;
  reusedPeople: number;
  unresolvedReview: number;
  resolvedReview: number;
  invalid: number;
  excluded: number;
  committed: number;
};

export type CommitPreflightResult =
  | { ok: true; idempotent: boolean }
  | {
      ok: false;
      reason:
        | "batch_not_preview"
        | "unresolved_review"
        | "invalid_reuse_target"
        | "missing_trusted_identifier"
        | "duplicate_new_person_identifier"
        | "stale_identity_conflict";
      rowId?: string;
    };

function isTrustedChannel(value: unknown): value is TrustedContact["channel"] {
  return value === "email" || value === "phone" || value === "instagram" || value === "linkedin";
}

export function trustedContacts(data: Record<string, unknown>): TrustedContact[] {
  if (!Array.isArray(data.contacts)) return [];

  return data.contacts.flatMap((value): TrustedContact[] => {
    if (!value || typeof value !== "object") return [];
    const channel = "channel" in value ? value.channel : null;
    const normalizedValue = "normalizedValue" in value ? value.normalizedValue : null;
    if (!isTrustedChannel(channel) || typeof normalizedValue !== "string" || !normalizedValue) return [];
    return [{ channel, normalizedValue }];
  });
}

export function trustedContactKey(contact: TrustedContact): string {
  return `${contact.channel}:${contact.normalizedValue}`;
}

export function effectiveImportAction(
  row: ImportCommitRow,
): "new_person" | "reuse_person" | "exclude" | "invalid" | "unresolved" | "committed" {
  if (row.decision === "committed") return "committed";
  if (row.previewDecision === "invalid") return "invalid";
  if (row.previewDecision === "new_person") return "new_person";
  if (row.previewDecision === "reuse_person") return "reuse_person";
  return row.resolutionAction ?? "unresolved";
}

export function summarizeImportRows(rows: ImportCommitRow[]): ImportCommitSummary {
  const summary: ImportCommitSummary = {
    total: rows.length,
    newPeople: 0,
    reusedPeople: 0,
    unresolvedReview: 0,
    resolvedReview: 0,
    invalid: 0,
    excluded: 0,
    committed: 0,
  };

  for (const row of rows) {
    const action = effectiveImportAction(row);
    const plannedAction =
      action === "committed"
        ? row.previewDecision === "review"
          ? row.resolutionAction
          : row.previewDecision
        : action;
    if (row.previewDecision === "review" && row.resolutionAction) summary.resolvedReview += 1;
    if (plannedAction === "new_person") summary.newPeople += 1;
    if (plannedAction === "reuse_person") summary.reusedPeople += 1;
    if (action === "unresolved") summary.unresolvedReview += 1;
    if (action === "invalid") summary.invalid += 1;
    if (action === "exclude") summary.excluded += 1;
    if (action === "committed") summary.committed += 1;
  }

  return summary;
}

export function canOfferNewPersonResolution(row: ImportCommitRow, rows: ImportCommitRow[]): boolean {
  if (row.previewDecision !== "review" || row.resolutionAction || trustedContacts(row.normalizedData).length === 0) {
    return false;
  }

  const rowKeys = new Set(trustedContacts(row.normalizedData).map(trustedContactKey));
  return !rows.some((other) => {
    if (other.id === row.id) return false;
    const action = effectiveImportAction(other);
    if (action === "invalid" || action === "exclude") return false;
    return trustedContacts(other.normalizedData).some((contact) => rowKeys.has(trustedContactKey(contact)));
  });
}

export function preflightAudienceImport(
  batchStatus: string,
  rows: ImportCommitRow[],
  currentIdentityOwners: ReadonlyMap<string, ReadonlySet<string>>,
): CommitPreflightResult {
  if (batchStatus === "committed") return { ok: true, idempotent: true };
  if (batchStatus !== "preview") return { ok: false, reason: "batch_not_preview" };

  const newIdentityOwner = new Map<string, string>();

  for (const row of rows) {
    const action = effectiveImportAction(row);
    if (action === "invalid" || action === "exclude" || action === "committed") continue;
    if (action === "unresolved") return { ok: false, reason: "unresolved_review", rowId: row.id };

    const contacts = trustedContacts(row.normalizedData);
    if (contacts.length === 0) return { ok: false, reason: "missing_trusted_identifier", rowId: row.id };

    const targetPersonId =
      row.previewDecision === "reuse_person" ? row.candidatePersonIds[0] : row.resolvedPersonId;

    if (
      action === "reuse_person" &&
      (!targetPersonId ||
        (row.previewDecision === "reuse_person" && row.candidatePersonIds.length !== 1) ||
        (row.previewDecision === "review" && !row.candidatePersonIds.includes(targetPersonId)))
    ) {
      return { ok: false, reason: "invalid_reuse_target", rowId: row.id };
    }

    for (const contact of contacts) {
      const key = trustedContactKey(contact);
      const owners = currentIdentityOwners.get(key) ?? new Set<string>();

      if (action === "new_person") {
        if (owners.size > 0) return { ok: false, reason: "stale_identity_conflict", rowId: row.id };
        const firstRowId = newIdentityOwner.get(key);
        if (firstRowId && firstRowId !== row.id) {
          return { ok: false, reason: "duplicate_new_person_identifier", rowId: row.id };
        }
        newIdentityOwner.set(key, row.id);
      } else if ([...owners].some((ownerId) => ownerId !== targetPersonId)) {
        return { ok: false, reason: "stale_identity_conflict", rowId: row.id };
      }
    }
  }

  return { ok: true, idempotent: false };
}
