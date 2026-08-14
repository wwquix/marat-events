import { notFound } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type EventRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  venue: string;
  starts_at: string;
  capacity: number | null;
  status: string;
};

type TicketTypeRow = {
  id: string;
  name: string;
  audience: "male" | "female" | "any";
  price_cents: number;
  currency: string;
  capacity: number | null;
  status: string;
};

type EventPageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ checkout_error?: string | string[] }>;
};

const EVENT_FIELDS = "id,slug,title,description,venue,starts_at,capacity,status";
const TICKET_FIELDS = "id,name,audience,price_cents,currency,capacity,status";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidEventRow(value: unknown, requestedSlug: string): value is EventRow {
  if (!value || typeof value !== "object") {
    return false;
  }

  const row = value as Record<string, unknown>;
  const startsAtIsValid =
    typeof row.starts_at === "string" && !Number.isNaN(Date.parse(row.starts_at));

  return (
    typeof row.id === "string" &&
    UUID_PATTERN.test(row.id) &&
    row.slug === requestedSlug &&
    typeof row.title === "string" &&
    row.title.trim().length > 0 &&
    typeof row.description === "string" &&
    typeof row.venue === "string" &&
    startsAtIsValid &&
    (row.capacity === null || isNonNegativeInteger(row.capacity)) &&
    typeof row.status === "string"
  );
}

function isValidTicketTypeRow(value: unknown): value is TicketTypeRow {
  if (!value || typeof value !== "object") {
    return false;
  }

  const row = value as Record<string, unknown>;

  return (
    typeof row.id === "string" &&
    UUID_PATTERN.test(row.id) &&
    typeof row.name === "string" &&
    row.name.trim().length > 0 &&
    (row.audience === "male" || row.audience === "female" || row.audience === "any") &&
    isNonNegativeInteger(row.price_cents) &&
    typeof row.currency === "string" &&
    /^[A-Z]{3}$/.test(row.currency) &&
    (row.capacity === null || isNonNegativeInteger(row.capacity)) &&
    typeof row.status === "string"
  );
}

function SafeFailure() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl items-center px-6 py-16">
      <section className="max-w-xl rounded-2xl bg-white p-8 shadow-sm ring-1 ring-stone-200">
        <h1 className="text-2xl font-semibold text-stone-900">Event unavailable</h1>
        <p className="mt-3 text-stone-700">We cannot display this event right now.</p>
      </section>
    </main>
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function formatPrice(priceCents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(priceCents / 100);
}

function audienceLabel(audience: TicketTypeRow["audience"]): string {
  if (audience === "male") return "Men";
  if (audience === "female") return "Women";
  return "All guests";
}

const CHECKOUT_ERROR_MESSAGES: Record<string, string> = {
  invalid: "Enter valid registration details in every field.",
  unavailable: "That ticket is not currently available for this event.",
  sold_out: "That ticket or this event is sold out.",
  database: "Checkout is temporarily unavailable. Please try again later.",
  stripe: "Stripe Checkout could not be started. Please try again.",
};

