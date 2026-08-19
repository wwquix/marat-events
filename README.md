# Marat Events

Marat Events is the event operations system for Marat's dating events. The product is being built in phases from registration/payment through audience imports, invitations, check-in, likes/matches, analytics and production hardening.

The canonical execution order is in [`ROADMAP.md`](./ROADMAP.md).

## Current status

- Phase 0 — payment core: **complete**.
- Phase 1 — registration core + basic admin: **complete and staging-verified**.
- Phase 2 — audience database, import, segmentation, invitation attribution and safe outbound: **provider-independent foundation implemented; issuance UI, staging gate and real delivery still open**.
- Phase 3 — check-in: **foundation implemented; event-phone staging gate still open**.
- Phase 4 — matching: **privacy foundation implemented; audience policy and staging gate still open**.
- Phase 5/6 — CRM, analytics and production hardening: **in progress; production is blocked**.

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

### Audience import

- protected CSV upload and non-mutating validation preview;
- trusted-identifier matching for email, phone, Instagram and LinkedIn, never by name alone;
- explicit review outcomes: reuse an offered candidate, create a new person when safe, or exclude the row;
- review audit data with resolver identity and timestamp;
- an explicit atomic PostgreSQL commit that locks the batch and revalidates current identities;
- retry-safe committed batches and fail-closed rollback on stale or ambiguous identity conflicts;
- imported contacts retain `consent_status=unknown` and `contactability_status=unknown`.

### Segmentation and outbound safety

- typed reusable segments and event-scoped selection snapshots;
- explicit manual include/exclude overrides with non-bypassable suppression and contact safety;
- one service-role-only SQL evaluator shared by selection and campaign preview;
- immutable message-template versions and deterministic rendering;
- campaign recipient preview with eligibility and reason codes;
- durable Outbox, immutable delivery attempts/audit and idempotency keys;
- live policy rechecks at queue and claim time;
- America/New_York sending windows, leases and bounded retries;
- only disabled and DRY_RUN adapters, with database-enforced `provider_called=false`;
- opaque hash-only campaign invitation tokens with audited issue/revoke operations and event/recipient/intended-person attribution;
- valid links record `campaign_invite`; malformed, expired, revoked, wrong-event or forwarded links remain ordinary unattributed `event_page` registrations.

No invitation issuance UI and no email, SMS, WhatsApp, Telegram or Instagram provider is connected. DRY_RUN completion and invitation attribution are not delivery.

### Check-in

- paid-only opaque check-in tokens with SHA-256 hash-only persistence;
- QR payloads without attendee or payment data;
- atomic issue/reissue, revoke, scan and manual check-in RPCs;
- duplicate/wrong-event/unpaid/revoked/expired outcomes and attempt audit;
- protected event operations page and public bearer-token ticket page;
- manual token/search fallback; camera scanning is not implemented.

### Matching, analytics and CRM

- separate paid+checked-in matching bearer tokens stored hash-only;
- explicit participant profile activation;
- event-scoped, idempotent likes and race-safe unique mutual matches;
- participant state that hides inbound one-sided identities and counts;
- live SQL-derived event funnel counts, capacity/revenue and ticket/source/campaign breakdowns;
- protected, private/no-store CSV exports for audience, attendees, campaigns, event summary and mutual matches;
- hosted-cap-safe export paging through 5,000 rows and spreadsheet-formula neutralization;
- bounded CRM notes, tags and follow-up tasks;
- audited suppression/reactivation history;
- bounded per-person campaign, invitation, attributed-registration and Outbox history without token hashes, destinations or message bodies;
- bounded mutual-match history that never queries or exposes one-sided likes or counts.

Matching does not yet implement gender/preference audience rules or notification delivery. The current candidate foundation is not approved for real participants.

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

The environment policy in `lib/config/environment-policy.ts` classifies current staging-required variables, keeps unapproved provider variables absent and models production as fail closed. It is a reusable preflight policy, not proof that a deployment was configured correctly. Development/tests remain buildable without provider secrets.

Do not invent outbound-provider, rate-limit-provider or production URL variable names in deployment configuration. Define and document them only with the approved implementation.

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

Later foundations add audience provenance/contacts/review, segmentation snapshots, campaign/outbox audit, check-in, matching, CRM notes/tags/tasks, suppression history and privacy-limited communication/mutual-match history on the canonical person record.

The import commit runs through the server-only `commit_audience_import` RPC. The function serializes audience import commits with a transaction-scoped advisory lock, locks the selected preview batch, validates every eligible row and the batch-wide trusted-identifier ownership plan before writing, then creates/reuses people and contacts in the same PostgreSQL transaction. Invalid and explicitly excluded rows remain as non-committed history.

Do not apply migrations to staging from a development task. After merge, review and apply migrations through the normal staging deployment process, then verify the audience import flow with test data only.

RLS is enabled on protected application tables and there are no public policies. Application access currently goes through server-only code using the Supabase secret key.

Known import preview-atomicity and cleanup-reporting gaps are documented in [`docs/imports.md`](./docs/imports.md). Do not use the real audience until those items and the staging import gate are closed.

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

Provider-independent admin routes include:

- `/admin/audience/import` and `/admin/audience/segments`;
- `/admin/campaigns` and `/admin/outbox` (DRY_RUN only);
- `/admin/check-in/[eventId]`;
- `/admin/matching/[eventId]`;
- `/admin/analytics/[eventId]`;
- `/admin/people`.

Public invitation query strings, `/ticket/[token]` and `/match/[token]` URLs contain bearer credentials. Never put real tokens in screenshots, analytics, tickets or logs.

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

The project now emits conservative `nosniff`, referrer, frame and permissions headers and includes a structured redaction/logger helper for future operational logs. A complete Content Security Policy, durable provider-backed rate limiting, adoption of safe logging at every log site and a monitoring backend remain open.

## Validation

Run before merge:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

GitHub Actions runs the same checks with Node.js 22 on pull requests and pushes to `main`.

Automated checks do not replace the manual staging gate. Use invented data and follow:

- [`docs/imports.md`](./docs/imports.md);
- [`docs/outbound.md`](./docs/outbound.md);
- [`docs/check-in.md`](./docs/check-in.md);
- [`docs/matching.md`](./docs/matching.md);
- [`docs/production-readiness.md`](./docs/production-readiness.md).

## Documentation

- [`docs/architecture.md`](./docs/architecture.md) — boundaries and domain model;
- [`docs/imports.md`](./docs/imports.md) — import invariants, gaps and recovery;
- [`docs/outbound.md`](./docs/outbound.md) — policy, Outbox and DRY_RUN reality;
- [`docs/invitations.md`](./docs/invitations.md) — hash-only tracked-link attribution and remaining delivery gap;
- [`docs/check-in.md`](./docs/check-in.md) — token and event-day operations;
- [`docs/matching.md`](./docs/matching.md) — privacy model and product gaps;
- [`docs/production-readiness.md`](./docs/production-readiness.md) — explicit launch blockers;
- [`docs/operations-runbook.md`](./docs/operations-runbook.md) — incident and recovery procedures.

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
