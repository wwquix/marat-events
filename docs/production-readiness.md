# Production readiness

## Decision

**Not ready for production or real ticket sales.**

The current code is a test/staging foundation. Passing automated tests or a Vercel preview does not remove the blockers below. Production approval requires explicit evidence for every P0 item and a controlled Marat-owned acceptance test.

## P0 launch blockers

### Transactional capacity and payment policy

Checkout currently counts paid registrations and then creates a pending registration/Stripe Session. Two concurrent customers can both pass the count before either webhook marks payment paid, overselling event or ticket capacity.

A business decision is required before implementation:

- reserve at checkout with expiring holds;
- enforce at payment and define late-payment/refund behavior;
- or another transactionally safe policy.

The decision must cover session abandonment, hold expiry, simultaneous webhooks, failed/late payment, cancellation, refund and operator capacity edits. Do not enable real sales until concurrency tests prove the chosen invariant.

Recommended design, subject to business approval:

1. Add a reservation row keyed idempotently to the pending registration, scoped to event and ticket, with `held`, `confirmed`, `released` and `expired` transitions.
2. Create the pending registration and hold in one PostgreSQL RPC that locks the event/ticket capacity scope and counts paid plus unexpired holds.
3. Create Stripe Checkout only after the hold succeeds; persist the Session ID idempotently and release/reconcile if Session creation or persistence fails.
4. Let only the verified Stripe webhook confirm payment and the hold in one transaction.
5. Use a durable scheduled cleanup to expire abandoned holds; do not depend on an in-memory timer or browser redirect.
6. Make operator capacity edits validate paid registrations plus active holds.
7. Define late-payment behavior explicitly. The safe default is to stop fulfillment and initiate an operator-reviewed/refund path rather than silently oversell.

The unapproved choices are hold duration, whether Checkout Session expiry is authoritative, acceptable late-payment handling and automatic versus manual refund policy. Those choices are why this foundation does not add a speculative reservation table yet.

### Production Stripe activation

The server accepts test secret keys and rejects live webhook events. Production keys/account ownership, live webhook endpoint, refunds/cancellations and reconciliation tooling are not implemented. Stripe production credentials must belong to Marat's business and must never be copied into preview/staging.

### Canonical public URL

Checkout success/cancel URLs currently derive from the incoming request origin. Production needs one validated canonical application URL and trusted-proxy/host policy so attacker-controlled host data cannot influence externally stored redirects. The environment-variable name is intentionally not defined until that implementation is approved.

The implementation should parse one server-only HTTPS origin at startup, reject credentials/path/query fragments, use it for Stripe and invitation links, and separately reject unexpected request hosts at the routing edge. Preview must use a preview-specific origin; it must never fall back to the production domain implicitly.

### Durable abuse controls

Public checkout, admin login and bearer-token participant routes have no durable production rate limiter. Select a provider-backed limiter that works across Vercel instances/regions, define fail-open/fail-closed behavior by route, protect body sizes and alert on abuse. Do not substitute an in-memory map and call it production protection.

### Backup and restore proof

Define the production Supabase backup/PITR plan, retention and responsible owner. Perform a restore into an isolated project, verify credentials/connections after restore, run invariant checks and record restoration time/objective. A configured backup without a successful restore drill is not proof.

## P0 data-integrity follow-ups

- Make preview persistence atomic and surface cleanup failures. SQL batch row-count equality, committed/history immutability and shared review/commit lock serialization are now enforced.
- Event status, event/ticket correlation and unique non-null PaymentIntent ownership are now enforced. Define and constrain the remaining payment-status/timestamp/refund combinations with the refund policy.
- Define recovery for a Stripe Session created successfully when storing its Session ID fails.
- Define refund/cancellation states and verified webhook transitions before refunds are offered.
- Approve matching audience/preference rules; the foundation currently offers every other eligible active profile in the event.

## Security and privacy follow-ups

