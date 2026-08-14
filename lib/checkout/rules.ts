import type Stripe from "stripe";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ValidatedCheckoutInput = {
  slug: string;
  fullName: string;
  email: string;
};

export type CheckoutEvent = {
  id: string;
  slug: string;
  title: string;
  startsAt: string;
  capacity: number | null;
  priceCents: number;
  currency: string;
  status: string;
};

type ValidationResult =
  | { ok: true; value: ValidatedCheckoutInput }
  | { ok: false };

export function validateCheckoutInput(value: unknown): ValidationResult {
  if (!value || typeof value !== "object") {
    return { ok: false };
  }

  const input = value as Record<string, unknown>;
  if (
    typeof input.slug !== "string" ||
    typeof input.full_name !== "string" ||
    typeof input.email !== "string"
  ) {
    return { ok: false };
  }

  const slug = input.slug.trim();
  const fullName = input.full_name.trim().replace(/\s+/g, " ");
  const email = input.email.trim().toLowerCase();
  const nameLetterCount = (fullName.match(/\p{L}/gu) ?? []).length;

  if (
    slug.length > 120 ||
    !SLUG_PATTERN.test(slug) ||
    fullName.length < 2 ||
    fullName.length > 100 ||
    nameLetterCount < 2 ||
    email.length > 254 ||
    !EMAIL_PATTERN.test(email)
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    value: { slug, fullName, email },
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
    typeof event.price_cents !== "number" ||
    !Number.isSafeInteger(event.price_cents) ||
    event.price_cents < 0 ||
    typeof event.currency !== "string" ||
    !/^[A-Z]{3}$/.test(event.currency) ||
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
    priceCents: event.price_cents,
    currency: event.currency,
    status: event.status,
  };
}

export function isEventAvailableForSale(event: CheckoutEvent, now = new Date()): boolean {
  return event.status === "published" && Date.parse(event.startsAt) > now.getTime();
}

export function isSoldOut(capacity: number | null, paidRegistrationCount: number): boolean {
  return capacity !== null && paidRegistrationCount >= capacity;
}

export function buildCheckoutSessionParams(
  event: CheckoutEvent,
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
          currency: event.currency.toLowerCase(),
          unit_amount: event.priceCents,
          product_data: {
            name: event.title,
          },
        },
      },
    ],
    metadata: {
      registration_id: registrationId,
      event_id: event.id,
    },
    success_url: `${successBase}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl,
  };
}

export function checkoutIdempotencyKey(registrationId: string): string {
  return `registration:${registrationId}:checkout-session:v1`;
}
