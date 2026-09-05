import assert from "node:assert/strict";
import test from "node:test";

import { createCampaignPreview, type CampaignPreviewPerson } from "../lib/campaigns/preview";
import { DEFAULT_SENDING_TIME_ZONE, type SendingWindow } from "../lib/outbound/policy";

const openWindow: SendingWindow = {
  timeZone: DEFAULT_SENDING_TIME_ZONE,
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  allowedWeekdays: [1, 2, 3, 4, 5],
};

function person(
  id: string,
  options: {
    destination?: string;
    primaryDestination?: string;
    consent?: "unknown" | "opted_in" | "opted_out";
    suppression?: "active" | "suppressed";
    identity?: "resolved" | "review_required";
  } = {},
): CampaignPreviewPerson {
  const destination = options.destination ?? `${id}@example.com`;
  const contacts = [
    {
      id: `${id}-secondary`,
      channel: "email",
      value: destination,
      normalizedValue: destination.toLowerCase(),
      isPrimary: false,
      consentStatus: options.consent ?? "opted_in",
      contactabilityStatus: "reachable" as const,
    },
  ];
  if (options.primaryDestination) {
    contacts.push({
      id: `${id}-primary`,
      channel: "email",
      value: options.primaryDestination,
      normalizedValue: options.primaryDestination.toLowerCase(),
      isPrimary: true,
      consentStatus: options.consent ?? "opted_in",
      contactabilityStatus: "reachable" as const,
    });
  }

  return {
    id,
    fullName: `Person ${id}`,
    suppressionStatus: options.suppression ?? "active",
    identityStatus: options.identity ?? "resolved",
    contacts,
  };
}

test("campaign preview is ordered, snapshots the exact template version, and selects contacts deterministically", () => {
  const preview = createCampaignPreview({
    campaignId: "campaign-1",
    templateVersionId: "template-version-7",
    template: {
      subject: "Hello {{full_name}}",
      body: "Meet us at {{venue}}",
      variables: ["full_name", "venue"],
    },
    channel: "email",
    people: [person("b"), person("a", { primaryDestination: "a.primary@example.com" })],
    sharedVariables: { venue: "Demo Hall" },
    now: new Date("2026-08-17T14:00:00.000Z"),
    sendingWindow: openWindow,
  });

  assert.equal(preview.templateVersionId, "template-version-7");
  assert.deepEqual(preview.recipients.map((recipient) => recipient.personId), ["a", "b"]);
  assert.equal(preview.recipients[0].contactId, "a-primary");
  assert.equal(preview.recipients[0].destination, "a.primary@example.com");
  assert.equal(preview.recipients[0].renderedSubject, "Hello Person a");
  assert.equal(preview.recipients[0].renderedBody, "Meet us at Demo Hall");
  assert.equal(preview.eligibleCount, 2);
  assert.equal(preview.blockedCount, 0);
});

test("unknown consent, suppression, unresolved identity, and duplicate destination ownership fail closed", () => {
  const preview = createCampaignPreview({
    campaignId: "campaign-2",
    templateVersionId: "template-version-1",
    template: { subject: null, body: "Hello {{full_name}}", variables: ["full_name"] },
    channel: "email",
    people: [
      person("unknown", { consent: "unknown" }),
      person("suppressed", { suppression: "suppressed" }),
      person("unresolved", { identity: "review_required" }),
      person("duplicate-1", { destination: "shared@example.com" }),
      person("duplicate-2", { destination: "shared@example.com" }),
    ],
    sharedVariables: {},
    now: new Date("2026-08-17T14:00:00.000Z"),
    sendingWindow: openWindow,
  });

  const reasons = Object.fromEntries(preview.recipients.map((recipient) => [recipient.personId, recipient.policyReason]));
  assert.equal(reasons.unknown, "unknown_consent");
  assert.equal(reasons.suppressed, "person_suppressed");
  assert.equal(reasons.unresolved, "identity_review_required");
  assert.equal(reasons["duplicate-1"], "duplicate_destination_ownership");
  assert.equal(reasons["duplicate-2"], "duplicate_destination_ownership");
  assert.equal(preview.blockedCount, 5);
});
