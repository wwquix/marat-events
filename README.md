# Marat Events — Phase 0

This is the Vercel-compatible Phase 0 foundation for Marat Events. It contains a server-rendered public event page, test-mode Stripe-hosted Checkout creation, and verified test-mode payment webhooks. It does not send email, process refunds, authenticate users, or provide an admin interface.

## Prerequisites

- Node.js 20.9 or later and npm.
- A Supabase project. For a local database, install the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) and Docker.
- `psql` only if you want to run the seed manually against a hosted database.

## Install and configure the app

Install dependencies:

```powershell
npm install
```

Create a local environment file from the template and add the two server credentials from your Supabase project, a Stripe test secret key, and the test webhook signing secret:

```powershell
Copy-Item .env.example .env.local
```

Required application environment variables:

```dotenv
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

There are no public environment variables in Phase 0. Do not give any secret a `NEXT_PUBLIC_` prefix, do not commit `.env.local`, and do not place secrets in browser code. In Vercel, add all four values as server-side environment variables for the relevant environment; they must not be configured as public variables.

`STRIPE_SECRET_KEY` must be a Stripe test-mode key beginning with `sk_test_`. The server rejects live keys. Local, preview, and staging environments must use Stripe test credentials. A future production live account and its credentials belong to Marat's business.

`STRIPE_WEBHOOK_SECRET` must be the test endpoint signing secret beginning with `whsec_`. A Stripe CLI listener and a Dashboard-managed webhook endpoint have different signing secrets; use the secret for the endpoint that actually sends the request.

## Supabase schema and fake seed

The sole migration at `supabase/migrations/20260814000000_initial_events.sql` creates only `public.events` and `public.registrations`. Both have RLS enabled and deliberately have no policies, so public roles have no direct application-table access. The application reads events only through its server-only service-role client.

### Local Supabase

From the repository root, initialize the Supabase CLI configuration once if it is not already present, start the local stack, and reset it. `db reset` applies all migrations and `supabase/seed.sql`:

```powershell
supabase init
supabase start
supabase db reset
```

Use the local API URL and service-role key printed by `supabase status` in `.env.local`. The seed creates only one obviously fake 2099 demo event and has no registrations. It uses `on conflict (slug) do nothing`, so it is safe to run repeatedly.

### Hosted Supabase

Log in and link the repository to the intended project, then apply the migration:

```powershell
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

For the optional fake seed, copy the database connection string from the Supabase dashboard and run this command locally (do not save that connection string in the repository):

```powershell
psql "<hosted-database-connection-string>" -v ON_ERROR_STOP=1 -f supabase/seed.sql
```

Alternatively, paste the contents of `supabase/seed.sql` into the hosted project's SQL Editor and run it once. The migration must be applied before the seed. Hosted credentials are not included in this repository.

## Run and verify

Start the development server:

```powershell
npm run dev
```

Then visit `/events/demo-marats-future-event` after configuring Supabase. `/success` is a neutral static placeholder: it does not inspect URL parameters or a checkout session, and it does not confirm a payment or registration.

## Test-mode Checkout flow

1. The server-rendered event page posts `slug`, `full_name`, and `email` to `POST /api/checkout`. HTML validation improves the form experience, but the Route Handler repeats all validation authoritatively.
2. The server loads the event by slug. Only an event with `status = published` and a future `starts_at` value is available for sale. Ticket amount and currency always come from the event row; client-supplied price fields are ignored.
3. If capacity is set, the server counts only registrations whose `payment_status` is `paid`. Checkout is refused when that count is at least the event capacity.
4. The server inserts one `pending` registration using the validated name/email and database amount/currency. It never sets `paid_at`.
5. The server creates exactly one Stripe Checkout line item in test mode, explicitly allows only the `card` payment method, and attaches `registration_id` and `event_id` as Session metadata. Delayed-notification payment methods are not enabled. The registration-based Stripe idempotency key limits duplicate Session creation if that Session operation is retried.
6. The server stores `stripe_checkout_session_id` on the still-pending registration, then redirects to Stripe's hosted Checkout URL.
7. Stripe redirects successful Checkout visits to `/success?session_id={CHECKOUT_SESSION_ID}` and cancellations back to the event page. The success page does not read or trust `session_id`, update the database, or claim payment confirmation.

