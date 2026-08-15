import Link from "next/link";
import { notFound } from "next/navigation";

import { validateAdminId } from "@/lib/admin/events";
import { MAX_IMPORT_ROWS } from "@/lib/audience/import";
import {
  canOfferNewPersonResolution,
  paginateAudienceImportRows,
  summarizeImportRows,
  type ImportCommitRow,
  type ImportPreviewDecision,
  type ReviewResolutionAction,
} from "@/lib/audience/commit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  commitAudienceImportAction,
  discardAudienceImportPreviewAction,
  resolveAudienceImportReviewAction,
} from "../actions";

export const dynamic = "force-dynamic";

type PreviewPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type BatchRow = {
  id: string;
  source_label: string;
  source_reference: string | null;
  source_type: string;
  status: string;
  row_count: number;
  created_by: string | null;
  created_at: string;
  committed_at: string | null;
  committed_by: string | null;
};

type PreviewRow = {
  id: string;
  row_number: number;
  normalized_data: Record<string, unknown>;
  decision: ImportPreviewDecision;
  preview_decision: ImportPreviewDecision;
  candidate_person_ids: string[];
  errors: string[];
  committed_person_id: string | null;
  committed_at: string | null;
};

type ReviewRow = {
  audience_import_row_id: string;
  resolution_action: ReviewResolutionAction | null;
  resolved_person_id: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  resolved_at: string | null;
};

type PersonRow = { id: string; full_name: string; email: string | null };

function decisionClass(decision: PreviewRow["decision"]): string {
  if (decision === "new_person") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (decision === "reuse_person") return "bg-blue-50 text-blue-800 ring-blue-200";
  if (decision === "review") return "bg-amber-50 text-amber-800 ring-amber-200";
  if (decision === "invalid") return "bg-red-50 text-red-800 ring-red-200";
  return "bg-stone-100 text-stone-700 ring-stone-200";
}

function textField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value ? value : null;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function firstParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function pagePath(batchId: string, page: number): string {
  return page > 1 ? `/admin/audience/import/${batchId}?page=${page}` : `/admin/audience/import/${batchId}`;
}

function resultMessage(result: string | null): { tone: string; text: string } | null {
  if (result === "resolved") {
    return { tone: "border-emerald-200 bg-emerald-50 text-emerald-900", text: "Review decision saved." };
  }
  if (result === "committed") {
    return { tone: "border-emerald-200 bg-emerald-50 text-emerald-900", text: "Import committed atomically." };
  }
  if (result === "resolution_blocked") {
    return {
      tone: "border-amber-200 bg-amber-50 text-amber-900",
      text: "That resolution is no longer safe. Refresh the candidates or resolve duplicate rows first.",
    };
  }
  if (result === "commit_blocked") {
    return {
      tone: "border-red-200 bg-red-50 text-red-900",
      text: "Commit was blocked. No import changes were applied; review unresolved or newly conflicting identities.",
    };
  }
  if (result === "invalid_resolution") {
    return { tone: "border-red-200 bg-red-50 text-red-900", text: "Invalid review resolution." };
  }
  return null;
}

