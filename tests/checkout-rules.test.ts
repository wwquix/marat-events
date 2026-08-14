import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCheckoutSessionParams,
  doesTicketMatchGender,
  isEventAvailableForSale,
  isSoldOut,
  isTicketAvailableForSale,
  validateCheckoutInput,
  type CheckoutEvent,
  type CheckoutTicketType,
} from "../lib/checkout/rules";

const event: CheckoutEvent = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "demo-event",
  title: "Demo Event",
  startsAt: "2099-06-15T18:30:00.000Z",
  capacity: 100,
  status: "published",
};

const ticket: CheckoutTicketType = {
  id: "00000000-0000-4000-8000-000000000003",
  eventId: event.id,
  name: "Women Admission",
  audience: "female",
  priceCents: 2500,
  currency: "USD",
  capacity: 50,
  status: "active",
};

test("checkout input is normalized and ignores client-supplied price fields", () => {
  const result = validateCheckoutInput({
    slug: " demo-event ",
    full_name: "  Ada   Lovelace  ",
    email: " ADA@EXAMPLE.COM ",
    phone: " +1 212 555 0123 ",
    age: "31",
    gender: "FEMALE",
    ticket_type_id: ticket.id,
    price_cents: 1,
    currency: "XXX",
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      slug: "demo-event",
      fullName: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+1 212 555 0123",
      age: 31,
      gender: "female",
      ticketTypeId: ticket.id,
    },
  });
});

test("checkout input rejects invalid identity and demographic fields", () => {
  const baseInput = {
    slug: "demo-event",
    full_name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+1 212 555 0123",
    age: "31",
    gender: "female",
    ticket_type_id: ticket.id,
  };

  assert.deepEqual(validateCheckoutInput({ ...baseInput, full_name: "-" }), { ok: false });
  assert.deepEqual(validateCheckoutInput({ ...baseInput, email: "not-an-email" }), { ok: false });
  assert.deepEqual(validateCheckoutInput({ ...baseInput, phone: "123" }), { ok: false });
  assert.deepEqual(validateCheckoutInput({ ...baseInput, age: "17" }), { ok: false });
  assert.deepEqual(validateCheckoutInput({ ...baseInput, gender: "other" }), { ok: false });
  assert.deepEqual(validateCheckoutInput({ ...baseInput, ticket_type_id: "not-a-uuid" }), {
    ok: false,
  });
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

test("ticket availability and audience are enforced server-side", () => {
  assert.equal(isTicketAvailableForSale(ticket), true);
  assert.equal(isTicketAvailableForSale({ ...ticket, status: "hidden" }), false);
  assert.equal(isTicketAvailableForSale({ ...ticket, priceCents: 0 }), false);
  assert.equal(doesTicketMatchGender(ticket, "female"), true);
  assert.equal(doesTicketMatchGender(ticket, "male"), false);
  assert.equal(doesTicketMatchGender({ ...ticket, audience: "any" }, "male"), true);
});

test("Stripe price and currency come only from the selected server ticket", () => {
  const params = buildCheckoutSessionParams(
    event,
    ticket,
    "00000000-0000-4000-8000-000000000002",
    "ada@example.com",
    "http://localhost:3000",
  );

  assert.equal(params.line_items?.length, 1);
  assert.deepEqual(params.payment_method_types, ["card"]);
  assert.equal(params.line_items?.[0]?.quantity, 1);
  assert.equal(params.line_items?.[0]?.price_data?.unit_amount, ticket.priceCents);
  assert.equal(params.line_items?.[0]?.price_data?.currency, "usd");
  assert.equal(
    params.line_items?.[0]?.price_data?.product_data?.name,
    "Demo Event — Women Admission",
  );
  assert.deepEqual(params.metadata, {
    registration_id: "00000000-0000-4000-8000-000000000002",
    event_id: event.id,
    ticket_type_id: ticket.id,
  });
  assert.equal(
    params.success_url,
    "http://localhost:3000/success?session_id={CHECKOUT_SESSION_ID}",
  );
  assert.equal(params.cancel_url, "http://localhost:3000/events/demo-event");
});