The capacity check is deliberately soft in Phase 0. Counting paid registrations and creating a pending registration are not a transactional seat reservation, so simultaneous buyers can pass the check. Do not treat it as an oversell guarantee.

If Stripe Session creation or the follow-up database update fails, the browser receives a safe error and is not told Checkout succeeded. A pending registration can remain for later diagnosis or cleanup; server logs include the failed operation stage and non-secret identifiers, never secret keys, names, or email addresses.

## Verified payment webhook

`POST /api/stripe/webhook` reads the raw request body and `Stripe-Signature` header. It calls the Stripe SDK's signature verifier before inspecting the event or creating a Supabase client. Missing or invalid signatures receive `400` and cannot reach registration mutation logic. Verified unsupported event types receive `200` without database access.

Phase 0 processes only verified, test-mode `checkout.session.completed` events whose Checkout Session is complete, uses payment mode, allows only card, and has `payment_status = paid`. An unpaid completed Session is acknowledged without mutation. The success page and its `session_id` query parameter never participate in confirmation.

Before a registration can transition from `pending` to `paid`, all of these values must agree:

- verified Session metadata contains valid `registration_id` and `event_id` values;
- the registration exists and its `event_id` matches;
- `stripe_checkout_session_id` exactly matches the verified Session ID;
- local `amount_cents` equals Stripe `amount_total`;
- local currency equals the Stripe Session currency;
- the local status is `pending` with no existing `paid_at` value.

The update repeats those conditions in the database query and changes only `payment_status`, `paid_at`, and, when present, `stripe_payment_intent_id`. It does not change `confirmation_sent_at` or `refunded_at`. If concurrent delivery wins the update, the handler reloads the row and accepts it only when the same verified session/event/amount/currency already produced a consistent paid registration.

An already-paid matching registration receives `200` without another update, so duplicate delivery does not rewrite `paid_at`. Mismatches and transient database failures receive `500` so Stripe can retry after the local problem is corrected. Logs are limited to Stripe event ID/type, Checkout Session ID, registration ID, processing stage, and generic category. Raw payloads, signatures, secrets, guest identity, and payment details are never logged.

### Local Stripe CLI verification

Start the application, then run a test-mode Stripe listener in a second terminal:

```powershell
stripe login
stripe listen --events checkout.session.completed --forward-to localhost:3000/api/stripe/webhook
```

Copy the listener's `whsec_...` value into `STRIPE_WEBHOOK_SECRET` in `.env.local`, then restart the development server. Do not use a Dashboard endpoint secret for CLI-forwarded events.

Manual test plan:

1. **Valid payment:** create Checkout through the real event form, complete the card payment with Stripe test data, observe a verified webhook, and confirm the registration becomes `paid` with `paid_at` and `stripe_payment_intent_id` populated.
2. **Duplicate delivery:** note the Stripe event ID and resend the same event to a registered test webhook with `stripe events resend <event_id> --webhook-endpoint=<endpoint_id>` (or use Workbench's retry action). Confirm no extra record is created and the original `paid_at` value is unchanged.
3. **Invalid signature:** POST without a valid `Stripe-Signature`. Confirm the endpoint returns `400` and the registration is unchanged.
4. **Browser redirect without webhook:** visit `/success?session_id=anything` manually. Confirm a pending registration stays pending.
5. **Cancelled Checkout:** cancel on Stripe Checkout and return to the event page. Confirm the registration stays pending.
6. **Mismatch simulation:** in an isolated test database, alter the expected amount, currency, event ID, or Checkout Session ID before redelivery. Confirm the webhook returns a server error and performs no paid-state mutation; restore the row before normal testing.

Run the local verification commands:

```powershell
npm run lint
npm run typecheck
npm test --if-present
npm run build
```

The test suite covers authoritative checkout input, sale availability, soft capacity, database-controlled Stripe pricing, signature gating, unsupported/unpaid events, required metadata, every local cross-check, the valid pending-to-paid transition, and duplicate delivery with stable `paid_at`. It does not call Stripe or Supabase.

Before manual testing, apply the migration and seed, configure a disposable Supabase project, and use Stripe test-mode credentials. No real Supabase or Stripe connection is exercised by the automated commands. Vercel server secrets must remain server-only.