export default async function AudienceImportPreviewPage({ params, searchParams }: PreviewPageProps) {
  const batchId = validateAdminId((await params).id);
  if (!batchId) notFound();
  const resolvedSearchParams = await searchParams;

  const supabase = createSupabaseServerClient();
  const [{ data: batch, error: batchError }, { data: rows, error: rowsError }, { data: reviews, error: reviewsError }] =
    await Promise.all([
      supabase
        .from("audience_import_batches")
        .select(
          "id,source_label,source_reference,source_type,status,row_count,created_by,created_at,committed_at,committed_by",
        )
        .eq("id", batchId)
        .maybeSingle(),
      supabase
        .from("audience_import_rows")
        .select(
          "id,row_number,normalized_data,decision,preview_decision,candidate_person_ids,errors,committed_person_id,committed_at",
        )
        .eq("batch_id", batchId)
        .order("row_number", { ascending: true })
        .limit(MAX_IMPORT_ROWS),
      supabase
        .from("identity_review_queue")
        .select(
          "audience_import_row_id,resolution_action,resolved_person_id,resolved_by,resolution_note,resolved_at",
        )
        .eq("import_batch_id", batchId)
        .not("audience_import_row_id", "is", null)
        .limit(MAX_IMPORT_ROWS),
    ]);

  if (batchError || rowsError || reviewsError) throw new Error("Unable to load audience import preview.");
  if (!batch) notFound();

  const typedBatch = batch as BatchRow;
  const allRows = (rows ?? []) as PreviewRow[];
  const typedReviews = (reviews ?? []) as ReviewRow[];
  const reviewByRowId = new Map(typedReviews.map((review) => [review.audience_import_row_id, review]));
  const policyRows: ImportCommitRow[] = allRows.map((row) => {
    const review = reviewByRowId.get(row.id);
    return {
      id: row.id,
      previewDecision: row.preview_decision,
      decision: row.decision,
      candidatePersonIds: row.candidate_person_ids,
      normalizedData: row.normalized_data,
      resolutionAction: review?.resolution_action ?? null,
      resolvedPersonId: review?.resolved_person_id ?? null,
      committedPersonId: row.committed_person_id,
    };
  });
  const policyRowsById = new Map(policyRows.map((row) => [row.id, row]));
  const summary = summarizeImportRows(policyRows);
  const pagination = paginateAudienceImportRows(allRows, firstParam(resolvedSearchParams.page));
  const visibleRows = pagination.rows;

  const personIds = Array.from(
    new Set(
      visibleRows.flatMap((row) => {
        const review = reviewByRowId.get(row.id);
        return [...row.candidate_person_ids, row.committed_person_id, review?.resolved_person_id].filter(
          (id): id is string => Boolean(id),
        );
      }),
    ),
  );
  let people: PersonRow[] = [];
  if (personIds.length > 0) {
    const { data: personRows, error: peopleError } = await supabase
      .from("people")
      .select("id,full_name,email")
      .in("id", personIds);
    if (peopleError) throw new Error("Unable to load candidate people.");
    people = (personRows ?? []) as PersonRow[];
  }
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const message = resultMessage(firstParam(resolvedSearchParams.result));
  const canCommit = typedBatch.status === "preview" && summary.unresolvedReview === 0;
  const skipped = summary.invalid + summary.excluded;

  return (
    <section>
      <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href="/admin/audience/import">
        ← Audience imports
      </Link>

      {message ? <div className={`mt-4 rounded-xl border p-4 text-sm ${message.tone}`}>{message.text}</div> : null}

      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-stone-500">Import preview · {typedBatch.status}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-stone-900">{typedBatch.source_label}</h1>
          <p className="mt-2 text-sm text-stone-600">
            {formatDate(typedBatch.created_at)} · {typedBatch.row_count} rows · {typedBatch.source_type}
          </p>
          {typedBatch.source_reference ? (
            <p className="mt-1 text-xs text-stone-500">Source: {typedBatch.source_reference}</p>
          ) : null}
          {typedBatch.status === "committed" && typedBatch.committed_at ? (
            <p className="mt-2 text-sm font-medium text-emerald-700">
              Committed {formatDate(typedBatch.committed_at)}
              {typedBatch.committed_by ? ` by ${typedBatch.committed_by}` : ""}
            </p>
          ) : null}
        </div>

        {typedBatch.status === "preview" ? (
          <form action={discardAudienceImportPreviewAction}>
            <input name="batch_id" type="hidden" value={typedBatch.id} />
            <button
              className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
              type="submit"
            >
              Discard preview
            </button>
          </form>
        ) : null}
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total rows" value={summary.total} />
        <Stat label="New people" value={summary.newPeople} />
        <Stat label="Reused people" value={summary.reusedPeople} />
        <Stat label="Unresolved review" value={summary.unresolvedReview} />
        <Stat label="Resolved review" value={summary.resolvedReview} />
        <Stat label="Invalid" value={summary.invalid} />
        <Stat label="Excluded / skipped" value={summary.excluded} />
        <Stat label="Committed" value={summary.committed} />
      </div>

      {typedBatch.status === "preview" ? (
        <div className="mt-6 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
          <p className="font-semibold">Commit summary</p>
          <p className="mt-1">
            The atomic commit will create {summary.newPeople} people, reuse {summary.reusedPeople} people, and skip {skipped}
            rows ({summary.invalid} invalid, {summary.excluded} explicitly excluded).
          </p>
          {summary.unresolvedReview > 0 ? (
            <p className="mt-2 font-medium text-amber-900">
              Resolve or exclude all {summary.unresolvedReview} remaining review rows before committing.
            </p>
          ) : null}
          <form action={commitAudienceImportAction} className="mt-4">
            <input name="batch_id" type="hidden" value={typedBatch.id} />
            <button
              className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-700 disabled:cursor-not-allowed disabled:bg-stone-300"
              disabled={!canCommit}
              type="submit"
            >
              Commit import: {summary.newPeople + summary.reusedPeople} eligible, {skipped} skipped
            </button>
          </form>
        </div>
      ) : (
        <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
          This batch is committed. Review decisions are locked and the commit action is no longer available.
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-sm text-stone-600">
        <p>
          Rows {pagination.startRow}–{pagination.endRow} of {allRows.length}
        </p>
        <nav aria-label="Import rows pages" className="flex flex-wrap items-center gap-1">
          {Array.from({ length: pagination.totalPages }, (_, index) => index + 1).map((page) => (
            <Link
              aria-current={page === pagination.page ? "page" : undefined}
              className={`rounded-md border px-2.5 py-1.5 font-medium ${
                page === pagination.page
                  ? "border-stone-900 bg-stone-900 text-white"
                  : "border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
              }`}
              href={pagePath(typedBatch.id, page)}
              key={page}
            >
              {page}
            </Link>
          ))}
        </nav>
      </div>

      <div className="mt-3 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-stone-200 text-sm">
            <thead className="bg-stone-50 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-3 py-3">Row</th>
                <th className="px-3 py-3">Person</th>
                <th className="px-3 py-3">Identifiers</th>
                <th className="px-3 py-3">Decision</th>
                <th className="px-3 py-3">Candidate / review resolution</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {visibleRows.map((row) => {
                const name = textField(row.normalized_data, "fullName") ?? "—";
                const email = textField(row.normalized_data, "email");
                const phone = textField(row.normalized_data, "phone");
                const instagram = textField(row.normalized_data, "instagram");
                const linkedin = textField(row.normalized_data, "linkedin");
                const candidates = row.candidate_person_ids
                  .map((id) => peopleById.get(id))
                  .filter((person): person is PersonRow => Boolean(person));
                const review = reviewByRowId.get(row.id);
                const committedPerson = row.committed_person_id ? peopleById.get(row.committed_person_id) : null;
                const policyRow = policyRowsById.get(row.id);
                const canCreateNew = policyRow ? canOfferNewPersonResolution(policyRow, policyRows) : false;

                return (
                  <tr key={row.id}>
                    <td className="px-3 py-3 align-top text-stone-500">{row.row_number}</td>
                    <td className="px-3 py-3 align-top">
                      <p className="font-medium text-stone-900">{name}</p>
                      <p className="mt-0.5 text-xs text-stone-500">
                        {[textField(row.normalized_data, "city"), textField(row.normalized_data, "occupation")]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </p>
                    </td>
                    <td className="px-3 py-3 align-top text-xs text-stone-600">
                      {email ? <p>{email}</p> : null}
                      {phone ? <p>{phone}</p> : null}
                      {instagram ? <p>IG: {instagram}</p> : null}
                      {linkedin ? <p>LinkedIn: {linkedin}</p> : null}
                      {!email && !phone && !instagram && !linkedin ? <p>—</p> : null}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span
                        className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset ${decisionClass(row.decision)}`}
                      >
                        {row.decision.replace("_", " ")}
                      </span>
                      {row.decision === "committed" ? (
                        <p className="mt-2 text-xs text-emerald-700">
                          {committedPerson ? `Central: ${committedPerson.full_name}` : "Central person linked"}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 align-top text-xs text-stone-600">
                      {review?.resolution_action ? (
                        <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                          <p className="font-semibold text-stone-900">
                            Resolved: {review.resolution_action.replace("_", " ")}
                          </p>
                          {review.resolved_person_id && peopleById.get(review.resolved_person_id) ? (
                            <p className="mt-1">{peopleById.get(review.resolved_person_id)?.full_name}</p>
                          ) : null}
                          {review.resolved_by && review.resolved_at ? (
                            <p className="mt-1 text-stone-500">
                              {review.resolved_by} · {formatDate(review.resolved_at)}
                            </p>
                          ) : null}
                          {review.resolution_note ? <p className="mt-1 text-stone-500">{review.resolution_note}</p> : null}
                        </div>
                      ) : row.preview_decision === "review" && typedBatch.status === "preview" ? (
                        <div className="space-y-2">
                          {candidates.map((person) => (
                            <form action={resolveAudienceImportReviewAction} key={person.id}>
                              <input name="batch_id" type="hidden" value={typedBatch.id} />
                              <input name="row_id" type="hidden" value={row.id} />
                              <input name="return_page" type="hidden" value={pagination.page} />
                              <input name="resolution_action" type="hidden" value="reuse_person" />
                              <input name="person_id" type="hidden" value={person.id} />
                              <button
                                className="w-full rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5 text-left font-medium text-blue-800 hover:bg-blue-100"
                                type="submit"
                              >
                                Reuse {person.full_name}{person.email ? ` · ${person.email}` : ""}
                              </button>
                            </form>
                          ))}
                          {canCreateNew ? (
                            <form action={resolveAudienceImportReviewAction}>
                              <input name="batch_id" type="hidden" value={typedBatch.id} />
                              <input name="row_id" type="hidden" value={row.id} />
                              <input name="return_page" type="hidden" value={pagination.page} />
                              <input name="resolution_action" type="hidden" value="new_person" />
                              <button
                                className="w-full rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-left font-medium text-emerald-800 hover:bg-emerald-100"
                                type="submit"
                              >
                                Treat as a new person
                              </button>
                            </form>
                          ) : (
                            <p className="text-amber-700">
                              New person is unavailable until duplicate non-excluded rows are resolved.
                            </p>
                          )}
                          <form action={resolveAudienceImportReviewAction}>
                            <input name="batch_id" type="hidden" value={typedBatch.id} />
                            <input name="row_id" type="hidden" value={row.id} />
                            <input name="return_page" type="hidden" value={pagination.page} />
                            <input name="resolution_action" type="hidden" value="exclude" />
                            <button
                              className="w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-left font-medium text-stone-700 hover:bg-stone-50"
                              type="submit"
                            >
                              Exclude / skip this row
                            </button>
                          </form>
                          {row.errors.map((error) => <p key={error}>{error.replaceAll("_", " ")}</p>)}
                        </div>
                      ) : (
                        <>
                          {candidates.map((person) => (
                            <p key={person.id}>
                              {person.full_name}{person.email ? ` · ${person.email}` : ""}
                            </p>
                          ))}
                          {row.errors.map((error) => <p key={error}>{error.replaceAll("_", " ")}</p>)}
                          {candidates.length === 0 && row.errors.length === 0 ? <p>—</p> : null}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {pagination.totalPages > 1 ? (
        <p className="mt-3 text-xs text-stone-500">
          Use the numbered pages to review every row. Commit counts always include the entire import.
        </p>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-stone-900">{value}</p>
    </div>
  );
}
