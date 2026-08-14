import assert from "node:assert/strict";
import test from "node:test";

import {
  attendeeMatchesSearch,
  formatAdminMoney,
  parseAttendeeFilters,
} from "../lib/admin/attendees";

const ticketId = "46592e75-d4b2-4f8c-b180-f2fd106f1704";

test("parses supported attendee filters", () => {
  const filters = parseAttendeeFilters({
    payment: "paid",
    gender: "female",
    ticket: ticketId,
    source: "event_page",
    q: "  Jane   Example  ",
  });

  assert.deepEqual(filters, {
    payment: "paid",
    gender: "female",
    ticketId,
    source: "event_page",
    query: "Jane Example",
  });
});

test("fails closed to neutral filters for invalid query parameters", () => {
  const filters = parseAttendeeFilters({
    payment: "chargeback",
    gender: "other",
    ticket: "not-a-uuid",
    source: "event_page),or(email.ilike.*",
  });

  assert.equal(filters.payment, "all");
  assert.equal(filters.gender, "all");
  assert.equal(filters.ticketId, null);
  assert.equal(filters.source, null);
});

test("limits and normalizes free-text search", () => {
  const filters = parseAttendeeFilters({ q: `   ${"x".repeat(150)}   ` });
  assert.equal(filters.query.length, 100);
});

test("search matches registration snapshot fields case-insensitively", () => {
  assert.equal(
    attendeeMatchesSearch(
      {
        fullName: "Phase One Test",
        email: "phase-one@example.com",
        phone: "+1 212 555 0198",
      },
      "PHASE-ONE@EXAMPLE",
    ),
    true,
  );
});

test("search also matches central person fields", () => {
  assert.equal(
    attendeeMatchesSearch(
      {
        fullName: "Overwrite Attempt Test",
        email: "phase-one@example.com",
        phone: "+1 212 555 0101",
        personFullName: "Phase One Test",
        personEmail: "phase-one@example.com",
        personPhone: "+1 212 555 0198",
      },
      "555 0198",
    ),
    true,
  );
});

test("formats registration amount from authoritative cents", () => {
  assert.equal(formatAdminMoney(2500, "USD"), "$25.00");
});
