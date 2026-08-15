import Link from "next/link";
import { notFound } from "next/navigation";

import { validateAdminId } from "@/lib/admin/events";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { discardAudienceImportPreviewAction } from "../actions";

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
};

type PreviewRow = {
  id: string;
  row_number: number;
  normalized_data: Record<string, unknown>;
  decision: "new_person" | "reuse_person" | "review" | "invalid" | "committed";
  candidate_person_ids: string[];
  errors: string[];
};

type PersonRow = { id: string; full_name: string; email: string | null };

const DECISIONS = ["new_person", "reuse_person", "review", "invalid", "committed"] as const;

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

export default async function AudienceImportPreviewPage({ params }: PreviewPageProps) {
  const batchId = validateAdminId((await params).id);
  if (!batchId) notFound();

  const supabase = createSupabaseServerClient();
  const [{ data: batch, error: batchError }, { data: rows, error: rowsError }, ...countResults] =
    await Promise.all([
      supabase
        .from("audience_import_batches")
        .select("id,source_label,source_reference,source_type,status,row_count,created_by,created_at")
        .eq("id", batchId)
        .maybeSingle(),
      supabase
        .from("audience_import_rows")
        .select("id,row_number,normalized_data,decision,candidate_person_ids,errors")
        .eq("batch_id", batchId)
        .order("row_number", { ascending: true })
        .limit(500),
      ...DECISIONS.map((decision) =>
        supabase
          .from("audience_import_rows")
          .select("id", { count: "exact", head: true })
          .eq("batch_id", batchId)
          .eq("decision", decision),
      ),
    ]);

  if (batchError || rowsError || countResults.some((result) => result.error)) {
    throw new Error("Unable to load audience import preview.");
  }
  if (!batch) notFound();

  const typedBatch = batch as BatchRow;
  const typedRows = (rows ?? []) as PreviewRow[];
  const counts = Object.fromEntries(
    DECISIONS.map((decision, index) => [decision, countResults[index].count ?? 0]),
  ) as Record<(typeof DECISIONS)[number], number>;

  const candidateIds = Array.from(new Set(typedRows.flatMap((row) => row.candidate_person_ids)));
  let people: PersonRow[] = [];
  if (candidateIds.length > 0) {
    const { data: candidatePeople, error: candidateError } = await supabase
      .from("people")
      .select("id,full_name,email")
      .in("id", candidateIds);
    if (candidateError) throw new Error("Unable to load candidate people.");
    people = (candidatePeople ?? []) as PersonRow[];
  }
  const peopleById = new Map(people.map((person) => [person.id, person]));

  return (
    <section>
      <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href="/admin/audience/import">
        ← Audience imports
      </Link>

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

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="New person" value={counts.new_person} />
        <Stat label="Reuse person" value={counts.reuse_person} />
        <Stat label="Needs review" value={counts.review} />
        <Stat label="Invalid" value={counts.invalid} />
        <Stat label="Committed" value={counts.committed} />
      </div>

      <div className="mt-6 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
        This is a preview only. No row on this page creates or updates a central <code>people</code> record. Rows marked
        review will require an explicit identity decision before the import can be committed.
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-stone-200 text-sm">
            <thead className="bg-stone-50 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-3 py-3">Row</th>
                <th className="px-3 py-3">Person</th>
                <th className="px-3 py-3">Identifiers</th>
                <th className="px-3 py-3">Decision</th>
                <th className="px-3 py-3">Candidate / reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {typedRows.map((row) => {
                const name = textField(row.normalized_data, "fullName") ?? "—";
                const email = textField(row.normalized_data, "email");
                const phone = textField(row.normalized_data, "phone");
                const instagram = textField(row.normalized_data, "instagram");
                const linkedin = textField(row.normalized_data, "linkedin");
                const candidates = row.candidate_person_ids
                  .map((id) => peopleById.get(id))
                  .filter((person): person is PersonRow => Boolean(person));

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
                    </td>
                    <td className="px-3 py-3 align-top text-xs text-stone-600">
                      {candidates.map((person) => (
                        <p key={person.id}>
                          {person.full_name}{person.email ? ` · ${person.email}` : ""}
                        </p>
                      ))}
                      {row.errors.map((error) => <p key={error}>{error.replaceAll("_", " ")}</p>)}
                      {candidates.length === 0 && row.errors.length === 0 ? <p>—</p> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {typedBatch.row_count > typedRows.length ? (
        <p className="mt-3 text-xs text-amber-700">
          Preview table shows the first {typedRows.length} rows; decision counts above include the entire import.
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
