import Link from "next/link";
import { notFound } from "next/navigation";

import {
  attendeeMatchesSearch,
  formatAdminDateTime,
  parseAttendeeFilters,
} from "@/lib/admin/attendees";
import { validateAdminId } from "@/lib/admin/events";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const REGISTRATION_FIELDS = [
  "id",
  "person_id",
  "ticket_type_id",
  "full_name",
  "email",
  "phone",
  "age",
  "gender",
  "source",
  "payment_status",
  "amount_cents",
  "currency",
  "created_at",
  "paid_at",
  "people(id,full_name,email,phone,gender)",
  "ticket_types(id,code,name,audience)",
].join(",");

type AttendeesPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type EventRow = {
  id: string;
  slug: string;
  title: string;
  starts_at: string;
};

type TicketOption = {
  id: string;
  code: string;
  name: string;
};

type PersonRelation = {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  gender: string | null;
};

type TicketRelation = {
  id: string;
  code: string;
  name: string;
  audience: string;
};

type RegistrationRow = {
  id: string;
  person_id: string | null;
  ticket_type_id: string | null;
  full_name: string;
  email: string;
  phone: string | null;
  age: number | null;
  gender: string | null;
  source: string | null;
  payment_status: string;
  amount_cents: number;
  currency: string;
  created_at: string;
  paid_at: string | null;
  people: PersonRelation | PersonRelation[] | null;
  ticket_types: TicketRelation | TicketRelation[] | null;
};

function firstRelation<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function statusClass(status: string): string {
  if (status === "paid") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (status === "pending") return "bg-amber-50 text-amber-800 ring-amber-200";
  if (status === "refunded") return "bg-sky-50 text-sky-800 ring-sky-200";
  return "bg-stone-100 text-stone-700 ring-stone-200";
}

