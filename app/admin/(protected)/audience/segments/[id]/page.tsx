import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAdminSession } from "@/lib/admin/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { SegmentForm, type Option, type SegmentFormValue } from "../segment-form";

type SegmentPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function AudienceSegmentPage({ params, searchParams }: SegmentPageProps) {
  await requireAdminSession();
  const segmentId = (await params).id;
  if (!UUID_PATTERN.test(segmentId)) notFound();

  const supabase = createSupabaseServerClient();
  const [
    { data: segment, error: segmentError },
    { data: imports, error: importError },
    { data: events, error: eventError },
    { data: selections, error: selectionError },
  ] = await Promise.all([
    supabase
      .from("audience_segments")
      .select(
        "id,name,description,gender,city,source,import_batch_id,contact_channel,consent_requirement,contactability_requirement,prior_registration_event_id,prior_registration_payment_status,version",
      )
      .eq("id", segmentId)
      .maybeSingle(),
    supabase
      .from("audience_import_batches")
      .select("id,source_label")
      .eq("status", "committed")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase.from("events").select("id,title").order("starts_at", { ascending: false }).limit(200),
    supabase
      .from("event_audience_selections")
      .select("id,name,status,required_channel,events(title)")
      .eq("segment_id", segmentId)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  if (segmentError || importError || eventError || selectionError) {
    throw new Error("Unable to load audience segment details.");
  }
  if (!segment) notFound();

  const typedSegment = segment as SegmentFormValue;
  const importOptions: Option[] = (imports ?? []).map((item) => ({
    id: String(item.id),
    label: String(item.source_label),
  }));
  const eventOptions: Option[] = (events ?? []).map((item) => ({ id: String(item.id), label: String(item.title) }));
  const notice = await searchParams;

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href="/admin/audience/segments">
            ← Audience segments
          </Link>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-stone-900">{typedSegment.name}</h1>
          <p className="mt-1 text-sm text-stone-500">Definition version {typedSegment.version}</p>
        </div>
        <Link
          className="rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white"
          href={`/admin/audience/segments/${segmentId}/preview`}
        >
          Preview segment
        </Link>
      </div>

      {notice.saved ? (
        <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Segment saved.
        </div>
      ) : null}
      {notice.error ? (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {notice.error === "stale"
            ? "This segment changed in another request. Reload before editing again."
            : notice.error === "name_exists"
              ? "A segment already uses that name."
              : "The segment could not be saved. Check the fields and try again."}
        </div>
      ) : null}

      <div className="mt-7 rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <SegmentForm events={eventOptions} imports={importOptions} segment={typedSegment} />
      </div>

      <div className="mt-10">
        <h2 className="text-xl font-semibold text-stone-900">Saved event selections</h2>
        <div className="mt-3 divide-y divide-stone-100 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
          {(selections ?? []).length === 0 ? (
            <p className="p-5 text-sm text-stone-500">No frozen event selections use this segment yet.</p>
          ) : (
            (selections ?? []).map((selection) => {
              const eventRelation = Array.isArray(selection.events) ? selection.events[0] : selection.events;
              return (
                <Link
                  className="block px-4 py-3 hover:bg-stone-50"
                  href={`/admin/audience/segments/selections/${selection.id}`}
                  key={selection.id}
                >
                  <p className="font-medium text-stone-900">{selection.name}</p>
                  <p className="mt-1 text-sm text-stone-500">
                    {eventRelation?.title ?? "Unknown event"} · {selection.required_channel} · {selection.status}
                  </p>
                </Link>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
