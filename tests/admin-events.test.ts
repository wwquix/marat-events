import assert from "node:assert/strict";
import test from "node:test";

import {
  formatCentsForInput,
  newYorkLocalInputToUtc,
  parseMoneyToCents,
  utcToNewYorkLocalInput,
  validateAdminEventInput,
  validateAdminTicketInput,
  validateEventMutation,
  validateTicketMutation,
} from "../lib/admin/events";

test("money parsing is exact to cents", () => {
  assert.equal(parseMoneyToCents("25"), 2500);
  assert.equal(parseMoneyToCents("25.5"), 2550);
  assert.equal(parseMoneyToCents("25.05"), 2505);
  assert.equal(parseMoneyToCents("25.005"), null);
  assert.equal(parseMoneyToCents("-1"), null);
  assert.equal(formatCentsForInput(2505), "25.05");
});

test("New York wall clock converts deterministically across DST seasons", () => {
  assert.equal(newYorkLocalInputToUtc("2026-08-14T18:30"), "2026-08-14T22:30:00.000Z");
  assert.equal(newYorkLocalInputToUtc("2027-01-10T18:30"), "2027-01-10T23:30:00.000Z");
  assert.equal(utcToNewYorkLocalInput("2026-08-14T22:30:00.000Z"), "2026-08-14T18:30");
});

test("rejects a nonexistent New York DST wall time", () => {
  assert.equal(newYorkLocalInputToUtc("2026-03-08T02:30"), null);
});

test("validates event input and converts the event time to UTC", () => {
  const result = validateAdminEventInput({
    slug: "summer-mixer",
    title: "Summer Mixer",
    description: "Event description",
    venue: "Demo Hall",
    starts_at: "2026-08-20T19:00",
    capacity: "100",
    status: "published",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.startsAt, "2026-08-20T23:00:00.000Z");
    assert.equal(result.value.capacity, 100);
  }
});

test("validates ticket input without floating-point money conversion", () => {
  const result = validateAdminTicketInput({
    code: "women-admission",
    name: "Women Admission",
    audience: "female",
    price: "25.00",
    currency: "usd",
    capacity: "50",
    status: "active",
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      code: "women-admission",
      name: "Women Admission",
      audience: "female",
      priceCents: 2500,
      currency: "USD",
      capacity: 50,
      status: "active",
    },
  });
});

test("event capacity cannot drop below already paid registrations", () => {
  const error = validateEventMutation(
    { slug: "event-one", status: "published" },
    {
      slug: "event-one",
      title: "Event One",
      description: "",
      venue: "Hall",
      startsAt: "2099-01-01T00:00:00.000Z",
      capacity: 2,
      status: "published",
    },
    3,
    0,
  );
  assert.equal(error, "capacity_below_paid");
});

test("event slug and draft transition are locked after payment", () => {
  const base = {
    title: "Event One",
    description: "",
    venue: "Hall",
    startsAt: "2099-01-01T00:00:00.000Z",
    capacity: 100,
  };

  assert.equal(
    validateEventMutation(
      { slug: "event-one", status: "published" },
      { ...base, slug: "renamed", status: "published" },
      1,
      0,
    ),
    "locked_after_payment",
  );
  assert.equal(
    validateEventMutation(
      { slug: "event-one", status: "published" },
      { ...base, slug: "event-one", status: "draft" },
      1,
      0,
    ),
    "locked_after_payment",
  );
});

test("ticket commercial identity is immutable after payment", () => {
  const existing = { code: "men", audience: "male", priceCents: 2500, currency: "USD" };
  const next = {
    code: "men",
    name: "Men Admission",
    audience: "male" as const,
    priceCents: 3000,
    currency: "USD",
    capacity: 50,
    status: "active" as const,
  };

  assert.equal(validateTicketMutation(existing, next, 1), "locked_after_payment");
  assert.equal(validateTicketMutation(existing, { ...next, priceCents: 2500, capacity: 0 }, 1), "capacity_below_paid");
  assert.equal(validateTicketMutation(existing, { ...next, priceCents: 2500, capacity: 50 }, 1), null);
});
