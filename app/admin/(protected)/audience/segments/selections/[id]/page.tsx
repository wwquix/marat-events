import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAdminSession } from "@/lib/admin/session";
import { loadCompleteRange } from "@/lib/audience/load";
import { loadEventAudienceSelectionPreview } from "@/lib/audience/segments/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import {
  setEventAudienceSelectionOverrideAction,
  updateEventAudienceSelectionAction,
} from "../../actions";

type SelectionPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; page?: string }>;
};

type SelectionRow = {
  id: string;
  segment_id: string;
  name: string;
  segment_version: number;
  required_channel: string;
  status: "draft" | "archived";
  events: { title: string } | { title: string }[] | null;
  audience_segments: { name: string; version: number } | { name: string; version: number }[] | null;
};

type OverrideRow = { person_id: string; decision: "include" | "exclude"; note: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 200;

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function pageNumber(value: string | undefined, totalPages: number): number {
  if (!value || !/^\d+$/.test(value)) return 1;
  return Math.min(Math.max(Number(value), 1), totalPages);
}

export default async function EventAudienceSelectionPage({ params, searchParams }: SelectionPageProps) {
  await requireAdminSession();
  const selectionId = (await params).id;
  if (!UUID_PATTERN.test(selectionId)) notFound();

  const supabase = createSupabaseServerClient();
  const [{ data: selection, error: selectionError }, overrides, preview] = await Promise.all([
      supabase
        .from("event_audience_selections")
        .select("id,segment_id,name,segment_version,required_channel,status,events(title),audience_segments(name,version)")
        .eq("id", selectionId)
        .maybeSingle(),
      loadCompleteRange<OverrideRow>({
        maxTotal: 5_000,
        fetchRange: async (fromInclusive, toInclusive) =>
          supabase
            .from("event_audience_selection_overrides")
            .select("person_id,decision,note", { count: "exact" })
            .eq("selection_id", selectionId)
            .order("person_id", { ascending: true })
            .range(fromInclusive, toInclusive),
      }),
      loadEventAudienceSelectionPreview(selectionId),
    ]);
  if (selectionError) throw new Error("Unable to load event audience selection.");
  if (!selection) notFound();

  const typedSelection = selection as SelectionRow;
  const event = one(typedSelection.events);
  const segment = one(typedSelection.audience_segments);
  const overrideByPerson = new Map(
    overrides.map((override) => [override.person_id, override] as const),
  );
  const included = preview.filter((row) => row.eligible).length;
  const totalPages = Math.max(1, Math.ceil(preview.length / PAGE_SIZE));
  const query = await searchParams;
  const currentPage = pageNumber(query.page, totalPages);
  const pageRows = preview.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href="/admin/audience/segments">
            ← Audience segments
          </Link>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-stone-900">{typedSelection.name}</h1>
          <p className="mt-2 text-sm text-stone-600">
            {event?.title ?? "Unknown event"} · {segment?.name ?? "Unknown segment"} v{typedSelection.segment_version}
          </p>
          {segment && segment.version !== typedSelection.segment_version ? (
            <p className="mt-2 text-xs font-medium text-amber-700">
              The reusable segment is now v{segment.version}; this selection intentionally keeps its v{typedSelection.segment_version} snapshot.
            </p>
          ) : null}
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-sm">
          <Stat label="Total" value={preview.length} />
          <Stat label="Eligible" value={included} />
          <Stat label="Excluded" value={preview.length - included} />
        </div>
      </div>

      {query.saved ? (
        <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Selection saved and live safety gates re-evaluated.
        </div>
      ) : null}
      {query.error ? (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          The selection change could not be saved. Reload and try again.
        </div>
      ) : null}

      <form action={updateEventAudienceSelectionAction} className="mt-7 grid gap-4 rounded-xl border border-stone-200 bg-white p-5 shadow-sm md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
        <input name="selection_id" type="hidden" value={selectionId} />
        <label className="text-sm font-medium text-stone-700">
          Name
          <input className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" defaultValue={typedSelection.name} maxLength={160} name="name" required />
        </label>
        <label className="text-sm font-medium text-stone-700">
          Required channel
          <select className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2" defaultValue={typedSelection.required_channel} name="required_channel">
            {['email', 'phone', 'sms', 'instagram', 'linkedin', 'whatsapp', 'telegram'].map((channel) => <option key={channel} value={channel}>{channel}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium text-stone-700">
          Status
          <select className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2" defaultValue={typedSelection.status} name="status">
            <option value="draft">Draft</option>
            <option value="archived">Archived</option>
          </select>
        </label>
        <button className="rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white" type="submit">Save</button>
      </form>

      <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        Manual include overrides segment criteria only. It cannot override archived status, suppression, ambiguous identity,
        opt-out, unknown consent or an unusable required channel. Manual exclude always wins.
      </div>

      <div className="mt-7 space-y-3">
        {pageRows.map((row) => {
          const currentOverride = overrideByPerson.get(row.personId);
          return (
            <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm" key={row.personId}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-stone-900">{row.fullName}</p>
                  <p className="mt-1 font-mono text-xs text-stone-500">{row.reasonCodes.join(", ")}</p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${row.eligible ? "bg-emerald-50 text-emerald-700" : "bg-stone-100 text-stone-600"}`}>
                  {row.eligible ? "eligible" : "excluded"}
                </span>
              </div>
              <form action={setEventAudienceSelectionOverrideAction} className="mt-4 grid gap-3 sm:grid-cols-[160px_1fr_auto] sm:items-end">
                <input name="selection_id" type="hidden" value={selectionId} />
                <input name="person_id" type="hidden" value={row.personId} />
                <label className="text-xs font-medium text-stone-600">
                  Manual override
                  <select className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm" defaultValue={currentOverride?.decision ?? "clear"} name="decision">
                    <option value="clear">No override</option>
                    <option value="include">Include</option>
                    <option value="exclude">Exclude</option>
                  </select>
                </label>
                <label className="text-xs font-medium text-stone-600">
                  Operator note
                  <input className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm" defaultValue={currentOverride?.note ?? ""} maxLength={1000} name="note" />
                </label>
                <button className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700" type="submit">Apply</button>
              </form>
            </div>
          );
        })}
        {preview.length === 0 ? <p className="rounded-xl border border-stone-200 bg-white p-6 text-sm text-stone-500">No people are available to preview.</p> : null}
      </div>

      {totalPages > 1 ? (
        <nav className="mt-5 flex items-center justify-between text-sm">
          <span className="text-stone-500">Page {currentPage} of {totalPages}</span>
          <div className="flex gap-2">
            {currentPage > 1 ? <Link className="rounded border border-stone-300 px-3 py-2" href={`?page=${currentPage - 1}`}>Previous</Link> : null}
            {currentPage < totalPages ? <Link className="rounded border border-stone-300 px-3 py-2" href={`?page=${currentPage + 1}`}>Next</Link> : null}
          </div>
        </nav>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg border border-stone-200 bg-white px-3 py-2"><p className="font-semibold text-stone-900">{value}</p><p className="text-xs text-stone-500">{label}</p></div>;
}