- Perform a migration-by-migration RLS, grant and RPC review against the hosted project configuration.
- Replace shared admin credentials with the approved production operator/RBAC model, session revocation and audit identity.
- Complete abuse controls and upload/request size limits.
- Add a tested Content Security Policy compatible with Next.js and Stripe; the current headers intentionally omit CSP.
- Audit every log site and platform access log for PII, webhook payloads, credentials and bearer tokens in URL paths or query strings.
- Define retention, deletion, export and incident-notification policy for contact, dating preference, likes/matches, notes and audit data.
- Rotate all staging credentials before launch and document emergency rotation.

## Reliability and operations follow-ups

- Connect error/uptime monitoring with safe redaction and alert ownership.
- Alert on webhook failures, stuck/expired outbox leases, repeated import failures and database capacity.
- Prove migration restore/forward-fix procedure on a staging copy.
- Load-test 5,000-row import/selection/campaign screens and concurrent check-in/matching transitions.
- Verify event-day phone/browser/network behavior.
- Review Vercel/Supabase/Stripe logs and retention access.
- Complete the [operations runbook](./operations-runbook.md) with real owner/contact/escalation values.

## Provider-independent feature status

| Area | Implemented foundation | Still required before real operation |
| --- | --- | --- |
| Payment | Test Checkout, verified test webhook, idempotent paid transition | Capacity policy, live activation, refunds, reconciliation |
| Import | 5,000-row preview/review, trusted-ID plan invariant, count-checked immutable atomic commit | Atomic preview persistence, cleanup reporting, real-data staging exercise |
| Segmentation | Typed snapshots, overrides, fail-closed channel policy | Business approval and full-data performance test |
| Outbound | Templates, previews, Outbox, audit, DRY_RUN only; hash-only event/person-bound invitation attribution | Invitation issuance UI, approved secure raw-link distribution, provider, compliance, rate limits, provider webhooks, controlled live test |
| Check-in | Hash-only token, atomic audited check-in, manual fallback | Phone/browser staging test, event-day procedures, token distribution |
| Matching | Hash-only token, activation, private likes, unique mutual matches | Audience/preference rules, participant consent/copy, secure distribution, notification policy |
| CRM | Notes, tags, follow-ups, suppression audit, bounded privacy-limited campaign/invitation/Outbox and mutual-match history | Permissions policy, retention, multi-operator audit model, realistic-data staging review |
| Analytics/exports | Live SQL metrics, capacity/revenue breakdowns, protected safe CSV exports | Hosted query-plan review, realistic data validation, browser/5,000-row download test |
| Observability | Redaction/logger helper and basic response headers | Adoption at every log site, monitoring backend, CSP, alerts |

## Required manual staging gate

After applying reviewed migrations to a staging project with invented data:

1. Run payment registration through Stripe test Checkout and verified webhook.
2. Exercise import conflict, cleanup, full 5,000-row navigation and retry paths.
3. Validate segment and campaign counts; confirm all DRY_RUN attempts have `provider_called=false`. Exercise invitation issue/revoke and valid, wrong-person, wrong-event, expired and revoked attribution with invented data; confirm invalid tokens remain unattributed.
4. Run paid token issue, valid/duplicate/wrong-event/unpaid check-in and manual fallback.
5. Run one-sided and mutual matching privacy tests, including concurrent reverse likes.
6. Exercise CRM suppression, reactivation, notes, tags and terminal task transitions; verify 200-row truncation notices and that communication/match history exposes no destination, body, token hash or one-sided like data.
7. Compare analytics counts against direct read-only SQL and download each protected export, including a 5,000-row fixture.
8. Verify admin authorization on every new server action and direct route.
9. Inspect rendered pages, network payloads and logs for secrets/PII/one-sided data.
10. Run backup/restore rehearsal and migration invariant checks, then record exact evidence and unresolved defects.

Production acceptance begins only after this staging gate passes and every P0 blocker has an approved implementation.
