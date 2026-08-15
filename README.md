# Marat Events

Marat Events is the event operations system for Marat's dating events. The product is being built in phases from registration/payment through audience imports, invitations, check-in, likes/matches, analytics and production hardening.

The canonical execution order is in [`ROADMAP.md`](./ROADMAP.md).

## Current status

- Phase 0 — payment core: **complete**.
- Phase 1 — registration core + basic admin: **complete and staging-verified**.
- Phase 2 — audience database, import and invitations: **in progress**.

Phase 1's acceptance gate was completed on staging with an event created from the admin UI, Men/Women tickets configured in the admin UI, a public registration, Stripe test payment, verified webhook transition to `paid`, attendee administration, filters/search and filtered CSV export.

## Implemented now

### Public registration and payment

- server-rendered public event pages;
- full registration form with name, email, phone, age, gender and ticket type;
- central `people` identity plus per-registration identity snapshots;
- server-authoritative event/ticket/gender/price validation;
- Stripe-hosted Checkout in test mode;
- pending registration before Checkout;
- verified Stripe webhook;
- conditional and idempotent `pending -> paid` transition;
- `paid_at`, Checkout Session ID and PaymentIntent tracking;
- duplicate webhook safety;
- Men/Women/Any ticket audiences and capacities.

### Protected admin

- server-side admin email/password authentication;
- scrypt password hash and signed HttpOnly session cookie;
- protected `/admin` routes and server actions;
- event creation/edit/publish/hide;
- ticket creation/edit/hide/sold-out controls;
- safeguards against changing commercial ticket identity after paid registrations;
- safeguards against reducing capacity below already-paid registrations;
- attendee list, search and payment/gender/ticket/source filters;
- registration detail page showing registration snapshot and central person;
- protected CSV export that respects current filters/search;
- CSV formula-injection neutralization and UTF-8 Excel compatibility.

## Requirements

- Node.js 22+
- npm
- Supabase project
- Stripe test/sandbox account
- Stripe CLI for local webhook forwarding when testing webhooks locally

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
ADMIN_EMAIL=
ADMIN_PASSWORD_HASH=
ADMIN_SESSION_SECRET=
```

Generate the admin password hash and session secret locally:

```powershell
npm run admin:credentials
```

Never send or commit the plaintext admin password, password hash, session secret, Supabase secret key, Stripe secret key or webhook signing secret.

`SUPABASE_SECRET_KEY` is server-only and bypasses RLS. `STRIPE_SECRET_KEY` must be a Stripe test-mode key in staging. No privileged key may use a `NEXT_PUBLIC_` prefix.

## Database

Supabase/PostgreSQL is the source of truth. Current migrations live in:

```text
supabase/migrations/
```

The Phase 0/1 schema includes:

- `events`;
- `registrations`;
- `people`;
- `ticket_types`.

Phase 2 expands the central audience model with import provenance, contact channels, consent/contactability, suppression and identity-review state.

RLS is enabled on protected application tables and there are no public policies. Application access currently goes through server-only code using the Supabase secret key.

## Local development

```powershell
npm install
npm run dev
```

Demo public event:

```text
http://localhost:3000/events/demo-marats-future-event
```

Admin:

```text
http://localhost:3000/admin
```

Only `published` future events are publicly sellable. Event/business time is presented in `America/New_York`; stored timestamps are UTC.

## Checkout invariants

The browser is never authoritative for payment, ticket price, event identity or ticket eligibility.

1. Checkout input is validated on the server.
2. Event must be published and in the future.
3. Ticket must belong to that event and be active.
4. Ticket audience must match the submitted gender when restricted.
5. Price/currency come from `ticket_types` in PostgreSQL.
6. Capacity is checked against paid registrations.
7. A pending registration is created before Stripe Checkout.
8. Stripe Checkout is card-only in the current staging flow.
9. Checkout metadata contains registration/event/ticket identifiers.
10. The browser success redirect does **not** prove payment.

Current capacity checking is intentionally still a soft count check. Transactional/concurrency-safe seat reservation is a required production-hardening task before real ticket sales.

## Verified Stripe webhook

Endpoint:

```text
POST /api/stripe/webhook
```

The webhook:

- reads the unchanged raw request body;
- verifies `Stripe-Signature` before database access;
- rejects live-mode events in the current staging implementation;
- handles `checkout.session.completed` only when `payment_status === "paid"`;
- requires test-mode, card-only, payment-mode Checkout Sessions;
- validates registration ID, event ID, Checkout Session ID, amount and currency against PostgreSQL;
- conditionally transitions only a matching `pending` registration to `paid`;
- writes `paid_at` and PaymentIntent when available;
- accepts matching duplicate deliveries without rewriting `paid_at`.

## Admin security

Admin credentials are server-only environment variables. The password is stored as a scrypt hash, not plaintext. Successful login creates a bounded signed session stored in an HttpOnly cookie. Protected server actions call the admin-session guard again rather than relying only on UI routing.

Rate limiting, broader authorization/RBAC and production abuse controls remain in the production-hardening phase.

## Validation

Run before merge:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

GitHub Actions runs the same checks with Node.js 22 on pull requests and pushes to `main`.

## Project rules

See [`AGENTS.md`](./AGENTS.md) and [`ROADMAP.md`](./ROADMAP.md). Important rules include:

- PostgreSQL/Supabase remains the system of record;
- payment is confirmed only by verified Stripe webhooks;
- payment/webhook handling stays idempotent;
- test/staging never uses Stripe live credentials;
- no silent identity merge by name;
- ambiguous identity conflicts require human review;
- before real automated outbound messaging, sends must go through deterministic policy checks, Outbox, AuditLog, DRY_RUN, consent/channel checks and idempotent processing;
- LLM output must not directly send messages or mutate payment/matching/identity state.
