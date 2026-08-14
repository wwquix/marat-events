import type Stripe from "stripe";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type VerifiedPaidSession = {
  sessionId: string;
  registrationId: string;
  eventId: string;
  amountTotal: number;
  currency: string;
  paymentIntentId: string | null;
};

export type RegistrationSnapshot = {
  id: string;
  eventId: string;
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
  amountCents: number;
  currency: string;
  paymentStatus: string;
  paidAt: string | null;
};

export type RegistrationRepository = {
  loadById(registrationId: string): Promise<RegistrationSnapshot | null>;
  transitionPendingToPaid(
    session: VerifiedPaidSession,
    paidAt: string,
  ): Promise<RegistrationSnapshot | null>;
};

export type WebhookLogEntry = {
  stage: string;
  category: string;
  eventId?: string;
  eventType?: string;
  sessionId?: string;
  registrationId?: string;
};

export type WebhookOutcome = {
  status: 200 | 400 | 500;
  code:
    | "processed"
    | "already_processed"
    | "ignored_event"
    | "ignored_unpaid"
    | "invalid_signature"
    | "live_mode_rejected"
    | "malformed_session"
    | "registration_mismatch"
    | "database_failure";
};

type HandlerOptions = {
  rawBody: string;
  signature: string | null;
  webhookSecret: string;
  verifyEvent: (rawBody: string, signature: string, secret: string) => Stripe.Event;
  getRepository: () => RegistrationRepository;
  now?: () => string;
  log?: (entry: WebhookLogEntry) => void;
};

type TransitionDecision =
  | { kind: "transition" }
  | { kind: "already_paid" }
  | { kind: "mismatch"; category: string };

function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parsePaymentIntentId(
  value: unknown,
): { valid: true; id: string | null } | { valid: false } {
  if (value === null || value === undefined) {
    return { valid: true, id: null };
  }

  if (typeof value === "string" && value.length > 0) {
    return { valid: true, id: value };
  }

  if (typeof value === "object" && value) {
    const id = getString((value as Record<string, unknown>).id);
    return id ? { valid: true, id } : { valid: false };
  }

  return { valid: false };
}

function getSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  return getString((value as Record<string, unknown>).id) ?? undefined;
}

export function parseVerifiedPaidSession(value: unknown): VerifiedPaidSession | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const session = value as Record<string, unknown>;
  const metadata =
    session.metadata && typeof session.metadata === "object"
      ? (session.metadata as Record<string, unknown>)
      : null;
  const sessionId = getString(session.id);
  const registrationId = metadata ? getString(metadata.registration_id) : null;
  const eventId = metadata ? getString(metadata.event_id) : null;
  const paymentIntent = parsePaymentIntentId(session.payment_intent);
  const paymentMethodTypes = session.payment_method_types;

  if (
    session.object !== "checkout.session" ||
    session.mode !== "payment" ||
    session.status !== "complete" ||
    session.payment_status !== "paid" ||
    session.livemode !== false ||
    !sessionId ||
    !registrationId ||
    !UUID_PATTERN.test(registrationId) ||
    !eventId ||
    !UUID_PATTERN.test(eventId) ||
    typeof session.amount_total !== "number" ||
    !Number.isSafeInteger(session.amount_total) ||
    session.amount_total < 0 ||
    typeof session.currency !== "string" ||
    !/^[a-z]{3}$/.test(session.currency) ||
    !Array.isArray(paymentMethodTypes) ||
    paymentMethodTypes.length !== 1 ||
    paymentMethodTypes[0] !== "card" ||
    !paymentIntent.valid
  ) {
    return null;
  }

  return {
    sessionId,
    registrationId,
    eventId,
    amountTotal: session.amount_total,
    currency: session.currency.toLowerCase(),
    paymentIntentId: paymentIntent.id,
  };
}

export function decideRegistrationTransition(
  session: VerifiedPaidSession,
  registration: RegistrationSnapshot,
): TransitionDecision {
  if (registration.id !== session.registrationId) {
    return { kind: "mismatch", category: "registration_id_mismatch" };
  }

  if (registration.eventId !== session.eventId) {
    return { kind: "mismatch", category: "event_id_mismatch" };
  }

  if (registration.checkoutSessionId !== session.sessionId) {
    return { kind: "mismatch", category: "checkout_session_mismatch" };
  }

  if (registration.amountCents !== session.amountTotal) {
    return { kind: "mismatch", category: "amount_mismatch" };
  }

  if (registration.currency.toLowerCase() !== session.currency) {
    return { kind: "mismatch", category: "currency_mismatch" };
  }

  if (registration.paymentStatus === "pending") {
    return registration.paidAt === null
      ? { kind: "transition" }
      : { kind: "mismatch", category: "pending_with_paid_at" };
  }

  if (registration.paymentStatus === "paid") {
    if (registration.paidAt === null) {
      return { kind: "mismatch", category: "paid_without_paid_at" };
    }

    if (
      session.paymentIntentId !== null &&
      registration.paymentIntentId !== session.paymentIntentId
    ) {
      return { kind: "mismatch", category: "payment_intent_mismatch" };
    }

    return { kind: "already_paid" };
  }

  return { kind: "mismatch", category: "unexpected_payment_status" };
}