export default async function EventPage({ params, searchParams }: EventPageProps) {
  const { slug } = await params;
  const { checkout_error: checkoutErrorParam } = await searchParams;
  const checkoutErrorCode = Array.isArray(checkoutErrorParam)
    ? checkoutErrorParam[0]
    : checkoutErrorParam;
  const checkoutError = checkoutErrorCode
    ? CHECKOUT_ERROR_MESSAGES[checkoutErrorCode]
    : undefined;
  let event: unknown;
  let ticketTypes: unknown[] = [];
  let hasOperationalFailure = false;

  try {
    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("events")
      .select(EVENT_FIELDS)
      .eq("slug", slug)
      .maybeSingle();

    if (error) {
      hasOperationalFailure = true;
    } else {
      event = data;
    }

    if (isValidEventRow(event, slug)) {
      const { data: ticketData, error: ticketError } = await supabase
        .from("ticket_types")
        .select(TICKET_FIELDS)
        .eq("event_id", event.id)
        .eq("status", "active")
        .gt("price_cents", 0)
        .order("price_cents", { ascending: true });

      if (ticketError) {
        hasOperationalFailure = true;
      } else {
        ticketTypes = ticketData ?? [];
      }
    }
  } catch {
    hasOperationalFailure = true;
  }

  if (hasOperationalFailure) {
    return <SafeFailure />;
  }

  if (event === null) {
    notFound();
  }

  if (!isValidEventRow(event, slug)) {
    return <SafeFailure />;
  }

  if (event.status !== "published") {
    notFound();
  }

  if (!ticketTypes.every(isValidTicketTypeRow)) {
    return <SafeFailure />;
  }

  const availableTickets = ticketTypes as TicketTypeRow[];

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-16">
      <article className="space-y-8 rounded-2xl bg-white p-8 shadow-sm ring-1 ring-stone-200">
        <header className="space-y-3">
          <p className="text-sm font-medium tracking-wide text-stone-500">Marat Events</p>
          <h1 className="text-3xl font-semibold tracking-tight text-stone-900">{event.title}</h1>
          <p className="whitespace-pre-wrap text-stone-700">{event.description}</p>
        </header>

        <dl className="space-y-3 text-stone-700">
          <div>
            <dt className="font-medium text-stone-900">Venue</dt>
            <dd>{event.venue}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-900">Date and time</dt>
            <dd>{formatDateTime(event.starts_at)}</dd>
          </div>
          {event.capacity !== null ? (
            <div>
              <dt className="font-medium text-stone-900">Event capacity</dt>
              <dd>{event.capacity}</dd>
            </div>
          ) : null}
        </dl>

        {availableTickets.length === 0 ? (
          <p className="rounded-lg bg-stone-100 px-4 py-3 text-stone-700">
            Tickets are not currently available for this event.
          </p>
        ) : (
          <form action="/api/checkout" className="space-y-5" method="post">
            <input name="slug" type="hidden" value={event.slug} />

            {checkoutError ? (
              <p
                aria-live="polite"
                className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 ring-1 ring-red-200"
                role="alert"
              >
                {checkoutError}
              </p>
            ) : null}

            <div className="space-y-2">
              <label className="block text-sm font-medium text-stone-900" htmlFor="ticket_type_id">
                Ticket
              </label>
              <select
                className="min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-base text-stone-900 outline-none focus:border-stone-600 focus:ring-2 focus:ring-stone-200"
                defaultValue=""
                id="ticket_type_id"
                name="ticket_type_id"
                required
              >
                <option disabled value="">
                  Select a ticket
                </option>
                {availableTickets.map((ticket) => (
                  <option key={ticket.id} value={ticket.id}>
                    {ticket.name} · {audienceLabel(ticket.audience)} · {formatPrice(ticket.price_cents, ticket.currency)}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-stone-900" htmlFor="full_name">
                Full name
              </label>
              <input
                autoComplete="name"
                className="min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-base text-stone-900 outline-none focus:border-stone-600 focus:ring-2 focus:ring-stone-200"
                id="full_name"
                maxLength={100}
                minLength={2}
                name="full_name"
                required
                type="text"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-stone-900" htmlFor="email">
                Email
              </label>
              <input
                autoComplete="email"
                className="min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-base text-stone-900 outline-none focus:border-stone-600 focus:ring-2 focus:ring-stone-200"
                id="email"
                maxLength={254}
                name="email"
                required
                type="email"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-stone-900" htmlFor="phone">
                Phone
              </label>
              <input
                autoComplete="tel"
                className="min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-base text-stone-900 outline-none focus:border-stone-600 focus:ring-2 focus:ring-stone-200"
                id="phone"
                maxLength={30}
                name="phone"
                placeholder="+1 212 555 0123"
                required
                type="tel"
              />
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-stone-900" htmlFor="age">
                  Age
                </label>
                <input
                  className="min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-base text-stone-900 outline-none focus:border-stone-600 focus:ring-2 focus:ring-stone-200"
                  id="age"
                  max={120}
                  min={18}
                  name="age"
                  required
                  type="number"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-stone-900" htmlFor="gender">
                  Gender
                </label>
                <select
                  className="min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-base text-stone-900 outline-none focus:border-stone-600 focus:ring-2 focus:ring-stone-200"
                  defaultValue=""
                  id="gender"
                  name="gender"
                  required
                >
                  <option disabled value="">
                    Select
                  </option>
                  <option value="female">Woman</option>
                  <option value="male">Man</option>
                </select>
              </div>
            </div>

            <button
              className="min-h-11 w-full rounded-lg bg-stone-900 px-4 py-2 font-medium text-white hover:bg-stone-700 focus:outline-none focus:ring-2 focus:ring-stone-500 focus:ring-offset-2 sm:w-auto"
              type="submit"
            >
              Continue to payment
            </button>
          </form>
        )}
      </article>
    </main>
  );
}
