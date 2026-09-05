import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAdminSession } from "@/lib/admin/session";
import {
  criteriaFromSegmentRow,
  evaluateAudienceSegment,
  summarizeAudienceSegment,
} from "@/lib/audience/segments";
import { loadAudienceSegmentCandidates } from "@/lib/audience/segments/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { createEventAudienceSelectionAction } from "../../actions";

type SegmentPreviewPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; page?: string }>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 200;

function pageNumber(value: string | undefined, totalPages: number): number {
  if (!value || !/^\d+$/.test(value)) return 1;
  return Math.min(Math.max(Number(value), 1), totalPages);
}

export default async function AudienceSegmentPreviewPage({ params, searchParams }: SegmentPreviewPageProps) {
  await requireAdminSession();
  const segmentId = (await params).id;
  if (!UUID_PATTERN.test(segmentId)) notFound();

  const supabase = createSupabaseServerClient();
  const [{ data: segment, error: segmentError }, { data: events, error: eventError }] = await Promise.all([
      supabase
        .from("audience_segments")
        .select(
          "id,name,version,gender,city,source,import_batch_id,contact_channel,consent_requirement,contactability_requirement,prior_registration_event_id,prior_registration_payment_status",
        )
        .eq("id", segmentId)
        .maybeSingle(),
      supabase.from("events").select("id,title,starts_at").order("starts_at", { ascending: false }).limit(200),
    ]);
  if (segmentError || eventError) throw new Error("Unable to load audience segment preview.");
  if (!segment) notFound();
  const criteria = criteriaFromSegmentRow(segment);
  if (!criteria.ok || typeof segment.name !== "string" || typeof segment.version !== "number") {
    throw new Error("Audience segment data is malformed.");
  }

  const candidates = await loadAudienceSegmentCandidates(criteria.value.priorRegistrationEventId);
  const results = evaluateAudienceSegment({ candidates, criteria: criteria.value });
  const summary = summarizeAudienceSegment(results);
  const totalPages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  const query = await searchParams;
  const currentPage = pageNumber(query.page, totalPages);
  const pageResults = results.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href={`/admin/audience/segments/${segmentId}`}>
            ← {segment.name}
          </Link>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-stone-900">Segment preview</h1>
          <p className="mt-2 max-w-3xl text-sm text-stone-600">
            Live preview of version {segment.version}. This preview does not send messages and is not proof of consent.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-sm">
          <Stat label="Total" value={summary.total} />
          <Stat label="Included" value={summary.included} />
          <Stat label="Excluded" value={summary.excluded} />
        </div>
      </div>

      {query.error ? (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {query.error === "selection_exists"
            ? "That event already has a selection with this name."
            : "The event selection could not be created."}
        </div>
      ) : null}

      <form action={createEventAudienceSelectionAction} className="mt-7 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <input name="segment_id" type="hidden" value={segmentId} />
        <h2 className="text-lg font-semibold text-stone-900">Freeze an event selection</h2>
        <p className="mt-1 text-sm text-stone-500">
          The current typed criteria are snapshotted. Live suppression, identity, consent and contactability are still
          rechecked on every selection preview.
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <label className="text-sm font-medium text-stone-700">
            Selection name
            <input className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" maxLength={160} name="name" required />
          </label>
          <label className="text-sm font-medium text-stone-700">
            Event
            <select className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2" name="event_id" required>
              <option value="">Choose an event</option>
              {(events ?? []).map((event) => <option key={event.id} value={event.id}>{event.title}</option>)}
            </select>
          </label>
          <label className="text-sm font-medium text-stone-700">
            Required channel
            <select className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2" name="required_channel" required>
              {['email', 'phone', 'sms', 'instagram', 'linkedin', 'whatsapp', 'telegram'].map((channel) => (
                <option key={channel} value={channel}>{channel}</option>
              ))}
            </select>
          </label>
        </div>
        <button className="mt-4 rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white" type="submit">
          Create draft selection
        </button>
      </form>

      <div className="mt-8 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-stone-200 text-sm">
            <thead className="bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
              <tr><th className="px-4 py-3">Person</th><th className="px-4 py-3">Decision</th><th className="px-4 py-3">Reason codes</th></tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {pageResults.map((result) => (
                <tr key={result.personId}>
                  <td className="px-4 py-3 font-medium text-stone-900">{result.fullName}</td>
                  <td className={`px-4 py-3 font-medium ${result.included ? "text-emerald-700" : "text-stone-500"}`}>
                    {result.included ? "include" : "exclude"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-stone-600">{result.reasonCodes.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {results.length === 0 ? <p className="p-6 text-sm text-stone-500">No people are available to preview.</p> : null}
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
