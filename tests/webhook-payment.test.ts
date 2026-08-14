import assert from "node:assert/strict";
import test from "node:test";

import Stripe from "stripe";

import {
  handleStripeWebhook,
  parseVerifiedPaidSession,
  type RegistrationRepository,
  type RegistrationSnapshot,
  type VerifiedPaidSession,
} from "../lib/webhook/payment";

const REGISTRATION_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_ID = "cs_test_verified_session";
const PAYMENT_INTENT_ID = "pi_test_verified_payment";
const FIXED_PAID_AT = "2099-06-15T18:35:00.000Z";

function checkoutSession(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: SESSION_ID,
    object: "checkout.session",
    livemode: false,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    payment_method_types: ["card"],
    amount_total: 2500,
    currency: "usd",
    payment_intent: { id: PAYMENT_INTENT_ID },
    metadata: {
      registration_id: REGISTRATION_ID,
      event_id: EVENT_ID,
    },
    ...overrides,
  };
}

function stripeEvent(
  type: string,
  object: Record<string, unknown> = checkoutSession(),
  livemode = false,
): Stripe.Event {
  return {
    id: "evt_test_verified_event",
    object: "event",
    api_version: null,
    created: 0,
    data: { object },
    livemode,
    pending_webhooks: 1,
    request: null,
    type,
  } as unknown as Stripe.Event;
}

function registration(
  overrides: Partial<RegistrationSnapshot> = {},
): RegistrationSnapshot {
  return {
    id: REGISTRATION_ID,
    eventId: EVENT_ID,
    checkoutSessionId: SESSION_ID,
    paymentIntentId: null,
    amountCents: 2500,
    currency: "USD",
    paymentStatus: "pending",
    paidAt: null,
    ...overrides,
  };
}

class InMemoryRepository implements RegistrationRepository {
  state: RegistrationSnapshot | null;
  loadCount = 0;
  transitionCount = 0;

  constructor(initialState: RegistrationSnapshot | null) {
    this.state = initialState ? { ...initialState } : null;
  }

  async loadById(registrationId: string) {
    this.loadCount += 1;
    if (!this.state || this.state.id !== registrationId) {
      return null;
    }

    return { ...this.state };
  }

  async transitionPendingToPaid(session: VerifiedPaidSession, paidAt: string) {
    this.transitionCount += 1;
    if (
      !this.state ||
      this.state.id !== session.registrationId ||
      this.state.eventId !== session.eventId ||
      this.state.checkoutSessionId !== session.sessionId ||
      this.state.amountCents !== session.amountTotal ||
      this.state.currency.toLowerCase() !== session.currency ||
      this.state.paymentStatus !== "pending"
    ) {
      return null;
    }

    this.state = {
      ...this.state,
      paymentStatus: "paid",
      paidAt,
      paymentIntentId: session.paymentIntentId ?? this.state.paymentIntentId,
    };

    return { ...this.state };
  }
}

async function runWebhook(options?: {
  event?: Stripe.Event;
  signature?: string | null;
  verifyThrows?: boolean;
  registration?: RegistrationSnapshot | null;
}) {
  const repository = new InMemoryRepository(
    options && "registration" in options ? options.registration ?? null : registration(),
  );
  let repositoryFactoryCalls = 0;
  let verifiedRawBody: string | undefined;

  const outcome = await handleStripeWebhook({
    rawBody: "raw-webhook-body",
    signature: options?.signature === undefined ? "test-signature" : options.signature,
    webhookSecret: "unit-webhook-secret",
    verifyEvent: (rawBody, signature, secret) => {
      verifiedRawBody = rawBody;
      assert.equal(signature, "test-signature");
      assert.equal(secret, "unit-webhook-secret");
      if (options?.verifyThrows) {
        throw new Error("signature rejected");
      }
      return options?.event ?? stripeEvent("checkout.session.completed");
    },
    getRepository: () => {
      repositoryFactoryCalls += 1;
      return repository;
    },
    now: () => FIXED_PAID_AT,
  });

  return { outcome, repository, repositoryFactoryCalls, verifiedRawBody };
}

test("invalid signature cannot reach registration mutation logic", async () => {
  const result = await runWebhook({ verifyThrows: true });

  assert.deepEqual(result.outcome, { status: 400, code: "invalid_signature" });
  assert.equal(result.repositoryFactoryCalls, 0);
  assert.equal(result.repository.loadCount, 0);
  assert.equal(result.repository.transitionCount, 0);
});

test("Stripe SDK rejects a signature created with a different webhook secret", async () => {
  const stripe = new Stripe("sk_test_unit_only");
  const rawBody = JSON.stringify(stripeEvent("checkout.session.completed"));
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: rawBody,
    secret: "unit-wrong-secret",
  });
  let repositoryFactoryCalls = 0;

  const outcome = await handleStripeWebhook({
    rawBody,
    signature,
    webhookSecret: "unit-expected-secret",
    verifyEvent: (body, header, secret) =>
      stripe.webhooks.constructEvent(body, header, secret),
    getRepository: () => {
      repositoryFactoryCalls += 1;
      return new InMemoryRepository(registration());
    },
  });

  assert.deepEqual(outcome, { status: 400, code: "invalid_signature" });
  assert.equal(repositoryFactoryCalls, 0);
});