export async function handleStripeWebhook({
  rawBody,
  signature,
  webhookSecret,
  verifyEvent,
  getRepository,
  now = () => new Date().toISOString(),
  log = () => undefined,
}: HandlerOptions): Promise<WebhookOutcome> {
  if (!signature) {
    log({ stage: "signature_verification", category: "missing_signature" });
    return { status: 400, code: "invalid_signature" };
  }

  let event: Stripe.Event;

  try {
    event = verifyEvent(rawBody, signature, webhookSecret);
  } catch {
    log({ stage: "signature_verification", category: "invalid_signature" });
    return { status: 400, code: "invalid_signature" };
  }

  log({
    stage: "event_received",
    category: "verified",
    eventId: event.id,
    eventType: event.type,
  });

  if (event.livemode) {
    log({
      stage: "event_validation",
      category: "live_mode_rejected",
      eventId: event.id,
      eventType: event.type,
    });
    return { status: 400, code: "live_mode_rejected" };
  }

  if (event.type !== "checkout.session.completed") {
    return { status: 200, code: "ignored_event" };
  }

  const sessionObject = event.data.object as unknown;
  const sessionId = getSessionId(sessionObject);
  const paymentStatus =
    sessionObject && typeof sessionObject === "object"
      ? (sessionObject as Record<string, unknown>).payment_status
      : undefined;

  if (paymentStatus !== "paid") {
    log({
      stage: "session_validation",
      category: "payment_not_paid",
      eventId: event.id,
      eventType: event.type,
      sessionId,
    });
    return { status: 200, code: "ignored_unpaid" };
  }

  const session = parseVerifiedPaidSession(sessionObject);
  if (!session) {
    log({
      stage: "session_validation",
      category: "malformed_paid_session",
      eventId: event.id,
      eventType: event.type,
      sessionId,
    });
    return { status: 400, code: "malformed_session" };
  }

  let repository: RegistrationRepository;
  try {
    repository = getRepository();
  } catch {
    log({
      stage: "registration_repository",
      category: "database_configuration",
      eventId: event.id,
      eventType: event.type,
      sessionId: session.sessionId,
      registrationId: session.registrationId,
    });
    return { status: 500, code: "database_failure" };
  }

  let registration: RegistrationSnapshot | null;
  try {
    registration = await repository.loadById(session.registrationId);
  } catch {
    log({
      stage: "registration_load",
      category: "database_failure",
      eventId: event.id,
      eventType: event.type,
      sessionId: session.sessionId,
      registrationId: session.registrationId,
    });
    return { status: 500, code: "database_failure" };
  }

  if (!registration) {
    log({
      stage: "registration_load",
      category: "registration_not_found",
      eventId: event.id,
      eventType: event.type,
      sessionId: session.sessionId,
      registrationId: session.registrationId,
    });
    return { status: 500, code: "registration_mismatch" };
  }

  const decision = decideRegistrationTransition(session, registration);
  if (decision.kind === "mismatch") {
    log({
      stage: "registration_validation",
      category: decision.category,
      eventId: event.id,
      eventType: event.type,
      sessionId: session.sessionId,
      registrationId: session.registrationId,
    });
    return { status: 500, code: "registration_mismatch" };
  }

  if (decision.kind === "already_paid") {
    return { status: 200, code: "already_processed" };
  }

  let updated: RegistrationSnapshot | null;
  try {
    updated = await repository.transitionPendingToPaid(session, now());
  } catch {
    log({
      stage: "registration_update",
      category: "database_failure",
      eventId: event.id,
      eventType: event.type,
      sessionId: session.sessionId,
      registrationId: session.registrationId,
    });
    return { status: 500, code: "database_failure" };
  }

  if (updated) {
    const updatedDecision = decideRegistrationTransition(session, updated);
    if (updatedDecision.kind === "already_paid") {
      return { status: 200, code: "processed" };
    }
  }

  try {
    const concurrentRegistration = await repository.loadById(session.registrationId);
    if (
      concurrentRegistration &&
      decideRegistrationTransition(session, concurrentRegistration).kind === "already_paid"
    ) {
      return { status: 200, code: "already_processed" };
    }
  } catch {
    log({
      stage: "registration_reload",
      category: "database_failure",
      eventId: event.id,
      eventType: event.type,
      sessionId: session.sessionId,
      registrationId: session.registrationId,
    });
    return { status: 500, code: "database_failure" };
  }

  log({
    stage: "registration_update",
    category: "conditional_update_mismatch",
    eventId: event.id,
    eventType: event.type,
    sessionId: session.sessionId,
    registrationId: session.registrationId,
  });
  return { status: 500, code: "registration_mismatch" };
}
