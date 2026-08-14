import Link from "next/link";

import { createSupabaseServerClient } from "@/lib/supabase/server";

type EventListRow = {
  id: string;
  slug: string;
  title: string;
  venue: string;
  starts_at: string;
  capacity: number | null;
  status: string;
};

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function statusClass(status: string): string {
  if (status === "published") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (status === "hidden") return "bg-stone-100 text-stone-600 ring-stone-200";
  return "bg-amber-50 text-amber-700 ring-amber-200";
}

export default async function AdminHomePage() {
  const { data, error } = await createSupabaseServerClient()
    .from("events")
    .select("id,slug,title,venue,starts_at,capacity,status")
    .order("starts_at", { ascending: false });

  if (error) {
    throw new Error("Unable to load events.");
  }

  const events = (data ?? []) as EventListRow[];

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-stone-500">Event operations</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-stone-900">Events</h1>
          <p className="mt-2 max-w-2xl text-stone-600">
            Create events, configure tickets, publish registration pages and stop sales without editing the database.
          </p>
        </div>
        <Link
          className="rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-800"
          href="/admin/events/new"
        >
          Create event
        </Link>
      </div>

      <div className="mt-8 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
        {events.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="font-medium text-stone-900">No events yet</p>
            <p className="mt-1 text-sm text-stone-600">Create the first event to start configuring registration.</p>
          </div>
        ) : (
          <div className="divide-y divide-stone-200">
            {events.map((event) => (
              <Link
                className="grid gap-3 px-5 py-4 hover:bg-stone-50 sm:grid-cols-[1fr_auto] sm:items-center"
                href={`/admin/events/${event.id}`}
                key={event.id}
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-stone-900">{event.title}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusClass(event.status)}`}>
                      {event.status}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-stone-600">
                    {formatDateTime(event.starts_at)} · {event.venue}
                  </p>
                  <p className="mt-1 text-xs text-stone-500">/{event.slug} · capacity {event.capacity ?? "unlimited"}</p>
                </div>
                <span className="text-sm font-medium text-stone-500">Manage →</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
