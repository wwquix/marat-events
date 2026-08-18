import Link from "next/link";
import { notFound } from "next/navigation";

import {
  attendeeMatchesSearch,
  formatAdminDateTime,
  parseAttendeeFilters,
} from "@/lib/admin/attendees";
import {
  AttendeeLoadError,
  loadCompleteAttendeeRows,
  paginateAttendeeRows,
  parseAttendeePage,
} from "@/lib/admin/attendee-pagination";
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

type SourceRow = {
  id: string;
  source: string | null;
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

function attendeeListPath(
  eventId: string,
  filters: ReturnType<typeof parseAttendeeFilters>,
  page: number,
): string {
  const params = new URLSearchParams();
  if (filters.query) params.set("q", filters.query);
  if (filters.payment !== "all") params.set("payment", filters.payment);
  if (filters.gender !== "all") params.set("gender", filters.gender);
  if (filters.ticketId) params.set("ticket", filters.ticketId);
  if (filters.source) params.set("source", filters.source);
  if (page > 1) params.set("page", String(page));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return `/admin/events/${eventId}/attendees${suffix}`;
}

export default async function AttendeesPage({ params, searchParams }: AttendeesPageProps) {
  const eventId = validateAdminId((await params).id);
  if (!eventId) notFound();

  const resolvedSearchParams = await searchParams;
  const filters = parseAttendeeFilters(resolvedSearchParams);
  const requestedPage = parseAttendeePage(resolvedSearchParams.page);
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

  let typedRegistrations: RegistrationRow[];
  let sourceRows: SourceRow[];
  try {
    [typedRegistrations, sourceRows] = await Promise.all([
      loadCompleteAttendeeRows<RegistrationRow>(
        async (fromInclusive, toInclusive) => {
          let query = supabase
            .from("registrations")
            .select(REGISTRATION_FIELDS, { count: "exact" })
            .eq("event_id", eventId)
            .order("created_at", { ascending: false })
            .order("id", { ascending: true });

          if (filters.payment !== "all") {
            query = query.eq("payment_status", filters.payment);
          }
          if (filters.gender !== "all") {
            query = query.eq("gender", filters.gender);
          }
          if (filters.ticketId) {
            query = query.eq("ticket_type_id", filters.ticketId);
          }
          if (filters.source) {
            query = query.eq("source", filters.source);
          }

          const response = await query.range(fromInclusive, toInclusive);
          return {
            data: response.data as unknown as RegistrationRow[] | null,
            count: response.count,
            error: response.error,
          };
        },
        (row) => row.id,
      ),
      loadCompleteAttendeeRows<SourceRow>(
        async (fromInclusive, toInclusive) => {
          const response = await supabase
            .from("registrations")
            .select("id,source", { count: "exact" })
            .eq("event_id", eventId)
            .order("id", { ascending: true })
            .range(fromInclusive, toInclusive);
          return {
            data: response.data as SourceRow[] | null,
            count: response.count,
            error: response.error,
          };
        },
        (row) => row.id,
      ),
    ]);
  } catch (error) {
    if (error instanceof AttendeeLoadError && error.code === "limit_exceeded") {
      throw new Error("This event exceeds the 5,000-registration administration limit.");
    }
    throw new Error("Unable to load complete registration data.");
  }

  const typedEvent = event as EventRow;
  const typedTickets = (tickets ?? []) as TicketOption[];
  const matchingRegistrations = typedRegistrations.filter((row) => {
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
  const attendeePage = paginateAttendeeRows(matchingRegistrations, requestedPage);
  const sources = Array.from(
    new Set(
      sourceRows
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
            {formatAdminDateTime(typedEvent.starts_at)} · {attendeePage.firstRow}–{attendeePage.lastRow} of {attendeePage.totalRows} matching
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
        {attendeePage.rows.length === 0 ? (
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
                {attendeePage.rows.map((row) => {
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

      {attendeePage.totalPages > 1 ? (
        <nav aria-label="Attendee pages" className="mt-6 flex items-center justify-between text-sm">
          {attendeePage.page > 1 ? (
            <Link
              className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-700"
              href={attendeeListPath(eventId, filters, attendeePage.page - 1)}
            >
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-stone-600">Page {attendeePage.page} of {attendeePage.totalPages}</span>
          {attendeePage.page < attendeePage.totalPages ? (
            <Link
              className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-700"
              href={attendeeListPath(eventId, filters, attendeePage.page + 1)}
            >
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
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
