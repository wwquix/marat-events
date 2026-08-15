import { NextRequest, NextResponse } from "next/server";

import { attendeeMatchesSearch, parseAttendeeFilters } from "@/lib/admin/attendees";
import { buildCsv, csvDownloadFilename, type CsvCell } from "@/lib/admin/csv";
import { validateAdminId } from "@/lib/admin/events";
import { getAdminSession } from "@/lib/admin/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 1000;
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

const CSV_HEADERS = [
  "registration_id",
  "person_id",
  "registration_name",
  "registration_email",
  "registration_phone",
  "age",
  "gender",
  "source",
  "payment_status",
  "ticket_code",
  "ticket_name",
  "amount_cents",
  "currency",
  "created_at_utc",
  "paid_at_utc",
  "central_name",
  "central_email",
  "central_phone",
  "central_gender",
] as const;

type ExportRouteContext = {
  params: Promise<{ id: string }>;
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

function searchParamsRecord(searchParams: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    if (!(key in result)) result[key] = value;
  }
  return result;
}

function toCsvRow(row: RegistrationRow): CsvCell[] {
  const person = firstRelation(row.people);
  const ticket = firstRelation(row.ticket_types);

  return [
    row.id,
    row.person_id,
    row.full_name,
    row.email,
    row.phone,
    row.age,
    row.gender,
    row.source,
    row.payment_status,
    ticket?.code,
    ticket?.name,
    row.amount_cents,
    row.currency,
    row.created_at,
    row.paid_at,
    person?.full_name,
    person?.email,
    person?.phone,
    person?.gender,
  ];
}

export async function GET(request: NextRequest, context: ExportRouteContext) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.redirect(new URL("/admin/login", request.url), 303);
  }

  const eventId = validateAdminId((await context.params).id);
  if (!eventId) {
    return new NextResponse("Not found", { status: 404 });
  }

  const filters = parseAttendeeFilters(searchParamsRecord(request.nextUrl.searchParams));
  const supabase = createSupabaseServerClient();
  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id,slug")
    .eq("id", eventId)
    .maybeSingle();

  if (eventError) {
    return new NextResponse("Unable to export attendees.", { status: 500 });
  }
  if (!event || typeof event.slug !== "string") {
    return new NextResponse("Not found", { status: 404 });
  }

  const matchingRows: RegistrationRow[] = [];
  let offset = 0;

  while (true) {
    let query = supabase
      .from("registrations")
      .select(REGISTRATION_FIELDS)
      .eq("event_id", eventId)
      .order("created_at", { ascending: false });

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

    const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      return new NextResponse("Unable to export attendees.", { status: 500 });
    }

    const batch = (data ?? []) as unknown as RegistrationRow[];
    for (const row of batch) {
      const person = firstRelation(row.people);
      if (
        attendeeMatchesSearch(
          {
            fullName: row.full_name,
            email: row.email,
            phone: row.phone,
            personFullName: person?.full_name,
            personEmail: person?.email,
            personPhone: person?.phone,
          },
          filters.query,
        )
      ) {
        matchingRows.push(row);
      }
    }

    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const csv = buildCsv(CSV_HEADERS, matchingRows.map(toCsvRow));

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${csvDownloadFilename(event.slug)}"`,
      "Content-Type": "text/csv; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
