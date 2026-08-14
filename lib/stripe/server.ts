import "server-only";

import Stripe from "stripe";

let stripeClient: Stripe | undefined;

export function getStripeServerClient(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey || !secretKey.startsWith("sk_test_")) {
    throw new Error("Stripe test-mode server configuration is unavailable.");
  }

  stripeClient ??= new Stripe(secretKey, {
    maxNetworkRetries: 2,
  });

  return stripeClient;
}

export function getStripeWebhookSecret(): string {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret || !webhookSecret.startsWith("whsec_")) {
    throw new Error("Stripe test-mode webhook configuration is unavailable.");
  }

  return webhookSecret;
}
