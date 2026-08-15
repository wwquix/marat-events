import Link from "next/link";

import { createAudienceImportPreviewAction } from "./actions";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ImportBatch = {
  id: string;
  source_label: string;
  source_type: string;
  status: string;
  row_count: number;
  created_at: string;
};

type ImportPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: "Choose a CSV file and provide a source label.",
  invalid_csv: "The CSV could not be parsed or contains unsupported/invalid structure.",
  database: "The preview could not be saved. Please try again.",
};

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

export default async function AudienceImportPage({ searchParams }: ImportPageProps) {
  const params = await searchParams;
  const errorCode = firstParam(params.error);
  const errorMessage = errorCode ? ERROR_MESSAGES[errorCode] : null;

  const { data, error } = await createSupabaseServerClient()
    .from("audience_import_batches")
    .select("id,source_label,source_type,status,row_count,created_at")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) throw new Error("Unable to load audience imports.");
  const batches = (data ?? []) as ImportBatch[];

  return (
    <section>
      <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href="/admin">
        ← Admin
      </Link>

      <div className="mt-3">
        <p className="text-sm font-medium text-stone-500">Phase 2 · Audience database</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-stone-900">Import audience</h1>
        <p className="mt-2 max-w-3xl text-stone-600">
          Upload a CSV to create a preview. Previewing does not create or update central people records. Exact email,
          phone, Instagram and LinkedIn identifiers are used for deterministic matching; names alone are never merged.
        </p>
      </div>

      {errorMessage ? (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {errorMessage}
        </div>
      ) : null}

      <form
        action={createAudienceImportPreviewAction}
        className="mt-7 grid gap-5 rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-sm font-medium text-stone-700">
            Source label
            <input
              className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
              maxLength={160}
              name="source_label"
              placeholder="Example: Existing audience — August 2026"
              required
            />
          </label>

          <label className="text-sm font-medium text-stone-700">
            Source reference (optional)
            <input
              className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
              maxLength={500}
              name="source_reference"
              placeholder="Sheet name, export ID, Drive reference, etc."
            />
          </label>
        </div>

        <label className="text-sm font-medium text-stone-700">
          CSV file
          <input
            accept=".csv,text/csv"
            className="mt-1.5 block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
            name="file"
            required
            type="file"
          />
        </label>

        <div className="rounded-lg bg-stone-50 p-4 text-sm text-stone-600">
          <p className="font-medium text-stone-800">Supported columns</p>
          <p className="mt-1 leading-6">
            <code>full_name</code> (required), <code>email</code>, <code>phone</code>, <code>gender</code>, <code>city</code>,
            {" "}<code>occupation</code>, <code>education</code>, <code>profile_url</code>, <code>instagram</code>,
            {" "}<code>linkedin</code>, <code>source</code>, <code>source_reference</code>.
          </p>
          <p className="mt-2 text-xs text-stone-500">
            Common aliases such as name, location, job, university, instagram_url and linkedin_url are accepted. Max
            5,000 rows / 2 MB per preview.
          </p>
        </div>

        <div>
          <button className="rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white" type="submit">
            Create preview
          </button>
        </div>
      </form>

      <div className="mt-9">
        <h2 className="text-lg font-semibold text-stone-900">Recent imports</h2>
        <div className="mt-3 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
          {batches.length === 0 ? (
            <p className="p-6 text-sm text-stone-500">No import previews yet.</p>
          ) : (
            <div className="divide-y divide-stone-100">
              {batches.map((batch) => (
                <Link
                  className="grid gap-2 px-4 py-3 hover:bg-stone-50 sm:grid-cols-[1fr_auto] sm:items-center"
                  href={`/admin/audience/import/${batch.id}`}
                  key={batch.id}
                >
                  <div>
                    <p className="font-medium text-stone-900">{batch.source_label}</p>
                    <p className="mt-0.5 text-xs text-stone-500">
                      {formatDate(batch.created_at)} · {batch.row_count} rows · {batch.source_type}
                    </p>
                  </div>
                  <span className="text-sm font-medium text-stone-600">{batch.status} →</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
