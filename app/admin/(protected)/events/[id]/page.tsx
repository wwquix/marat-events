import Link from "next/link";
import { notFound } from "next/navigation";

import {
  validateAdminId,
  type EventStatus,
  type TicketAudience,
  type TicketStatus,
} from "@/lib/admin/events";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { EventForm, TicketForm, type TicketFormValue } from "../forms";

type EventAdminPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
};

type EventRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  venue: string;
  starts_at: string;
  capacity: number | null;
  status: EventStatus;
};

type TicketRow = {
  id: string;
  code: string;
  name: string;
  audience: TicketAudience;
  price_cents: number;
  currency: string;
  capacity: number | null;
  status: TicketStatus;
};

async function paidEventCount(eventId: string): Promise<number> {
  const { count, error } = await createSupabaseServerClient()
    .from("registrations")
    .select("id", { count: "exact", head: true })
    .eq("event_id", eventId)
    .eq("payment_status", "paid");
  if (error || count === null) throw new Error("Unable to load registration count.");
  return count;
}

async function paidTicketCount(ticketId: string): Promise<number> {
  const { count, error } = await createSupabaseServerClient()
    .from("registrations")
    .select("id", { count: "exact", head: true })
    .eq("ticket_type_id", ticketId)
    .eq("payment_status", "paid");
  if (error || count === null) throw new Error("Unable to load ticket count.");
  return count;
}

export default async function EventAdminPage({ params, searchParams }: EventAdminPageProps) {
  const eventId = validateAdminId((await params).id);
  if (!eventId) notFound();

  const supabase = createSupabaseServerClient();
  const [{ data: event, error: eventError }, { data: tickets, error: ticketsError }] =
    await Promise.all([
      supabase
        .from("events")
        .select("id,slug,title,description,venue,starts_at,capacity,status")
        .eq("id", eventId)
        .maybeSingle(),
      supabase
        .from("ticket_types")
        .select("id,code,name,audience,price_cents,currency,capacity,status")
        .eq("event_id", eventId)
        .order("created_at", { ascending: true }),
    ]);

  if (eventError || ticketsError) throw new Error("Unable to load event administration data.");
  if (!event) notFound();

  const typedEvent = event as EventRow;
  const typedTickets = (tickets ?? []) as TicketRow[];
  const [eventPaidCount, ticketsWithCounts] = await Promise.all([
    paidEventCount(eventId),
    Promise.all(
      typedTickets.map(
        async (ticket): Promise<TicketFormValue> => ({
          ...ticket,
          paidCount: await paidTicketCount(ticket.id),
        }),
      ),
    ),
  ]);
  const notice = await searchParams;

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href="/admin">
            Events
          </Link>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
            {typedEvent.title}
          </h1>
          <p className="mt-2 text-sm text-stone-600">
            {eventPaidCount} paid · {typedEvent.status}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            className="rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-800"
            href={`/admin/events/${eventId}/attendees`}
          >
            Attendees
          </Link>
          <a
            className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
            href={`/events/${typedEvent.slug}`}
            rel="noreferrer"
            target="_blank"
          >
            View public page
          </a>
        </div>
      </div>

      <Notice error={notice.error} saved={notice.saved} />

      {eventPaidCount > 0 ? (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Paid registrations exist. Event slug and sold ticket commercial terms are protected from destructive edits.
        </div>
      ) : null}

      <div className="mt-8 rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="mb-6 text-xl font-semibold text-stone-900">Event details</h2>
        <EventForm event={typedEvent} />
      </div>

      <div className="mt-10">
        <h2 className="text-xl font-semibold text-stone-900">Tickets</h2>
        <p className="mt-1 text-sm text-stone-600">
          Active tickets appear on the public registration page.
        </p>
        <div className="mt-5 space-y-4">
          {ticketsWithCounts.map((ticket) => (
            <TicketForm eventId={eventId} key={ticket.id} ticket={ticket} />
          ))}
          <TicketForm eventId={eventId} />
        </div>
      </div>
    </section>
  );
}

function Notice({ error, saved }: { error?: string; saved?: string }) {
  const errors: Record<string, string> = {
    invalid: "Check the event fields and try again.",
    ticket_invalid: "Check the ticket fields and try again.",
    not_found: "The event could not be found.",
    ticket_not_found: "The ticket could not be found.",
    slug_exists: "That event slug is already in use.",
    ticket_code_exists: "That ticket code is already in use for this event.",
    capacity_below_paid: "Capacity cannot be lower than the number of paid registrations.",
    locked_after_payment: "That field is locked because paid registrations already exist.",
    published_event_in_past: "A published event must be scheduled in the future.",
    database: "The change could not be saved. Try again.",
  };
  const savedMessages: Record<string, string> = {
    event_created: "Event created.",
    event_updated: "Event saved.",
    ticket_created: "Ticket added.",
    ticket_updated: "Ticket saved.",
  };
  if (error && errors[error]) {
    return (
      <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {errors[error]}
      </div>
    );
  }
  if (saved && savedMessages[saved]) {
    return (
      <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        {savedMessages[saved]}
      </div>
    );
  }
  return null;
}
