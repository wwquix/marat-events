import type { OutboundAdapter, OutboundMessage } from "@/lib/outbound/adapters";
import {
  evaluateOutboundPolicy,
  type ContactabilityStatus,
  type ConsentStatus,
  type IdentityStatus,
  type OutboundChannel,
  type SendingWindow,
  type SuppressionStatus,
} from "@/lib/outbound/policy";
import type { OutboxState } from "@/lib/outbound/state";

export type DispatchableOutboxMessage = OutboundMessage & {
  state: "claimed";
  expectedChannel: OutboundChannel;
  suppressionStatus: SuppressionStatus;
  identityStatus: IdentityStatus;
  consentStatus: ConsentStatus;
  contactabilityStatus: ContactabilityStatus;
  destinationCurrent: boolean;
  destinationUniqueOwner: boolean;
};

export type DispatchOutcome = {
  state: Extract<OutboxState, "blocked" | "retry_scheduled" | "dry_run_completed" | "disabled">;
  code: string;
  availableAt: string | null;
  providerCalled: false;
};

export async function dispatchOutboxMessage(
  message: DispatchableOutboxMessage,
  adapter: OutboundAdapter,
  now: Date,
  sendingWindow: SendingWindow,
): Promise<DispatchOutcome> {
  const policy = evaluateOutboundPolicy({
    channel: message.channel,
    expectedChannel: message.expectedChannel,
    destination: message.destination,
    suppressionStatus: message.suppressionStatus,
    identityStatus: message.identityStatus,
    consentStatus: message.consentStatus,
    contactabilityStatus: message.contactabilityStatus,
    destinationCurrent: message.destinationCurrent,
    destinationUniqueOwner: message.destinationUniqueOwner,
    now,
    sendingWindow,
  });

  if (policy.decision === "block") {
    return { state: "blocked", code: policy.reason, availableAt: null, providerCalled: false };
  }
  if (policy.decision === "defer") {
    return {
      state: "retry_scheduled",
      code: policy.reason,
      availableAt: policy.availableAt,
      providerCalled: false,
    };
  }

  const result = await adapter.dispatch(message);
  if (result.kind === "dry_run") {
    return { state: "dry_run_completed", code: result.code, availableAt: null, providerCalled: false };
  }
  return { state: "disabled", code: result.code, availableAt: null, providerCalled: false };
}
