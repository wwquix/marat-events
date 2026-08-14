import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCheckoutSessionParams,
  isEventAvailableForSale,
  isSoldOut,
  validateCheckoutInput,
  type CheckoutEvent,
} from "../lib/checkout/rules";

const event: CheckoutEvent = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "demo-event",
  title: "Demo Event",
  startsAt: "2099-06-15T18:30:00.000Z",
  capacity: 100,
  priceCents: 2500,
  currency: "USD",
  status: "published",
};

test("checkout input is trimmed, normalized, and limited to authoritative fields", () => {
  const result = validateCheckoutInput({
    slug: " demo-event ",
    full_name: "  Ada   Lovelace  ",
    email: " ADA@EXAMPLE.COM ",
    price_cents: 1,
    currency: "XXX",
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      slug: "demo-event",
      fullName: "Ada Lovelace",
      email: "ada@example.com",
    },
  });
});

test("checkout input rejects invalid names and emails", () => {
  assert.deepEqual(
    validateCheckoutInput({ slug: "demo-event", full_name: "-", email: "not-an-email" }),
    { ok: false },
  );
  assert.deepEqual(
    validateCheckoutInput({ slug: "demo-event", full_name: "12345", email: "a@example.com" }),
    { ok: false },
  );
});

test("capacity is sold out only when a finite capacity is reached", () => {
  assert.equal(isSoldOut(null, 10_000), false);
  assert.equal(isSoldOut(100, 99), false);
  assert.equal(isSoldOut(100, 100), true);
  assert.equal(isSoldOut(100, 101), true);
});

test("only published future events are available for sale", () => {
  const now = new Date("2099-01-01T00:00:00.000Z");
  assert.equal(isEventAvailableForSale(event, now), true);
  assert.equal(isEventAvailableForSale({ ...event, status: "draft" }, now), false);
  assert.equal(
    isEventAvailableForSale({ ...event, startsAt: "2098-01-01T00:00:00.000Z" }, now),
    false,
  );
});

test("Stripe price, currency, name, and quantity come only from the server event", () => {
  const params = buildCheckoutSessionParams(
    event,
    "00000000-0000-4000-8000-000000000002",
    "ada@example.com",
    "http://localhost:3000",
  );

  assert.equal(params.line_items?.length, 1);
  assert.deepEqual(params.payment_method_types, ["card"]);
  assert.equal(params.line_items?.[0]?.quantity, 1);
  assert.equal(params.line_items?.[0]?.price_data?.unit_amount, event.priceCents);
  assert.equal(params.line_items?.[0]?.price_data?.currency, "usd");
  assert.equal(params.line_items?.[0]?.price_data?.product_data?.name, event.title);
  assert.deepEqual(params.metadata, {
    registration_id: "00000000-0000-4000-8000-000000000002",
    event_id: event.id,
  });
  assert.equal(
    params.success_url,
    "http://localhost:3000/success?session_id={CHECKOUT_SESSION_ID}",
  );
  assert.equal(params.cancel_url, "http://localhost:3000/events/demo-event");
});
