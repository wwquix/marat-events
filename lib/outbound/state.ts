export type OutboxState =
  | "pending"
  | "claimed"
  | "retry_scheduled"
  | "blocked"
  | "dry_run_completed"
  | "disabled"
  | "delivered"
  | "failed"
  | "cancelled";

const ALLOWED_TRANSITIONS: Readonly<Record<OutboxState, readonly OutboxState[]>> = {
  pending: ["claimed", "blocked", "cancelled"],
  claimed: ["retry_scheduled", "blocked", "dry_run_completed", "disabled", "delivered", "failed"],
  retry_scheduled: ["claimed", "blocked", "cancelled"],
  blocked: [],
  dry_run_completed: [],
  disabled: [],
  delivered: [],
  failed: [],
  cancelled: [],
};

export function canTransitionOutbox(from: OutboxState, to: OutboxState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertOutboxTransition(from: OutboxState, to: OutboxState): void {
  if (!canTransitionOutbox(from, to)) {
    throw new Error(`Illegal outbox transition: ${from} -> ${to}`);
  }
}

export function isTerminalOutboxState(state: OutboxState): boolean {
  return ALLOWED_TRANSITIONS[state].length === 0;
}
