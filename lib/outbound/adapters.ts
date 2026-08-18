export type OutboundAdapterMode = "disabled" | "dry_run";

export type OutboundMessage = {
  id: string;
  idempotencyKey: string;
  channel: string;
  destination: string;
  subject: string | null;
  body: string;
};

export type AdapterResult =
  | { kind: "disabled"; code: "provider_disabled" }
  | { kind: "dry_run"; code: "dry_run_no_provider_call" };

export interface OutboundAdapter {
  readonly mode: OutboundAdapterMode;
  dispatch(message: OutboundMessage): Promise<AdapterResult>;
}

export class DisabledOutboundAdapter implements OutboundAdapter {
  readonly mode = "disabled" as const;

  async dispatch(): Promise<AdapterResult> {
    return { kind: "disabled", code: "provider_disabled" };
  }
}

export class DryRunOutboundAdapter implements OutboundAdapter {
  readonly mode = "dry_run" as const;

  async dispatch(): Promise<AdapterResult> {
    return { kind: "dry_run", code: "dry_run_no_provider_call" };
  }
}