export default async function AttendeesPage({ params, searchParams }: AttendeesPageProps) {
  const eventId = validateAdminId((await params).id);
  if (!eventId) notFound();

  const filters = parseAttendeeFilters(await searchParams);
  const supabase = createSupabaseServerClient();

  const [{ data: event, error: eventError }, { data: tickets, error: ticketError }] =
    await Promise.all([
      supabase
        .from("events")
        .select("id,slug,title,starts_at")
        .eq("id", eventId)
        .maybeSingle(),
      supabase
        .from("ticket_types")
        .select("id,code,name")
        .eq("event_id", eventId)
        .order("created_at", { ascending: true }),
    ]);

  if (eventError || ticketError) throw new Error("Unable to load attendee administration data.");
  if (!event) notFound();

  let registrationQuery = supabase
    .from("registrations")
    .select(REGISTRATION_FIELDS)
    .eq("event_id", eventId)
    .order("created_at", { ascending: false })
    .limit(500);

  if (filters.payment !== "all") {
    registrationQuery = registrationQuery.eq("payment_status", filters.payment);
  }
  if (filters.gender !== "all") {
    registrationQuery = registrationQuery.eq("gender", filters.gender);
  }
  if (filters.ticketId) {
    registrationQuery = registrationQuery.eq("ticket_type_id", filters.ticketId);
  }
  if (filters.source) {
    registrationQuery = registrationQuery.eq("source", filters.source);
  }

  const [{ data: registrations, error: registrationError }, { data: sourceRows, error: sourceError }] =
    await Promise.all([
      registrationQuery,
      supabase.from("registrations").select("source").eq("event_id", eventId).limit(500),
    ]);

  if (registrationError || sourceError) throw new Error("Unable to load registrations.");

  const typedEvent = event as EventRow;
  const typedTickets = (tickets ?? []) as TicketOption[];
  const typedRegistrations = (registrations ?? []) as unknown as RegistrationRow[];
  const visibleRegistrations = typedRegistrations.filter((row) => {
    const person = firstRelation(row.people);
    return attendeeMatchesSearch(
      {
        fullName: row.full_name,
        email: row.email,
        phone: row.phone,
        personFullName: person?.full_name,
        personEmail: person?.email,
        personPhone: person?.phone,
      },
      filters.query,
    );
  });
  const sources = Array.from(
    new Set(
      (sourceRows ?? [])
        .map((row) => (typeof row.source === "string" ? row.source : null))
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort();

  const exportParams = new URLSearchParams();
  if (filters.query) exportParams.set("q", filters.query);
  if (filters.payment !== "all") exportParams.set("payment", filters.payment);
  if (filters.gender !== "all") exportParams.set("gender", filters.gender);
  if (filters.ticketId) exportParams.set("ticket", filters.ticketId);
  if (filters.source) exportParams.set("source", filters.source);
  const exportSuffix = exportParams.size > 0 ? `?${exportParams.toString()}` : "";

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href={`/admin/events/${eventId}`}>
            ← {typedEvent.title}
          </Link>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">Attendees</h1>
          <p className="mt-2 text-sm text-stone-600">
            {formatAdminDateTime(typedEvent.starts_at)} · {visibleRegistrations.length} shown
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
            href={`/admin/events/${eventId}/attendees/export${exportSuffix}`}
          >
            Export CSV
          </a>
          <a
            className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
            href={`/events/${typedEvent.slug}`}
            rel="noreferrer"
            target="_blank"
          >
            Public page
          </a>
        </div>
      </div>

      <form className="mt-7 grid gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm md:grid-cols-5" method="get">
        <label className="text-sm font-medium text-stone-700 md:col-span-2">
          Search
          <input
            className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
            defaultValue={filters.query}
            maxLength={100}
            name="q"
            placeholder="Name, email or phone"
          />
        </label>

        <FilterSelect label="Payment" name="payment" value={filters.payment}>
          <option value="all">All payments</option>
          <option value="paid">Paid</option>
          <option value="pending">Pending</option>
          <option value="failed">Failed</option>
          <option value="refunded">Refunded</option>
        </FilterSelect>

        <FilterSelect label="Gender" name="gender" value={filters.gender}>
          <option value="all">All genders</option>
          <option value="male">Men</option>
          <option value="female">Women</option>
        </FilterSelect>

        <FilterSelect label="Ticket" name="ticket" value={filters.ticketId ?? "all"}>
          <option value="all">All tickets</option>
          {typedTickets.map((ticket) => (
            <option key={ticket.id} value={ticket.id}>{ticket.name}</option>
          ))}
        </FilterSelect>

        <FilterSelect label="Source" name="source" value={filters.source ?? "all"}>
          <option value="all">All sources</option>
          {sources.map((source) => <option key={source} value={source}>{source}</option>)}
        </FilterSelect>

        <div className="flex items-end gap-2 md:col-span-4">
          <button className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white" type="submit">
            Apply filters
          </button>
          <Link className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700" href={`/admin/events/${eventId}/attendees`}>
            Reset
          </Link>
        </div>
      </form>

      <div className="mt-6 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
        {visibleRegistrations.length === 0 ? (
          <div className="p-8 text-center text-sm text-stone-500">No registrations match these filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-stone-200 text-sm">
              <thead className="bg-stone-50 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                <tr>
                  <th className="px-4 py-3">Guest</th>
                  <th className="px-4 py-3">Ticket</th>
                  <th className="px-4 py-3">Gender / age</th>
                  <th className="px-4 py-3">Payment</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {visibleRegistrations.map((row) => {
                  const ticket = firstRelation(row.ticket_types);
                  return (
                    <tr className="hover:bg-stone-50" key={row.id}>
                      <td className="px-4 py-3">
                        <Link className="font-medium text-stone-900 hover:underline" href={`/admin/registrations/${row.id}`}>
                          {row.full_name}
                        </Link>
                        <p className="mt-0.5 text-xs text-stone-500">{row.email}</p>
                      </td>
                      <td className="px-4 py-3 text-stone-700">{ticket?.name ?? "—"}</td>
                      <td className="px-4 py-3 text-stone-700">
                        {row.gender ?? "—"}{row.age ? ` · ${row.age}` : ""}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset ${statusClass(row.payment_status)}`}>
                          {row.payment_status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-stone-700">{row.source ?? "—"}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-stone-500">{formatAdminDateTime(row.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {typedRegistrations.length >= 500 ? (
        <p className="mt-3 text-xs text-amber-700">Showing at most 500 registrations. Pagination will be added before production launch.</p>
      ) : null}
    </section>
  );
}

function FilterSelect({
  children,
  label,
  name,
  value,
}: {
  children: React.ReactNode;
  label: string;
  name: string;
  value: string;
}) {
  return (
    <label className="text-sm font-medium text-stone-700">
      {label}
      <select className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm" defaultValue={value} name={name}>
        {children}
      </select>
    </label>
  );
}
