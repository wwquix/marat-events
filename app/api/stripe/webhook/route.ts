import { NextRequest, NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getStripeServerClient, getStripeWebhookSecret } from "@/lib/stripe/server";
import {
  handleStripeWebhook,
  type RegistrationRepository,
  type RegistrationSnapshot,
  type VerifiedPaidSession,
  type WebhookLogEntry,
} from "@/lib/webhook/payment";

export const runtime = "nodejs";

const REGISTRATION_FIELDS =
  "id,event_id,stripe_checkout_session_id,stripe_payment_intent_id,amount_cents,currency,payment_status,paid_at";

function logWebhook(entry: WebhookLogEntry) {
  const method = entry.category === "verified" ? "info" : "error";
  console[method]("stripe_webhook", entry);
}

function parseRegistration(value: unknown): RegistrationSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.event_id !== "string" ||
    (row.stripe_checkout_session_id !== null &&
      typeof row.stripe_checkout_session_id !== "string") ||
    (row.stripe_payment_intent_id !== null &&
      typeof row.stripe_payment_intent_id !== "string") ||
    typeof row.amount_cents !== "number" ||
    !Number.isSafeInteger(row.amount_cents) ||
    typeof row.currency !== "string" ||
    typeof row.payment_status !== "string" ||
    (row.paid_at !== null && typeof row.paid_at !== "string")
  ) {
    return null;
  }

  return {
    id: row.id,
    eventId: row.event_id,
    checkoutSessionId: row.stripe_checkout_session_id,
    paymentIntentId: row.stripe_payment_intent_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    paymentStatus: row.payment_status,
    paidAt: row.paid_at,
  };
}

function createRegistrationRepository(): RegistrationRepository {
  const supabase = createSupabaseServerClient();

  return {
    async loadById(registrationId) {
      const { data, error } = await supabase
        .from("registrations")
        .select(REGISTRATION_FIELDS)
        .eq("id", registrationId)
        .maybeSingle();

      if (error) {
        throw new Error("Registration lookup failed.");
      }

      if (data === null) {
        return null;
      }

      const registration = parseRegistration(data);
      if (!registration) {
        throw new Error("Registration data is invalid.");
      }

      return registration;
    },

    async transitionPendingToPaid(session: VerifiedPaidSession, paidAt: string) {
      const update: Record<string, string> = {
        payment_status: "paid",
        paid_at: paidAt,
      };

      if (session.paymentIntentId) {
        update.stripe_payment_intent_id = session.paymentIntentId;
      }

      const { data, error } = await supabase
        .from("registrations")
        .update(update)
        .eq("id", session.registrationId)
        .eq("event_id", session.eventId)
        .eq("stripe_checkout_session_id", session.sessionId)
        .eq("amount_cents", session.amountTotal)
        .eq("currency", session.currency.toUpperCase())
        .eq("payment_status", "pending")
        .select(REGISTRATION_FIELDS)
        .maybeSingle();

      if (error) {
        throw new Error("Registration update failed.");
      }

      if (data === null) {
        return null;
      }

      const registration = parseRegistration(data);
      if (!registration) {
        throw new Error("Updated registration data is invalid.");
      }

      return registration;
    },
  };
}

export async function POST(request: NextRequest) {
  let rawBody: string;

  try {
    rawBody = await request.text();
  } catch {
    logWebhook({ stage: "read_body", category: "invalid_request_body" });
    return NextResponse.json({ error: "Invalid webhook request." }, { status: 400 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    logWebhook({ stage: "signature_verification", category: "missing_signature" });
    return NextResponse.json({ error: "Invalid webhook request." }, { status: 400 });
  }

  let stripe: ReturnType<typeof getStripeServerClient>;
  let webhookSecret: string;

  try {
    stripe = getStripeServerClient();
    webhookSecret = getStripeWebhookSecret();
  } catch {
    logWebhook({ stage: "configuration", category: "server_configuration" });
    return NextResponse.json({ error: "Webhook processing failed." }, { status: 500 });
  }

  const outcome = await handleStripeWebhook({
    rawBody,
    signature,
    webhookSecret,
    verifyEvent: (body, signature, secret) =>
      stripe.webhooks.constructEvent(body, signature, secret),
    getRepository: createRegistrationRepository,
    log: logWebhook,
  });

  if (outcome.status === 200) {
    return NextResponse.json({ received: true }, { status: 200 });
  }

  const message =
    outcome.status === 400 ? "Invalid webhook request." : "Webhook processing failed.";
  return NextResponse.json({ error: message }, { status: outcome.status });
}
