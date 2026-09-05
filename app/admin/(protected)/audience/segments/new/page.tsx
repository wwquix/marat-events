import Link from "next/link";

import { requireAdminSession } from "@/lib/admin/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { SegmentForm, type Option } from "../segment-form";

type NewSegmentPageProps = { searchParams: Promise<{ error?: string }> };

export default async function NewAudienceSegmentPage({ searchParams }: NewSegmentPageProps) {
  await requireAdminSession();
  const supabase = createSupabaseServerClient();
  const [{ data: imports, error: importError }, { data: events, error: eventError }] = await Promise.all([
    supabase.from("audience_import_batches").select("id,source_label").eq("status", "committed").order("created_at", { ascending: false }).limit(200),
    supabase.from("events").select("id,title").order("starts_at", { ascending: false }).limit(200),
  ]);
  if (importError || eventError) throw new Error("Unable to load segment form options.");
  const notice = await searchParams;
  const importOptions: Option[] = (imports ?? []).map((item) => ({ id: String(item.id), label: String(item.source_label) }));
  const eventOptions: Option[] = (events ?? []).map((item) => ({ id: String(item.id), label: String(item.title) }));

  return (
    <section className="mx-auto max-w-4xl">
      <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href="/admin/audience/segments">
        ← Audience segments
      </Link>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-stone-900">Create segment</h1>
      {notice.error ? (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {notice.error === "name_exists" ? "A segment already uses that name." : "Check the fields and try again."}
        </div>
      ) : null}
      <div className="mt-6 rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <SegmentForm events={eventOptions} imports={importOptions} />
      </div>
    </section>
  );
}
