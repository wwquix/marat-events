import Link from "next/link";
import { notFound } from "next/navigation";

import {
  dispatchCampaignBatchAction,
  queueCampaignOutboxAction,
} from "@/app/admin/(protected)/campaigns/actions";
import { validateAdminId } from "@/lib/admin/events";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type CampaignRow = {
  id: string;
  audience_selection_id: string;
  name: string;
  status: string;
  delivery_mode: string;
  channel: string;
  recipient_count: number;
  sending_time_zone: string;
  sending_window_start: string;
  sending_window_end: string;
  allowed_weekdays: number[];
  scheduled_at: string;
  selection_updated_at_snapshot: string;
  created_by: string;
  created_at: string;
  queued_at: string | null;
  completed_at: string | null;
};

type RecipientRow = {
  id: string;
  ordinal: number;
  person_id: string;
  destination_snapshot: string;
  consent_status_snapshot: string;
  contactability_status_snapshot: string;
  policy_reason: string;
  rendered_subject_snapshot: string | null;
  rendered_body_snapshot: string;
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const ERROR_MESSAGES: Record<string, string> = {
  queue_blocked: "Queue creation was blocked. The preview and any existing outbox rows were left unchanged.",
  dispatch_blocked: "The batch stopped safely. Claimed work will become reclaimable after its bounded lease.",
};

const SAVED_MESSAGES: Record<string, string> = {
  preview_created: "Immutable campaign preview created. Nothing has been sent.",
  queued: "Durable outbox created. Nothing has been sent to a provider.",
  batch_processed: "The batch completed through a local disabled or dry-run adapter. No provider was called.",
  no_due_work: "No outbox work is due inside the configured sending window.",
};

const OUTBOX_STATES = [
  "pending",
  "claimed",
  "retry_scheduled",
  "blocked",
  "dry_run_completed",
  "disabled",
  "failed",
  "cancelled",
] as const;

const RECIPIENT_PAGE_SIZE = 100;

function firstParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function readPage(value: string | null): number {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown date"
    : new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const [{ id: rawId }, query] = await Promise.all([params, searchParams]);
  const campaignId = validateAdminId(rawId);
  if (!campaignId) notFound();

  const supabase = createSupabaseServerClient();
  const campaignResult = await supabase
    .from("campaigns")
    .select("id,audience_selection_id,name,status,delivery_mode,channel,recipient_count,sending_time_zone,sending_window_start,sending_window_end,allowed_weekdays,scheduled_at,selection_updated_at_snapshot,created_by,created_at,queued_at,completed_at")
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignResult.error) throw new Error("Unable to load campaign preview.");
  if (!campaignResult.data) notFound();

  const campaign = campaignResult.data as CampaignRow;
  const totalPages = Math.max(1, Math.ceil(campaign.recipient_count / RECIPIENT_PAGE_SIZE));
  const currentPage = Math.min(readPage(firstParam(query.page)), totalPages);
  const from = (currentPage - 1) * RECIPIENT_PAGE_SIZE;
  const to = from + RECIPIENT_PAGE_SIZE - 1;
  const [recipientResult, ...outboxCountResults] = await Promise.all([
    supabase
      .from("campaign_recipients")
      .select("id,ordinal,person_id,destination_snapshot,consent_status_snapshot,contactability_status_snapshot,policy_reason,rendered_subject_snapshot,rendered_body_snapshot", { count: "exact" })
      .eq("campaign_id", campaignId)
      .order("ordinal", { ascending: true })
      .range(from, to),
    ...OUTBOX_STATES.map((status) =>
      supabase
        .from("outbox_messages")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaignId)
        .eq("status", status),
    ),
  ]);

  if (
    recipientResult.error ||
    recipientResult.count === null ||
    recipientResult.count !== campaign.recipient_count ||
    outboxCountResults.some((result) => result.error)
  ) {
    throw new Error("Unable to load campaign preview.");
  }

  const recipients = (recipientResult.data ?? []) as RecipientRow[];
  const statusCounts = Object.fromEntries(
    OUTBOX_STATES.map((status, index) => [status, outboxCountResults[index]?.count ?? 0]),
  );
  const outboxTotal = Object.values(statusCounts).reduce((total, count) => total + count, 0);
  const errorCode = firstParam(query.error);
  const savedCode = firstParam(query.saved);
  const errorMessage = errorCode ? ERROR_MESSAGES[errorCode] : null;
  const savedMessage = savedCode ? SAVED_MESSAGES[savedCode] : null;

  return (
    <section>
      <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href="/admin/campaigns">
        ← Campaigns
      </Link>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-stone-500">{campaign.delivery_mode} · {campaign.channel}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-stone-900">{campaign.name}</h1>
          <p className="mt-2 text-stone-600">
            {campaign.recipient_count} immutable recipients · status {campaign.status}
          </p>
        </div>
        <Link className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium" href="/admin/outbox">
          Inspect outbox
        </Link>
        <Link
          className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium"
          href={`/admin/audience/segments/selections/${campaign.audience_selection_id}`}
        >
          Audience reasons
        </Link>
      </div>

      {errorMessage ? <p className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{errorMessage}</p> : null}
      {savedMessage ? <p className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{savedMessage}</p> : null}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Created" value={formatDate(campaign.created_at)} />
        <Stat label="Scheduled" value={formatDate(campaign.scheduled_at)} />
        <Stat label="Window" value={`${campaign.sending_window_start.slice(0, 5)}–${campaign.sending_window_end.slice(0, 5)} ${campaign.sending_time_zone}`} />
        <Stat label="Weekdays" value={campaign.allowed_weekdays.join(", ")} />
      </div>

      <div className="mt-6 flex flex-wrap gap-3 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        {campaign.status === "previewed" ? (
          <form action={queueCampaignOutboxAction}>
            <input name="campaign_id" type="hidden" value={campaign.id} />
            <button className="rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white" type="submit">
              Create durable outbox
            </button>
          </form>
        ) : null}
        {campaign.status === "queued" || campaign.status === "processing" ? (
          <form action={dispatchCampaignBatchAction}>
            <input name="campaign_id" type="hidden" value={campaign.id} />
            <button className="rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white" type="submit">
              Process up to 50 locally
            </button>
          </form>
        ) : null}
        <p className="self-center text-sm text-stone-600">
          Provider calls are structurally unavailable. Policy runs before either local adapter.
        </p>
      </div>

      <div className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="font-semibold text-stone-900">Outbox state</h2>
        {outboxTotal === 0 ? (
          <p className="mt-2 text-sm text-stone-500">Outbox not created.</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(statusCounts).filter(([, count]) => count > 0).map(([status, count]) => (
              <span className="rounded-full bg-stone-100 px-3 py-1 text-sm text-stone-700" key={status}>{status}: {count}</span>
            ))}
          </div>
        )}
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
        <div className="border-b border-stone-200 px-5 py-4">
          <h2 className="font-semibold text-stone-900">Recipient snapshot</h2>
          <p className="mt-1 text-xs text-stone-500">
            Showing {campaign.recipient_count === 0 ? 0 : from + 1}–{Math.min(to + 1, campaign.recipient_count)} of {campaign.recipient_count}.
            Destinations and rendered content are privileged admin data. Audience criteria snapshot: {formatDate(campaign.selection_updated_at_snapshot)}.
          </p>
        </div>
        <div className="divide-y divide-stone-100">
          {recipients.map((recipient) => (
            <div className="grid gap-2 px-5 py-3 text-sm sm:grid-cols-[5rem_1fr_auto]" key={recipient.id}>
              <span className="text-stone-500">#{recipient.ordinal}</span>
              <div>
                <p className="font-medium text-stone-900">{recipient.destination_snapshot}</p>
                <p className="mt-0.5 text-xs text-stone-500">person {recipient.person_id.slice(0, 8)} · {recipient.consent_status_snapshot} · {recipient.contactability_status_snapshot}</p>
                <details className="mt-2 text-xs text-stone-600">
                  <summary className="cursor-pointer font-medium">Rendered message</summary>
                  {recipient.rendered_subject_snapshot ? <p className="mt-2 font-medium">{recipient.rendered_subject_snapshot}</p> : null}
                  <p className="mt-1 whitespace-pre-wrap">{recipient.rendered_body_snapshot}</p>
                </details>
              </div>
              <span className="text-stone-600">{recipient.policy_reason}</span>
            </div>
          ))}
        </div>
      </div>
      {totalPages > 1 ? (
        <nav aria-label="Campaign recipient pages" className="mt-5 flex items-center justify-between text-sm">
          {currentPage > 1 ? (
            <Link className="rounded-lg border border-stone-300 bg-white px-3 py-2" href={`/admin/campaigns/${campaign.id}?page=${currentPage - 1}`}>
              Previous
            </Link>
          ) : <span />}
          <span className="text-stone-600">Page {currentPage} of {totalPages}</span>
          {currentPage < totalPages ? (
            <Link className="rounded-lg border border-stone-300 bg-white px-3 py-2" href={`/admin/campaigns/${campaign.id}?page=${currentPage + 1}`}>
              Next
            </Link>
          ) : <span />}
        </nav>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-stone-900">{value}</p>
    </div>
  );
}
