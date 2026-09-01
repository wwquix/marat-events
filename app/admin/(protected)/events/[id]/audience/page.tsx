import Link from "next/link";
import { notFound } from "next/navigation";

import { formatAdminDateTime } from "@/lib/admin/attendees";
import { validateAdminId } from "@/lib/admin/events";
import {
  SEGMENT_CONTACT_CHANNELS,
  coerceSegmentFilter,
  exclusionReasonLabel,
  filterListValue,
  normalizeSegmentFilter,
  parseCampaignPreview,
  parseSegmentContactChannel,
  type AudienceSegmentFilter,
  type CampaignPreview,
} from "@/lib/audience/segmentation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { commitInvitationCampaignAction } from "./actions";

export const dynamic = "force-dynamic";

type AudiencePageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type EventRow = { id: string; title: string; starts_at: string; status: string };
type SegmentRow = {
  id: string;
  name: string;
  description: string | null;
  filter_definition: unknown;
  updated_at: string;
};
type ImportBatchRow = { id: string; source_label: string; committed_at: string | null };
type CampaignRow = {
  id: string;
  name: string;
  target_channel: string;
  segment_name_snapshot: string;
  created_at: string;
};

const EMPTY_FILTER = normalizeSegmentFilter({}) as AudienceSegmentFilter;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function textParam(value: string | string[] | undefined, fallback = ""): string {
  return firstParam(value)?.trim() || fallback;
}

