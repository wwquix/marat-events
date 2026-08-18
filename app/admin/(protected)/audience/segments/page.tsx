import Link from "next/link";

import { requireAdminSession } from "@/lib/admin/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type SegmentRow = {
  id: string;
  name: string;
  description: string;
  version: number;
  updated_at: string;
};

type SelectionRow = {
  id: string;
  name: string;
  status: "draft" | "archived";
  required_channel: string;
  updated_at: string;
  events: { title: string } | { title: string }[] | null;
  audience_segments: { name: string } | { name: string }[] | null;
};

function relationName(value: { name?: string; title?: string } | { name?: string; title?: string }[] | null) {
  const row = Array.isArray(value) ? value[0] : value;
  return row?.name ?? row?.title ?? "Unknown";
}

export default async function AudienceSegmentsPage() {
  await requireAdminSession();
  const supabase = createSupabaseServerClient();
  const [{ data: segments, error: segmentError }, { data: selections, error: selectionError }] =
    await Promise.all([
      supabase
        .from("audience_segments")
        .select("id,name,description,version,updated_at")
        .order("updated_at", { ascending: false })
        .limit(100),
      supabase
        .from("event_audience_selections")
        .select("id,name,status,required_channel,updated_at,events(title),audience_segments(name)")
        .order("updated_at", { ascending: false })
        .limit(100),
    ]);
  if (segmentError || selectionError) throw new Error("Unable to load audience segments.");

  const typedSegments = (segments ?? []) as SegmentRow[];
  const typedSelections = (selections ?? []) as SelectionRow[];

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href="/admin">
            ← Admin
          </Link>
          <p className="mt-3 text-sm font-medium text-stone-500">Phase 2.3 · Deterministic selection</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-stone-900">Audience segments</h1>
          <p className="mt-2 max-w-3xl text-stone-600">
            Build bounded, explicit criteria and preview stable include/exclude reasons. No provider sends occur here.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700"
            href="/admin/audience/import"
          >
            Imports
          </Link>
          <Link
            className="rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white"
            href="/admin/audience/segments/new"
          >
            New segment
          </Link>
        </div>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <div>
          <h2 className="text-lg font-semibold text-stone-900">Reusable segments</h2>
          <div className="mt-3 divide-y divide-stone-100 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
            {typedSegments.length === 0 ? (
              <p className="p-5 text-sm text-stone-500">No segments yet.</p>
            ) : (
              typedSegments.map((segment) => (
                <Link className="block px-4 py-3 hover:bg-stone-50" href={`/admin/audience/segments/${segment.id}`} key={segment.id}>
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-stone-900">{segment.name}</p>
                    <span className="text-xs text-stone-500">v{segment.version}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-stone-500">{segment.description || "No description"}</p>
                </Link>
              ))
            )}
          </div>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-stone-900">Event selections</h2>
          <div className="mt-3 divide-y divide-stone-100 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
            {typedSelections.length === 0 ? (
              <p className="p-5 text-sm text-stone-500">No event selections yet. Preview a segment to create one.</p>
            ) : (
              typedSelections.map((selection) => (
                <Link
                  className="block px-4 py-3 hover:bg-stone-50"
                  href={`/admin/audience/segments/selections/${selection.id}`}
                  key={selection.id}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-stone-900">{selection.name}</p>
                    <span className="text-xs text-stone-500">{selection.status}</span>
                  </div>
                  <p className="mt-1 text-sm text-stone-500">
                    {relationName(selection.events)} · {relationName(selection.audience_segments)} · {selection.required_channel}
                  </p>
                </Link>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
