import type Stripe from "stripe";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE_ALLOWED_PATTERN = /^[0-9+().\-\s]+$/;

export type RegistrationGender = "male" | "female";

export type ValidatedCheckoutInput = {
  slug: string;
  fullName: string;
  email: string;
  phone: string;
  age: number;
  gender: RegistrationGender;
  ticketTypeId: string;
};

export type CheckoutEvent = {
  id: string;
  slug: string;
  title: string;
  startsAt: string;
  capacity: number | null;
  status: string;
};

export type CheckoutTicketType = {
  id: string;
  eventId: string;
  name: string;
  audience: "male" | "female" | "any";
  priceCents: number;
  currency: string;
  capacity: number | null;
  status: string;
};

type ValidationResult =
  | { ok: true; value: ValidatedCheckoutInput }
  | { ok: false };

function parseAge(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^\d{1,3}$/.test(value.trim())) {
    return Number(value.trim());
  }

  return null;
}

export function validateCheckoutInput(value: unknown): ValidationResult {
  if (!value || typeof value !== "object") {
    return { ok: false };
  }

  const input = value as Record<string, unknown>;
  if (
    typeof input.slug !== "string" ||
    typeof input.full_name !== "string" ||
    typeof input.email !== "string" ||
    typeof input.phone !== "string" ||
    typeof input.gender !== "string" ||
    typeof input.ticket_type_id !== "string"
  ) {
    return { ok: false };
  }

  const slug = input.slug.trim();
  const fullName = input.full_name.trim().replace(/\s+/g, " ");
  const email = input.email.trim().toLowerCase();
  const phone = input.phone.trim().replace(/\s+/g, " ");
  const gender = input.gender.trim().toLowerCase();
  const ticketTypeId = input.ticket_type_id.trim();
  const age = parseAge(input.age);
  const nameLetterCount = (fullName.match(/\p{L}/gu) ?? []).length;
  const phoneDigitCount = (phone.match(/\d/g) ?? []).length;

  if (
    slug.length > 120 ||
    !SLUG_PATTERN.test(slug) ||
    fullName.length < 2 ||
    fullName.length > 100 ||
    nameLetterCount < 2 ||
    email.length > 254 ||
    !EMAIL_PATTERN.test(email) ||
    phone.length < 7 ||
    phone.length > 30 ||
    !PHONE_ALLOWED_PATTERN.test(phone) ||
    phoneDigitCount < 7 ||
    phoneDigitCount > 15 ||
    age === null ||
    age < 18 ||
    age > 120 ||
    (gender !== "male" && gender !== "female") ||
    !UUID_PATTERN.test(ticketTypeId)
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    value: {
      slug,
      fullName,
      email,
      phone,
      age,
      gender,
      ticketTypeId,
    },
  };
}

export function parseCheckoutEvent(value: unknown): CheckoutEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const event = value as Record<string, unknown>;
  const capacityIsValid =
    event.capacity === null ||
    (typeof event.capacity === "number" &&
      Number.isSafeInteger(event.capacity) &&
      event.capacity >= 0);

  if (
    typeof event.id !== "string" ||
    event.id.length === 0 ||
    typeof event.slug !== "string" ||
    !SLUG_PATTERN.test(event.slug) ||
    typeof event.title !== "string" ||
    event.title.trim().length === 0 ||
    typeof event.starts_at !== "string" ||
    Number.isNaN(Date.parse(event.starts_at)) ||
    !capacityIsValid ||
    typeof event.status !== "string"
  ) {
    return null;
  }

  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    startsAt: event.starts_at,
    capacity: event.capacity as number | null,
    status: event.status,
  };
}

export function parseCheckoutTicketType(value: unknown): CheckoutTicketType | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const ticket = value as Record<string, unknown>;
  const capacityIsValid =
    ticket.capacity === null ||
    (typeof ticket.capacity === "number" &&
      Number.isSafeInteger(ticket.capacity) &&
      ticket.capacity >= 0);

  if (
    typeof ticket.id !== "string" ||
    !UUID_PATTERN.test(ticket.id) ||
    typeof ticket.event_id !== "string" ||
    !UUID_PATTERN.test(ticket.event_id) ||
    typeof ticket.name !== "string" ||
    ticket.name.trim().length === 0 ||
    (ticket.audience !== "male" && ticket.audience !== "female" && ticket.audience !== "any") ||
    typeof ticket.price_cents !== "number" ||
    !Number.isSafeInteger(ticket.price_cents) ||
    ticket.price_cents < 0 ||
    typeof ticket.currency !== "string" ||
    !/^[A-Z]{3}$/.test(ticket.currency) ||
    !capacityIsValid ||
    typeof ticket.status !== "string"
  ) {
    return null;
  }

  return {
    id: ticket.id,
    eventId: ticket.event_id,
    name: ticket.name,
    audience: ticket.audience,
    priceCents: ticket.price_cents,
    currency: ticket.currency,
    capacity: ticket.capacity as number | null,
    status: ticket.status,
  };
}

export function isEventAvailableForSale(event: CheckoutEvent, now = new Date()): boolean {
  return event.status === "published" && Date.parse(event.startsAt) > now.getTime();
}

export function isTicketAvailableForSale(ticket: CheckoutTicketType): boolean {
  return ticket.status === "active" && ticket.priceCents > 0;
}

export function doesTicketMatchGender(
  ticket: CheckoutTicketType,
  gender: RegistrationGender,
): boolean {
  return ticket.audience === "any" || ticket.audience === gender;
}

export function isSoldOut(capacity: number | null, paidRegistrationCount: number): boolean {
  return capacity !== null && paidRegistrationCount >= capacity;
}

export function buildCheckoutSessionParams(
  event: CheckoutEvent,
  ticket: CheckoutTicketType,
  registrationId: string,
  customerEmail: string,
  requestOrigin: string,
): Stripe.Checkout.SessionCreateParams {
  const successBase = new URL("/success", requestOrigin).toString();
  const cancelUrl = new URL(`/events/${encodeURIComponent(event.slug)}`, requestOrigin).toString();

  return {
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: customerEmail,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: ticket.currency.toLowerCase(),
          unit_amount: ticket.priceCents,
          product_data: {
            name: `${event.title} — ${ticket.name}`,
          },
        },
      },
    ],
    metadata: {
      registration_id: registrationId,
      event_id: event.id,
      ticket_type_id: ticket.id,
    },
    success_url: `${successBase}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl,
  };
}

export function checkoutIdempotencyKey(registrationId: string): string {
  return `registration:${registrationId}:checkout-session:v1`;
}