function selectedValues(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function queryFilter(search: Record<string, string | string[] | undefined>): AudienceSegmentFilter | null {
  return normalizeSegmentFilter({
    genders: selectedValues(search.genders),
    cities: search.cities,
    occupations: search.occupations,
    educations: search.educations,
    sources: search.sources,
    sourceReferences: search.source_references,
    importBatchIds: selectedValues(search.import_batch_ids),
  });
}

function resultMessage(result: string | undefined): { text: string; tone: string } | null {
  if (result === "committed") {
    return {
      text: "Campaign saved. Eligible people are now reserved for this event and will not be targeted twice.",
      tone: "border-emerald-200 bg-emerald-50 text-emerald-900",
    };
  }
  if (result === "invalid") {
    return { text: "Review the segment fields and try again.", tone: "border-red-200 bg-red-50 text-red-900" };
  }
  if (result === "commit_blocked") {
    return {
      text: "The campaign was not saved. Audience state changed or another campaign used the same targets; preview again.",
      tone: "border-amber-200 bg-amber-50 text-amber-900",
    };
  }
  return null;
}

function HiddenFilterInputs({ filter }: { filter: AudienceSegmentFilter }) {
  return (
    <>
      {filter.genders.map((value) => <input key={`gender-${value}`} name="genders" type="hidden" value={value} />)}
      {filter.cities.map((value) => <input key={`city-${value}`} name="cities" type="hidden" value={value} />)}
      {filter.occupations.map((value) => <input key={`occupation-${value}`} name="occupations" type="hidden" value={value} />)}
      {filter.educations.map((value) => <input key={`education-${value}`} name="educations" type="hidden" value={value} />)}
      {filter.sources.map((value) => <input key={`source-${value}`} name="sources" type="hidden" value={value} />)}
      {filter.sourceReferences.map((value) => (
        <input key={`source-reference-${value}`} name="source_references" type="hidden" value={value} />
      ))}
      {filter.importBatchIds.map((value) => (
        <input key={`batch-${value}`} name="import_batch_ids" type="hidden" value={value} />
      ))}
    </>
  );
}

export default async function EventAudiencePage({ params, searchParams }: AudiencePageProps) {
  const eventId = validateAdminId((await params).id);
  if (!eventId) notFound();

  const search = await searchParams;
  const supabase = createSupabaseServerClient();
  const [{ data: event, error: eventError }, { data: segments, error: segmentError }, { data: batches, error: batchError }, { data: campaigns, error: campaignError }] =
    await Promise.all([
      supabase.from("events").select("id,title,starts_at,status").eq("id", eventId).maybeSingle(),
      supabase
        .from("audience_segments")
        .select("id,name,description,filter_definition,updated_at")
        .order("updated_at", { ascending: false })
        .limit(100),
      supabase
        .from("audience_import_batches")
        .select("id,source_label,committed_at")
        .eq("status", "committed")
        .order("committed_at", { ascending: false })
        .limit(100),
      supabase
        .from("invitation_campaigns")
        .select("id,name,target_channel,segment_name_snapshot,created_at")
        .eq("event_id", eventId)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

  if (eventError || segmentError || batchError || campaignError) {
    throw new Error("Unable to load event audience targeting.");
  }
  if (!event) notFound();

  const typedEvent = event as EventRow;
  const typedSegments = (segments ?? []) as SegmentRow[];
  const typedBatches = (batches ?? []) as ImportBatchRow[];
  const typedCampaigns = (campaigns ?? []) as CampaignRow[];
  const selectedSegmentId = validateAdminId(firstParam(search.segment)) ?? null;
  const selectedSegment = selectedSegmentId
    ? typedSegments.find((segment) => segment.id === selectedSegmentId) ?? null
    : null;
  const savedFilter = selectedSegment ? coerceSegmentFilter(selectedSegment.filter_definition) : null;
  if (selectedSegment && !savedFilter) throw new Error("Saved audience segment has an unsupported filter definition.");

  const previewRequested = firstParam(search.preview) === "1";
  const filter = previewRequested ? queryFilter(search) : (savedFilter ?? EMPTY_FILTER);
  const targetChannel = parseSegmentContactChannel(firstParam(search.target_channel)) ?? "email";
  const segmentName = textParam(search.segment_name, selectedSegment?.name ?? "");
  const segmentDescription = textParam(search.segment_description, selectedSegment?.description ?? "");
  const campaignName = textParam(search.campaign_name, `${typedEvent.title} invitation`);
  const submittedFilterInvalid = previewRequested && !filter;

  let preview: CampaignPreview | null = null;
  let previewError = false;
  if (previewRequested && filter && segmentName && campaignName) {
    const { data, error } = await supabase.rpc("preview_invitation_campaign", {
      p_event_id: eventId,
      p_target_channel: targetChannel,
      p_filter: filter,
    });
    preview = error ? null : parseCampaignPreview(data);
    previewError = Boolean(error || !preview);
  }

  const message = resultMessage(firstParam(search.result));
  const committedCampaignId = validateAdminId(firstParam(search.campaign));

  return (
    <section>
      <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href={`/admin/events/${eventId}`}>
        ← {typedEvent.title}
      </Link>

      <div className="mt-3">
        <p className="text-sm font-medium text-stone-500">Phase 2.3 · Segmentation and targeting</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-stone-900">Build event audience</h1>
        <p className="mt-2 max-w-3xl text-stone-600">
          Preview a reusable segment against current consent, contactability, identity, registration, and invitation state.
          Previewing is read-only. Saving creates a campaign snapshot but sends no messages.
        </p>
        <p className="mt-1 text-sm text-stone-500">
          {formatAdminDateTime(typedEvent.starts_at)} · {typedEvent.status}
        </p>
      </div>

      {message ? <div className={`mt-5 rounded-xl border p-4 text-sm ${message.tone}`}>{message.text}</div> : null}
      {committedCampaignId ? (
        <p className="mt-2 text-xs text-stone-500">Campaign ID: {committedCampaignId}</p>
      ) : null}

      <div className="mt-7 grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <form className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm" method="get">
          <input name="preview" type="hidden" value="1" />
          {selectedSegment ? <input name="segment" type="hidden" value={selectedSegment.id} /> : null}

          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm font-medium text-stone-700">
              Segment name
              <input className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" defaultValue={segmentName} maxLength={160} name="segment_name" required />
            </label>
            <label className="text-sm font-medium text-stone-700">
              Campaign name
              <input className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" defaultValue={campaignName} maxLength={160} name="campaign_name" required />
            </label>
          </div>

          <label className="mt-4 block text-sm font-medium text-stone-700">
            Segment description
            <textarea className="mt-1.5 min-h-20 w-full rounded-lg border border-stone-300 px-3 py-2" defaultValue={segmentDescription} maxLength={1000} name="segment_description" />
          </label>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="text-sm font-medium text-stone-700">
              Invitation channel
              <select className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2" defaultValue={targetChannel} name="target_channel">
                {SEGMENT_CONTACT_CHANNELS.map((channel) => <option key={channel} value={channel}>{channel}</option>)}
              </select>
            </label>
            <fieldset className="text-sm text-stone-700">
              <legend className="font-medium">Gender</legend>
              <div className="mt-2 flex gap-4">
                <label className="flex items-center gap-2"><input defaultChecked={filter?.genders.includes("male")} name="genders" type="checkbox" value="male" /> Men</label>
                <label className="flex items-center gap-2"><input defaultChecked={filter?.genders.includes("female")} name="genders" type="checkbox" value="female" /> Women</label>
              </div>
              <p className="mt-1 text-xs text-stone-500">Leave both clear for any gender.</p>
            </fieldset>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {[
              ["cities", "Cities", filter?.cities ?? []],
              ["occupations", "Occupations", filter?.occupations ?? []],
              ["educations", "Education", filter?.educations ?? []],
              ["sources", "Sources", filter?.sources ?? []],
              ["source_references", "Source references", filter?.sourceReferences ?? []],
            ].map(([name, label, values]) => (
              <label className="text-sm font-medium text-stone-700" key={name as string}>
                {label as string}
                <textarea
                  className="mt-1.5 min-h-20 w-full rounded-lg border border-stone-300 px-3 py-2"
                  defaultValue={filterListValue(values as string[])}
                  name={name as string}
                  placeholder="Comma or line separated; blank means any"
                />
              </label>
            ))}
          </div>

          {typedBatches.length > 0 ? (
            <fieldset className="mt-5 text-sm text-stone-700">
              <legend className="font-medium">Import cohorts</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {typedBatches.map((batch) => (
                  <label className="flex items-start gap-2" key={batch.id}>
                    <input defaultChecked={filter?.importBatchIds.includes(batch.id)} name="import_batch_ids" type="checkbox" value={batch.id} />
                    <span>{batch.source_label}</span>
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-stone-500">Leave all clear to include every import cohort.</p>
            </fieldset>
          ) : null}

          <div className="mt-6 rounded-lg bg-stone-50 p-4 text-sm text-stone-600">
            Automatic exclusions always apply: person suppression, identity review, missing opt-in/reachability, prior event targeting, and any existing event registration.
          </div>

          <button className="mt-5 rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-stone-700" type="submit">
            Preview eligibility
          </button>
        </form>

        <aside>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Saved segments</h2>
          <div className="mt-3 space-y-2">
            <Link className={`block rounded-lg border p-3 text-sm ${!selectedSegment ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 bg-white text-stone-700"}`} href={`/admin/events/${eventId}/audience`}>
              New segment
            </Link>
            {typedSegments.map((segment) => (
              <Link className={`block rounded-lg border p-3 text-sm ${selectedSegment?.id === segment.id ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 bg-white text-stone-700"}`} href={`/admin/events/${eventId}/audience?segment=${segment.id}`} key={segment.id}>
                <span className="font-medium">{segment.name}</span>
                <span className="mt-1 block text-xs opacity-70">Updated {formatAdminDateTime(segment.updated_at)}</span>
              </Link>
            ))}
          </div>
        </aside>
      </div>

      {submittedFilterInvalid || previewError ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          The preview could not be calculated. Check the filters and try again.
        </div>
      ) : null}

      {preview && filter ? (
        <div className="mt-8">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Filter candidates" value={preview.candidates} />
            <Stat label="Eligible" value={preview.eligible} tone="text-emerald-700" />
            <Stat label="Excluded" value={preview.excluded} tone="text-amber-700" />
          </div>

          {preview.reasonCounts.length > 0 ? (
            <div className="mt-4 rounded-xl border border-stone-200 bg-white p-4">
              <h2 className="font-semibold text-stone-900">Exclusion reasons</h2>
              <p className="mt-1 text-xs text-stone-500">One person can have more than one reason.</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {preview.reasonCounts.map(({ reason, count }) => (
                  <div className="rounded-lg bg-stone-50 px-3 py-2 text-sm" key={reason}>
                    <span className="font-medium text-stone-900">{count}</span> · {exclusionReasonLabel(reason)}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-4 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-stone-200 text-sm">
                <thead className="bg-stone-50 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                  <tr><th className="px-3 py-3">Person</th><th className="px-3 py-3">Channel</th><th className="px-3 py-3">Result</th></tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {preview.rows.slice(0, 200).map((row) => (
                    <tr key={row.person_id}>
                      <td className="px-3 py-3"><p className="font-medium text-stone-900">{row.full_name}</p><p className="text-xs text-stone-500">{[row.city, row.source].filter(Boolean).join(" · ") || "—"}</p></td>
                      <td className="px-3 py-3 text-stone-600">{row.contact_value ?? "—"}</td>
                      <td className="px-3 py-3">
                        {row.eligibility_status === "eligible" ? <span className="font-medium text-emerald-700">Eligible</span> : <div className="space-y-1 text-xs text-amber-800">{row.exclusion_reasons.map((reason) => <p key={reason}>{exclusionReasonLabel(reason)}</p>)}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {preview.rows.length > 200 ? <p className="mt-2 text-xs text-stone-500">Showing 200 of {preview.rows.length} candidates; counts include everyone.</p> : null}

          <div className="mt-5 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
            <p className="font-semibold">Commit campaign</p>
            <p className="mt-1">The server will re-evaluate current data before saving. This creates no outbound message.</p>
            <form action={commitInvitationCampaignAction} className="mt-4">
              <input name="event_id" type="hidden" value={eventId} />
              {selectedSegment ? <input name="segment_id" type="hidden" value={selectedSegment.id} /> : null}
              <input name="segment_name" type="hidden" value={segmentName} />
              <input name="segment_description" type="hidden" value={segmentDescription} />
              <input name="campaign_name" type="hidden" value={campaignName} />
              <input name="target_channel" type="hidden" value={targetChannel} />
              <HiddenFilterInputs filter={filter} />
              <button className="rounded-lg bg-stone-900 px-4 py-2.5 font-semibold text-white hover:bg-stone-700 disabled:cursor-not-allowed disabled:bg-stone-300" disabled={preview.eligible === 0} type="submit">
                Save campaign · {preview.eligible} eligible
              </button>
            </form>
          </div>
        </div>
      ) : null}

      {typedCampaigns.length > 0 ? (
        <div className="mt-10">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-stone-900">Campaigns for this event</h2>
            <Link className="text-sm font-medium text-stone-700 underline" href={`/admin/events/${eventId}/outbound`}>Outbound operations</Link>
          </div>
          <div className="mt-3 divide-y divide-stone-100 overflow-hidden rounded-xl border border-stone-200 bg-white">
            {typedCampaigns.map((campaign) => (
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm" key={campaign.id}>
                <div><p className="font-medium text-stone-900">{campaign.name}</p><p className="text-xs text-stone-500">{campaign.segment_name_snapshot} · {campaign.target_channel}</p></div>
                <p className="text-xs text-stone-500">{formatAdminDateTime(campaign.created_at)}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Stat({ label, value, tone = "text-stone-900" }: { label: string; value: number; tone?: string }) {
  return <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm"><p className="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</p><p className={`mt-1 text-2xl font-semibold ${tone}`}>{value}</p></div>;
}