test("Stripe SDK verifies the unchanged raw body before unsupported-event acknowledgement", async () => {
  const stripe = new Stripe("sk_test_unit_only");
  const rawBody = JSON.stringify(stripeEvent("customer.created", {}));
  const secret = "unit-expected-secret";
  const signature = stripe.webhooks.generateTestHeaderString({ payload: rawBody, secret });
  let repositoryFactoryCalls = 0;

  const outcome = await handleStripeWebhook({
    rawBody,
    signature,
    webhookSecret: secret,
    verifyEvent: (body, header, webhookSecret) =>
      stripe.webhooks.constructEvent(body, header, webhookSecret),
    getRepository: () => {
      repositoryFactoryCalls += 1;
      return new InMemoryRepository(registration());
    },
  });

  assert.deepEqual(outcome, { status: 200, code: "ignored_event" });
  assert.equal(repositoryFactoryCalls, 0);
});

test("missing signature cannot reach verification or mutation logic", async () => {
  const result = await runWebhook({ signature: null });

  assert.deepEqual(result.outcome, { status: 400, code: "invalid_signature" });
  assert.equal(result.verifiedRawBody, undefined);
  assert.equal(result.repositoryFactoryCalls, 0);
  assert.equal(result.repository.transitionCount, 0);
});

test("unsupported verified event is acknowledged without mutation", async () => {
  const result = await runWebhook({ event: stripeEvent("customer.created", {}) });

  assert.deepEqual(result.outcome, { status: 200, code: "ignored_event" });
  assert.equal(result.verifiedRawBody, "raw-webhook-body");
  assert.equal(result.repositoryFactoryCalls, 0);
  assert.equal(result.repository.transitionCount, 0);
});

test("completed Session that is not paid is acknowledged without mutation", async () => {
  const result = await runWebhook({
    event: stripeEvent(
      "checkout.session.completed",
      checkoutSession({ payment_status: "unpaid" }),
    ),
  });

  assert.deepEqual(result.outcome, { status: 200, code: "ignored_unpaid" });
  assert.equal(result.repositoryFactoryCalls, 0);
  assert.equal(result.repository.transitionCount, 0);
});

test("missing metadata is rejected without mutation", async () => {
  const result = await runWebhook({
    event: stripeEvent("checkout.session.completed", checkoutSession({ metadata: {} })),
  });

  assert.deepEqual(result.outcome, { status: 400, code: "malformed_session" });
  assert.equal(result.repositoryFactoryCalls, 0);
  assert.equal(result.repository.transitionCount, 0);
});

test("wrong event ID causes no mutation", async () => {
  const result = await runWebhook({
    registration: registration({
      eventId: "00000000-0000-4000-8000-000000000099",
    }),
  });

  assert.deepEqual(result.outcome, { status: 500, code: "registration_mismatch" });
  assert.equal(result.repository.transitionCount, 0);
});

test("wrong Checkout Session ID causes no mutation", async () => {
  const result = await runWebhook({
    registration: registration({ checkoutSessionId: "cs_test_unrelated" }),
  });

  assert.deepEqual(result.outcome, { status: 500, code: "registration_mismatch" });
  assert.equal(result.repository.transitionCount, 0);
});

test("amount mismatch causes no mutation", async () => {
  const result = await runWebhook({ registration: registration({ amountCents: 9999 }) });

  assert.deepEqual(result.outcome, { status: 500, code: "registration_mismatch" });
  assert.equal(result.repository.transitionCount, 0);
});

test("currency mismatch causes no mutation", async () => {
  const result = await runWebhook({ registration: registration({ currency: "EUR" }) });

  assert.deepEqual(result.outcome, { status: 500, code: "registration_mismatch" });
  assert.equal(result.repository.transitionCount, 0);
});

test("valid paid Session transitions pending registration to paid", async () => {
  const result = await runWebhook();

  assert.deepEqual(result.outcome, { status: 200, code: "processed" });
  assert.equal(result.repository.transitionCount, 1);
  assert.equal(result.repository.state?.paymentStatus, "paid");
  assert.equal(result.repository.state?.paidAt, FIXED_PAID_AT);
  assert.equal(result.repository.state?.paymentIntentId, PAYMENT_INTENT_ID);
});

test("PaymentIntent string representation is extracted safely", () => {
  const session = parseVerifiedPaidSession(
    checkoutSession({ payment_intent: PAYMENT_INTENT_ID }),
  );

  assert.equal(session?.paymentIntentId, PAYMENT_INTENT_ID);
});

test("duplicate valid webhook is harmless and preserves paid_at", async () => {
  const originalPaidAt = "2099-06-15T18:34:00.000Z";
  const result = await runWebhook({
    registration: registration({
      paymentStatus: "paid",
      paidAt: originalPaidAt,
      paymentIntentId: PAYMENT_INTENT_ID,
    }),
  });

  assert.deepEqual(result.outcome, { status: 200, code: "already_processed" });
  assert.equal(result.repository.transitionCount, 0);
  assert.equal(result.repository.state?.paidAt, originalPaidAt);
  assert.equal(result.repository.state?.paymentStatus, "paid");
});

test("verified live-mode event is rejected without mutation", async () => {
  const result = await runWebhook({
    event: stripeEvent("checkout.session.completed", checkoutSession(), true),
  });

  assert.deepEqual(result.outcome, { status: 400, code: "live_mode_rejected" });
  assert.equal(result.repositoryFactoryCalls, 0);
  assert.equal(result.repository.transitionCount, 0);
});
