import Link from "next/link";
import { notFound } from "next/navigation";

import {
  parseEventAnalytics,
  type EventAnalytics,
  type TicketAnalytics,
} from "@/lib/analytics/event";
import { validateAdminId } from "@/lib/admin/events";
import { requireAdminSession } from "@/lib/admin/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type AnalyticsPageProps = {
  params: Promise<{ eventId: string }>;
};

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${cents} ${currency}`;
  }
}

function Stat({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-stone-900">{value}</p>
      {note ? <p className="mt-1 text-xs text-stone-500">{note}</p> : null}
    </div>
  );
}

function TicketRow({ ticket }: { ticket: TicketAnalytics }) {
  return (
    <tr className="border-t border-stone-100">
      <td className="px-4 py-3">
        <p className="font-medium text-stone-900">{ticket.name}</p>
        <p className="text-xs text-stone-500">{ticket.code}</p>
      </td>
      <td className="px-4 py-3 text-right">{ticket.registrationCount}</td>
      <td className="px-4 py-3 text-right">{ticket.paidCount}</td>
      <td className="px-4 py-3 text-right">{ticket.checkedInCount}</td>
      <td className="px-4 py-3 text-right">{formatMoney(ticket.paidRevenueCents, ticket.currency)}</td>
    </tr>
  );
}

function AnalyticsView({ analytics }: { analytics: EventAnalytics }) {
  const capacity = analytics.eventCapacity === null ? "No cap" : analytics.eventCapacity;
  const capacityNote = analytics.eventCapacity === null
    ? "Event capacity is not configured"
    : analytics.oversoldBy && analytics.oversoldBy > 0
      ? `${analytics.oversoldBy} paid registrations above capacity`
      : `${analytics.remainingCapacity ?? 0} places remaining by paid count`;

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href={`/admin/events/${analytics.eventId}`}>
            ← Event administration
          </Link>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
            Analytics · {analytics.eventTitle}
          </h1>
          <p className="mt-2 text-sm text-stone-600">{formatDateTime(analytics.startsAt)}</p>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-500">
            Live operational counts computed from audience, campaign, registration, check-in, and matching rows.
            They are not mutable counters and do not prove provider delivery.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700" href={`/admin/analytics/${analytics.eventId}/export/event-summary`}>
            Export summary
          </a>
          <a className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700" href={`/admin/analytics/${analytics.eventId}/export/attendees`}>
            Export attendees
          </a>
          <a className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700" href={`/admin/analytics/${analytics.eventId}/export/matches`}>
            Export matches
          </a>
        </div>
      </div>

      {analytics.audienceLimitExceeded ? (
        <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          At least one audience selection exceeds the supported 5,000-person evaluation boundary. Audience counts are
          incomplete until the selection is narrowed.
        </p>
      ) : null}

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Eligible audience" note={`${analytics.activeSelectionCount} active selections`} value={analytics.eligiblePeople} />
        <Stat label="Campaign recipients" note={`${analytics.campaignRecipientPeople} distinct people`} value={analytics.campaignRecipientCount} />
        <Stat label="Paid registrations" note={`${analytics.paidPeople} linked people`} value={analytics.paidRegistrationCount} />
        <Stat label="Checked in" note={`${analytics.checkedInPeople} linked people`} value={analytics.checkedInRegistrationCount} />
        <Stat label="Paid revenue" note={analytics.eventCurrency} value={formatMoney(analytics.paidRevenueCents, analytics.eventCurrency)} />
        <Stat label="Capacity" note={capacityNote} value={capacity} />
        <Stat label="Matching participants" note={`${analytics.likedProfileCount} profiles have liked`} value={analytics.matchingParticipantCount} />
        <Stat label="Matches" note={`${analytics.likeCount} one-way like records · ${analytics.matchedProfileCount} matched profiles`} value={analytics.matchCount} />
      </div>

      <div className="mt-10 grid gap-6 xl:grid-cols-2">
        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
          <div className="border-b border-stone-100 px-4 py-3">
            <h2 className="font-semibold text-stone-900">Ticket split</h2>
          </div>
          {analytics.tickets.length === 0 ? (
            <p className="p-6 text-sm text-stone-500">No ticket types or registrations yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-stone-700">
                <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                  <tr>
                    <th className="px-4 py-3">Ticket</th>
                    <th className="px-4 py-3 text-right">Registrations</th>
                    <th className="px-4 py-3 text-right">Paid</th>
                    <th className="px-4 py-3 text-right">Checked in</th>
                    <th className="px-4 py-3 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody>{analytics.tickets.map((ticket) => <TicketRow key={ticket.ticketTypeId ?? "unassigned"} ticket={ticket} />)}</tbody>
              </table>
            </div>
          )}
        </div>

        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
          <div className="border-b border-stone-100 px-4 py-3">
            <h2 className="font-semibold text-stone-900">Registration sources</h2>
          </div>
          {analytics.sources.length === 0 ? (
            <p className="p-6 text-sm text-stone-500">No registrations yet.</p>
          ) : (
            <div className="divide-y divide-stone-100">
              {analytics.sources.map((source) => (
                <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm" key={source.source}>
                  <span className="font-medium text-stone-900">{source.source}</span>
                  <span className="text-stone-500">
                    {source.registrationCount} total · {source.paidCount} paid · {source.checkedInCount} checked in
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-10 grid gap-6 xl:grid-cols-2">
        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
          <div className="border-b border-stone-100 px-4 py-3">
            <h2 className="font-semibold text-stone-900">Audience selections</h2>
          </div>
          {analytics.selections.length === 0 ? (
            <p className="p-6 text-sm text-stone-500">No active event audience selections.</p>
          ) : (
            <div className="divide-y divide-stone-100">
              {analytics.selections.map((selection) => (
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" key={selection.selectionId}>
                  <div>
                    <p className="font-medium text-stone-900">{selection.name}</p>
                    <p className="mt-1 text-xs text-stone-500">
                      {selection.eligibleCount} eligible of {selection.evaluatedCount} evaluated
                      {selection.limitExceeded ? " · limit exceeded" : ""}
                    </p>
                  </div>
                  <a className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-medium text-stone-700" href={`/admin/analytics/${analytics.eventId}/export/audience?selectionId=${selection.selectionId}`}>
                    Export audience
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
          <div className="border-b border-stone-100 px-4 py-3">
            <h2 className="font-semibold text-stone-900">Campaigns and outbox</h2>
            <p className="mt-1 text-xs text-stone-500">
              {analytics.campaignCount} campaigns · {analytics.outboxMessageCount} outbox rows
            </p>
          </div>
          {analytics.campaigns.length === 0 ? (
            <p className="p-6 text-sm text-stone-500">No campaigns yet.</p>
          ) : (
            <div className="divide-y divide-stone-100">
              {analytics.campaigns.map((campaign) => (
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" key={campaign.campaignId}>
                  <div>
                    <p className="font-medium text-stone-900">{campaign.name}</p>
                    <p className="mt-1 text-xs text-stone-500">
                      {campaign.channel} · {campaign.deliveryMode} · {campaign.status} · {campaign.recipientCount} recipients
                    </p>
                    <p className="mt-1 text-xs text-stone-500">
                      {Object.entries(campaign.outboxStatuses).map(([status, count]) => `${status}: ${count}`).join(" · ") || "No outbox rows"}
                    </p>
                  </div>
                  <a className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-medium text-stone-700" href={`/admin/analytics/${analytics.eventId}/export/campaign-results?campaignId=${campaign.campaignId}`}>
                    Export results
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default async function EventAnalyticsPage({ params }: AnalyticsPageProps) {
  await requireAdminSession();
  const eventId = validateAdminId((await params).eventId);
  if (!eventId) notFound();

  const { data, error } = await createSupabaseServerClient()
    .rpc("get_event_analytics", { p_event_id: eventId })
    .maybeSingle();
  if (error) throw new Error("Unable to load event analytics.");
  if (!data) notFound();

  const analytics = parseEventAnalytics(data);
  if (!analytics) {
    return (
      <section className="rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-stone-900">Analytics unavailable</h1>
        <p className="mt-2 text-sm text-stone-600">
          The analytics result could not be validated. No database details were exposed.
        </p>
      </section>
    );
  }

  return <AnalyticsView analytics={analytics} />;
}
