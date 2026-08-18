import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SENDING_TIME_ZONE,
  evaluateOutboundPolicy,
  isWithinSendingWindow,
  nextSendingWindowStart,
  type OutboundPolicyInput,
  type SendingWindow,
} from "../lib/outbound/policy";

const weekdayWindow: SendingWindow = {
  timeZone: DEFAULT_SENDING_TIME_ZONE,
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  allowedWeekdays: [1, 2, 3, 4, 5],
};

const eligibleInput: OutboundPolicyInput = {
  channel: "email",
  expectedChannel: "email",
  destination: "person@example.com",
  suppressionStatus: "active",
  identityStatus: "resolved",
  consentStatus: "opted_in",
  contactabilityStatus: "reachable",
  destinationCurrent: true,
  destinationUniqueOwner: true,
  now: new Date("2026-08-17T14:00:00.000Z"),
  sendingWindow: weekdayWindow,
};

test("policy precedence always honors suppression and opt-out before lower-priority failures", () => {
  assert.deepEqual(
    evaluateOutboundPolicy({
      ...eligibleInput,
      suppressionStatus: "suppressed",
      consentStatus: "opted_out",
      destination: null,
    }),
    { decision: "block", reason: "person_suppressed" },
  );
  assert.deepEqual(
    evaluateOutboundPolicy({ ...eligibleInput, consentStatus: "opted_out", destination: null }),
    { decision: "block", reason: "contact_opted_out" },
  );
});

test("unknown consent is never eligible for real queueing", () => {
  assert.deepEqual(evaluateOutboundPolicy({ ...eligibleInput, consentStatus: "unknown" }), {
    decision: "block",
    reason: "unknown_consent",
  });
});

test("unresolved identity and duplicate destination ownership fail closed", () => {
  assert.deepEqual(evaluateOutboundPolicy({ ...eligibleInput, identityStatus: "review_required" }), {
    decision: "block",
    reason: "identity_review_required",
  });
  assert.deepEqual(evaluateOutboundPolicy({ ...eligibleInput, destinationUniqueOwner: false }), {
    decision: "block",
    reason: "duplicate_destination_ownership",
  });
});

test("unusable channels and contactability fail closed", () => {
  assert.deepEqual(evaluateOutboundPolicy({ ...eligibleInput, destination: "not-an-email" }), {
    decision: "block",
    reason: "unusable_channel",
  });
  assert.deepEqual(evaluateOutboundPolicy({ ...eligibleInput, contactabilityStatus: "unknown" }), {
    decision: "block",
    reason: "unknown_contactability",
  });
  assert.deepEqual(evaluateOutboundPolicy({ ...eligibleInput, destinationCurrent: false }), {
    decision: "block",
    reason: "stale_destination",
  });
});

test("America/New_York windows are evaluated across the DST spring transition", () => {
  const sundayWindow: SendingWindow = {
    ...weekdayWindow,
    allowedWeekdays: [0],
  };
  const beforeWindow = new Date("2026-03-08T12:30:00.000Z"); // 08:30 EDT after the spring transition.
  const atWindow = new Date("2026-03-08T13:00:00.000Z"); // 09:00 EDT.

  assert.equal(isWithinSendingWindow(beforeWindow, sundayWindow), false);
  assert.equal(isWithinSendingWindow(atWindow, sundayWindow), true);
  assert.equal(nextSendingWindowStart(beforeWindow, sundayWindow).toISOString(), atWindow.toISOString());

  assert.deepEqual(evaluateOutboundPolicy({ ...eligibleInput, now: beforeWindow, sendingWindow: sundayWindow }), {
    decision: "defer",
    reason: "outside_sending_window",
    availableAt: atWindow.toISOString(),
  });
});
