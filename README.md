# Marat Events — Phase 0

Phase 0 provides a server-rendered event page, Stripe-hosted Checkout in test mode, and a verified Stripe webhook that transitions a registration from `pending` to `paid`. It does not implement email, refunds, authentication, admin UI, invitations, check-in, matching, or analytics.

## Requirements

- Node.js 22+
- npm
- Supabase project
- Stripe test/sandbox account
- Stripe CLI for local webhook forwarding

## Environment

Copy the template:

```powershell
Copy-Item .env.example .env.local
```

Required server-only variables:

```dotenv
SUPABASE_URL=
SUPABASE_SECRET_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

`SUPABASE_SECRET_KEY` should be a modern Supabase backend secret key (`sb_secret_...`) from **Settings > API Keys**. It bypasses RLS and must remain server-only. Do not expose it in browser code and never prefix it with `NEXT_PUBLIC_`.

`STRIPE_SECRET_KEY` must be a Stripe test-mode key beginning with `sk_test_`. The current server intentionally rejects live Stripe keys.

`STRIPE_WEBHOOK_SECRET` must be the `whsec_...` secret for the webhook source that actually sends requests. Stripe CLI forwarding and Dashboard webhook endpoints use different signing secrets.

Never commit `.env` or `.env.*` files. `.env.example` contains names only.

## Supabase schema

The migration at:

```text
supabase/migrations/20260814000000_initial_events.sql
```

creates exactly:

- `public.events`
- `public.registrations`

Both tables have RLS enabled and intentionally have no public policies in Phase 0. Application database access is performed only through the server-only Supabase secret key.

The development seed at `supabase/seed.sql` creates one fictional published event:

```text
demo-marats-future-event
```

### Hosted Supabase

Apply migrations with the Supabase CLI or Dashboard. The migration must be applied before the seed.

```powershell
supabase login
supabase link --project-ref <project-ref>
supabase db push
```

## Run locally

```powershell
npm install
npm run dev
```

Then open:

```text
http://localhost:3000/events/demo-marats-future-event
```

Only `published` events are public. Unpublished events return 404. Event times are rendered explicitly in `America/New_York`.

## Checkout flow

1. `/events/[slug]` posts `slug`, `full_name`, and `email` to `POST /api/checkout`.
2. Server-side validation is authoritative.
3. The event is loaded from Supabase and must be `published` and in the future.
4. Price and currency always come from the database, never from client input.
5. If capacity exists, only `paid` registrations are counted. This is a soft Phase 0 capacity check, not transactional seat reservation.
6. A `pending` registration is inserted.
7. Stripe Checkout Session is created in test mode with one card payment and metadata containing `registration_id` and `event_id`.
8. `stripe_checkout_session_id` is stored on the still-pending registration.
9. Browser is redirected to Stripe-hosted Checkout.
10. `/success` is neutral and never proves payment.

## Verified Stripe webhook

Endpoint:

```text
POST /api/stripe/webhook
```

The webhook:

- reads the unchanged raw body;
- verifies `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET` before database access;
- rejects live-mode events;
- handles only `checkout.session.completed` in Phase 0;
- requires `payment_status === "paid"`;
- cross-checks registration ID, event ID, Checkout Session ID, amount, and currency against Supabase;
- performs only a conditional `pending -> paid` transition;
- stores `paid_at` and the PaymentIntent ID when available;
- treats a matching already-paid registration as a harmless duplicate;
- never uses the `/success` redirect as proof of payment.

A duplicate delivery must not rewrite `paid_at` or create another registration.

## Local Stripe webhook test

Start the app, then in another terminal:

```powershell
stripe login
stripe listen --events checkout.session.completed --forward-to localhost:3000/api/stripe/webhook
```

Copy the listener's `whsec_...` value into `.env.local` as `STRIPE_WEBHOOK_SECRET`, then restart `npm run dev`.

Manual test sequence:

1. Open the demo event page.
2. Submit name and email.
3. Complete Stripe Checkout with Stripe test card data.
4. Confirm the webhook is received.
5. Confirm the registration becomes `paid` with `paid_at`, Checkout Session ID, and PaymentIntent ID populated.
6. Redeliver the same Stripe event and confirm `paid_at` does not change.
7. Visit `/success` manually and confirm it changes nothing.
8. Cancel a Checkout and confirm the registration remains `pending`.
9. Send a request without a valid Stripe signature and confirm no database mutation occurs.

## Validation

Run:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

GitHub Actions runs the same checks on Ubuntu with Node.js 22.

## Security rules

See `AGENTS.md`. In particular:

- no privileged Supabase key in client code;
- no Stripe secret in client code;
- no `NEXT_PUBLIC_` secrets;
- Stripe webhook verification is mandatory;
- redirects do not confirm payment;
- duplicate webhook delivery must be safe;
- test/staging environments never use Stripe live credentials.
