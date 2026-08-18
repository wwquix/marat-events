import { renderTemplate, type TemplateSource } from "@/lib/campaigns/template";
import {
  evaluateOutboundPolicy,
  type ContactabilityStatus,
  type ConsentStatus,
  type IdentityStatus,
  type OutboundChannel,
  type OutboundPolicyReason,
  type SendingWindow,
  type SuppressionStatus,
} from "@/lib/outbound/policy";

export type CampaignPreviewContact = {
  id: string;
  channel: string;
  value: string;
  normalizedValue: string;
  isPrimary: boolean;
  consentStatus: ConsentStatus;
  contactabilityStatus: ContactabilityStatus;
};

export type CampaignPreviewPerson = {
  id: string;
  fullName: string;
  suppressionStatus: SuppressionStatus;
  identityStatus: IdentityStatus;
  contacts: readonly CampaignPreviewContact[];
  variables?: Readonly<Record<string, string>>;
};

export type CampaignPreviewRecipient = {
  ordinal: number;
  personId: string;
  contactId: string | null;
  destination: string | null;
  normalizedDestination: string | null;
  consentStatus: ConsentStatus;
  contactabilityStatus: ContactabilityStatus;
  suppressionStatus: SuppressionStatus;
  eligibility: "eligible" | "blocked" | "deferred";
  policyReason: OutboundPolicyReason;
  availableAt: string | null;
  renderedSubject: string | null;
  renderedBody: string;
  idempotencyKey: string;
};

export type CampaignPreview = {
  templateVersionId: string;
  recipients: CampaignPreviewRecipient[];
  eligibleCount: number;
  blockedCount: number;
  deferredCount: number;
};

function chooseContact(
  contacts: readonly CampaignPreviewContact[],
  channel: OutboundChannel,
): CampaignPreviewContact | null {
  return (
    contacts
      .filter((contact) => contact.channel === channel)
      .sort((left, right) => {
        if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
        const destinationOrder = left.normalizedValue.localeCompare(right.normalizedValue);
        return destinationOrder === 0 ? left.id.localeCompare(right.id) : destinationOrder;
      })[0] ?? null
  );
}

export function createCampaignPreview(input: {
  campaignId: string;
  templateVersionId: string;
  template: TemplateSource;
  channel: OutboundChannel;
  people: readonly CampaignPreviewPerson[];
  sharedVariables: Readonly<Record<string, string>>;
  now: Date;
  sendingWindow: SendingWindow;
}): CampaignPreview {
  const recipients = [...input.people]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((person, index): CampaignPreviewRecipient => {
      const contact = chooseContact(person.contacts, input.channel);
      const rendered = renderTemplate(input.template, {
        ...input.sharedVariables,
        ...person.variables,
        full_name: person.fullName,
      });
      const policy = evaluateOutboundPolicy({
        channel: contact?.channel ?? input.channel,
        expectedChannel: input.channel,
        destination: contact?.value ?? null,
        suppressionStatus: person.suppressionStatus,
        identityStatus: person.identityStatus,
        consentStatus: contact?.consentStatus ?? "unknown",
        contactabilityStatus: contact?.contactabilityStatus ?? "unknown",
        destinationCurrent: true,
        destinationUniqueOwner: true,
        now: input.now,
        sendingWindow: input.sendingWindow,
      });

      return {
        ordinal: index + 1,
        personId: person.id,
        contactId: contact?.id ?? null,
        destination: contact?.value ?? null,
        normalizedDestination: contact?.normalizedValue ?? null,
        consentStatus: contact?.consentStatus ?? "unknown",
        contactabilityStatus: contact?.contactabilityStatus ?? "unknown",
        suppressionStatus: person.suppressionStatus,
        eligibility: policy.decision === "allow" ? "eligible" : policy.decision === "defer" ? "deferred" : "blocked",
        policyReason: policy.reason,
        availableAt: policy.decision === "defer" ? policy.availableAt : null,
        renderedSubject: rendered.subject,
        renderedBody: rendered.body,
        idempotencyKey: `${input.campaignId}:${person.id}:${contact?.id ?? "none"}`,
      };
    });

  const owners = new Map<string, CampaignPreviewRecipient[]>();
  for (const recipient of recipients) {
    if (!recipient.normalizedDestination) continue;
    const key = `${input.channel}:${recipient.normalizedDestination}`;
    const group = owners.get(key) ?? [];
    group.push(recipient);
    owners.set(key, group);
  }
  for (const group of owners.values()) {
    if (group.length < 2) continue;
    for (const recipient of group) {
      recipient.eligibility = "blocked";
      recipient.policyReason = "duplicate_destination_ownership";
      recipient.availableAt = null;
    }
  }

  return {
    templateVersionId: input.templateVersionId,
    recipients,
    eligibleCount: recipients.filter((recipient) => recipient.eligibility === "eligible").length,
    blockedCount: recipients.filter((recipient) => recipient.eligibility === "blocked").length,
    deferredCount: recipients.filter((recipient) => recipient.eligibility === "deferred").length,
  };
}
