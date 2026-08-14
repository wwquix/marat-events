import Link from "next/link";
import { notFound } from "next/navigation";

import { formatAdminDateTime, formatAdminMoney } from "@/lib/admin/attendees";
import { validateAdminId } from "@/lib/admin/events";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type RegistrationPageProps = {
  params: Promise<{ id: string }>;
};

type EventRelation = {
  id: string;
  slug: string;
  title: string;
};

type TicketRelation = {
  id: string;
  code: string;
  name: string;
  audience: string;
};

type PersonRelation = {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  gender: string | null;
  created_at: string;
};

type RegistrationRow = {
  id: string;
  event_id: string;
  person_id: string | null;
  ticket_type_id: string | null;
  full_name: string;
  email: string;
  phone: string | null;
  age: number | null;
  gender: string | null;
  source: string | null;
  amount_cents: number;
  currency: string;
  payment_status: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  created_at: string;
  paid_at: string | null;
  refunded_at: string | null;
  events: EventRelation | EventRelation[] | null;
  ticket_types: TicketRelation | TicketRelation[] | null;
  people: PersonRelation | PersonRelation[] | null;
};

function firstRelation<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export default async function RegistrationPage({ params }: RegistrationPageProps) {
  const registrationId = validateAdminId((await params).id);
  if (!registrationId) notFound();

  const { data, error } = await createSupabaseServerClient()
    .from("registrations")
    .select([
      "id",
      "event_id",
      "person_id",
      "ticket_type_id",
      "full_name",
      "email",
      "phone",
      "age",
      "gender",
      "source",
      "amount_cents",
      "currency",
      "payment_status",
      "stripe_checkout_session_id",
      "stripe_payment_intent_id",
      "created_at",
      "paid_at",
      "refunded_at",
      "events(id,slug,title)",
      "ticket_types(id,code,name,audience)",
      "people(id,full_name,email,phone,gender,created_at)",
    ].join(","))
    .eq("id", registrationId)
    .maybeSingle();

  if (error) throw new Error("Unable to load registration details.");
  if (!data) notFound();

  const registration = data as unknown as RegistrationRow;
  const event = firstRelation(registration.events);
  const ticket = firstRelation(registration.ticket_types);
  const person = firstRelation(registration.people);

  return (
    <section>
      <div>
        {event ? (
          <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href={`/admin/events/${event.id}/attendees`}>
            ← {event.title} attendees
          </Link>
        ) : (
          <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href="/admin">← Events</Link>
        )}
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">{registration.full_name}</h1>
        <p className="mt-2 text-sm text-stone-600">Registration {registration.id}</p>
      </div>

      <div className="mt-7 grid gap-6 lg:grid-cols-2">
        <Card title="Registration snapshot">
          <Definition label="Name" value={registration.full_name} />
          <Definition label="Email" value={registration.email} />
          <Definition label="Phone" value={registration.phone ?? "—"} />
          <Definition label="Gender" value={registration.gender ?? "—"} />
          <Definition label="Age" value={registration.age?.toString() ?? "—"} />
          <Definition label="Source" value={registration.source ?? "—"} />
          <Definition label="Created" value={formatAdminDateTime(registration.created_at)} />
        </Card>

        <Card title="Central person">
          {person ? (
            <>
              <Definition label="Person ID" value={person.id} mono />
              <Definition label="Name" value={person.full_name} />
              <Definition label="Email" value={person.email} />
              <Definition label="Phone" value={person.phone ?? "—"} />
              <Definition label="Gender" value={person.gender ?? "—"} />
              <Definition label="Person created" value={formatAdminDateTime(person.created_at)} />
            </>
          ) : (
            <p className="text-sm text-amber-700">No central person is linked to this historical registration.</p>
          )}
        </Card>

        <Card title="Ticket and payment">
          <Definition label="Ticket" value={ticket?.name ?? "—"} />
          <Definition label="Ticket code" value={ticket?.code ?? "—"} />
          <Definition label="Audience" value={ticket?.audience ?? "—"} />
          <Definition label="Amount" value={formatAdminMoney(registration.amount_cents, registration.currency)} />
          <Definition label="Payment status" value={registration.payment_status} />
          <Definition label="Paid at" value={registration.paid_at ? formatAdminDateTime(registration.paid_at) : "—"} />
          <Definition label="Refunded at" value={registration.refunded_at ? formatAdminDateTime(registration.refunded_at) : "—"} />
        </Card>

        <Card title="Stripe references">
          <Definition label="Checkout Session" value={registration.stripe_checkout_session_id ?? "—"} mono />
          <Definition label="PaymentIntent" value={registration.stripe_payment_intent_id ?? "—"} mono />
          <p className="mt-4 text-xs leading-5 text-stone-500">
            These are operational references only. Payment state remains authoritative only after verified Stripe webhooks.
          </p>
        </Card>
      </div>
    </section>
  );
}

function Card({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <article className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-stone-900">{title}</h2>
      <dl className="mt-5 space-y-3">{children}</dl>
    </article>
  );
}

function Definition({ label, mono = false, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-sm font-medium text-stone-500">{label}</dt>
      <dd className={`break-words text-sm text-stone-900 ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
