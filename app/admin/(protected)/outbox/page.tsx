import Link from "next/link";

import { createSupabaseServerClient } from "@/lib/supabase/server";

type OutboxRow = {
  id: string;
  campaign_id: string;
  status: string;
  delivery_mode: string;
  channel: string;
  destination_snapshot: string;
  attempt_count: number;
  last_result_code: string | null;
  available_at: string;
  updated_at: string;
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const OUTBOX_PAGE_SIZE = 100;

function firstParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function readPage(value: string | null): number {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown date"
    : new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

export default async function OutboxPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const supabase = createSupabaseServerClient();
  const countResult = await supabase
    .from("outbox_messages")
    .select("id", { count: "exact", head: true });

  if (countResult.error || countResult.count === null) {
    throw new Error("Unable to load the outbound outbox.");
  }

  const totalPages = Math.max(1, Math.ceil(countResult.count / OUTBOX_PAGE_SIZE));
  const currentPage = Math.min(readPage(firstParam(params.page)), totalPages);
  const from = (currentPage - 1) * OUTBOX_PAGE_SIZE;
  const to = from + OUTBOX_PAGE_SIZE - 1;
  const { data, error } = await supabase
    .from("outbox_messages")
    .select("id,campaign_id,status,delivery_mode,channel,destination_snapshot,attempt_count,last_result_code,available_at,updated_at")
    .order("updated_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to);

  if (error) throw new Error("Unable to load the outbound outbox.");
  const messages = (data ?? []) as OutboxRow[];

  return (
    <section>
      <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href="/admin/campaigns">
        ← Campaigns
      </Link>
      <div className="mt-3">
        <p className="text-sm font-medium text-stone-500">Durable delivery boundary</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-stone-900">Outbound outbox</h1>
        <p className="mt-2 max-w-3xl text-stone-600">
          Due work is claimed with bounded leases and idempotency keys. This phase exposes only disabled and dry-run
          adapters; <strong>provider_called is always false</strong> in persisted attempts.
        </p>
      </div>

      <div className="mt-7 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
        {messages.length === 0 ? (
          <p className="p-6 text-sm text-stone-500">No outbox rows yet.</p>
        ) : (
          <div className="divide-y divide-stone-100">
            {messages.map((message) => (
              <div className="grid gap-2 px-5 py-4 lg:grid-cols-[1fr_auto_auto] lg:items-center" key={message.id}>
                <div>
                  <p className="font-medium text-stone-900">{message.destination_snapshot}</p>
                  <p className="mt-1 text-xs text-stone-500">
                    {message.channel} · {message.delivery_mode} · attempt {message.attempt_count} · due {formatDate(message.available_at)}
                  </p>
                  {message.last_result_code ? <p className="mt-1 text-xs text-stone-600">result: {message.last_result_code}</p> : null}
                </div>
                <span className="rounded-full bg-stone-100 px-3 py-1 text-sm font-medium text-stone-700">{message.status}</span>
                <Link className="text-sm font-medium text-stone-700 hover:text-stone-950" href={`/admin/campaigns/${message.campaign_id}`}>
                  Campaign →
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
      {countResult.count > 0 ? (
        <p className="mt-3 text-xs text-stone-500">
          Showing {from + 1}–{Math.min(to + 1, countResult.count)} of {countResult.count} durable messages.
        </p>
      ) : null}
      {totalPages > 1 ? (
        <nav aria-label="Outbox pages" className="mt-5 flex items-center justify-between text-sm">
          {currentPage > 1 ? (
            <Link className="rounded-lg border border-stone-300 bg-white px-3 py-2" href={`/admin/outbox?page=${currentPage - 1}`}>
              Previous
            </Link>
          ) : <span />}
          <span className="text-stone-600">Page {currentPage} of {totalPages}</span>
          {currentPage < totalPages ? (
            <Link className="rounded-lg border border-stone-300 bg-white px-3 py-2" href={`/admin/outbox?page=${currentPage + 1}`}>
              Next
            </Link>
          ) : <span />}
        </nav>
      ) : null}
    </section>
  );
}
