# Architecture

## Status and scope

Marat Events is a Vercel-compatible Next.js App Router application backed by Supabase/PostgreSQL. PostgreSQL is the system of record. This branch contains provider-independent foundations for audience operations, check-in, matching, CRM and outbound dry runs, but those foundations are not a production-launch claim.

The current payment path is deliberately test-mode only. Real outbound providers are not connected. New migrations and operator flows require staging deployment and manual verification before they may be treated as operational.

## Runtime boundaries

```text
Browser
  -> public Next.js routes and protected admin routes
  -> server components, route handlers and server actions
  -> server-only Supabase client
  -> PostgreSQL tables and service-role-only RPCs

Public checkout route
  -> Stripe Checkout test mode

Stripe test webhook
  -> raw-body signature verification
  -> idempotent PostgreSQL payment transition

Campaign dispatcher
  -> disabled or DRY_RUN adapter only
  -> no provider network call
```

Browser code never receives the Supabase secret key, Stripe secret key, Stripe webhook secret, admin password hash or admin session secret. Tables in the exposed `public` schema use explicit RLS, public roles are revoked on base and foundation tables, and the application performs privileged work through server-only code and narrowly granted service-role RPCs.

## Main domains

### Events, registration and payment

- `events` and `ticket_types` define the server-authoritative offer.
- `people` is the canonical identity record; `registrations` keeps event-time identity and commercial snapshots.
- PostgreSQL enforces known event status, ticket/event correlation and unique non-null Stripe PaymentIntent ownership.
- Checkout creates a `pending` registration before creating a Stripe Checkout Session.
- Only a verified Stripe webhook can move a matching registration from `pending` to `paid`.
- `/success` is informational and is never proof of payment.

The capacity check still counts already-paid registrations before Checkout. It is not a reservation and is not safe against concurrent purchases. See [Production readiness](./production-readiness.md).

### Canonical identity and audience import

- Registration-time identity resolution and audience-import commit use the same transaction-scoped advisory-lock namespace.
- Trusted identifiers are normalized email, phone, Instagram and LinkedIn values. Name alone is never an identity merge key.
- Ambiguous ownership fails closed and requires explicit admin review.
- Imported contacts start with unknown consent and contactability. Importing data never grants permission to contact someone.

The preview and review UI supports up to 5,000 rows, with deterministic range reads that remain complete when the hosted Supabase API caps a response at 1,000 rows. The SQL commit is atomic, retry-safe after completion and revalidates current identifier ownership. A transition to `committed` fails unless actual rows equal the batch's recorded row count and every row is in a final valid state. Committed batches, preview source data and resolved reviews are immutable. Review resolution and commit take the same global advisory lock before row/batch locks.

### Segmentation

- `audience_segments` stores typed criteria.
- `event_audience_selections` snapshots segment criteria for an event.
- `event_audience_selection_overrides` stores explicit include/exclude decisions.
- The service-role-only `preview_event_audience_selection` RPC is the single authoritative campaign-selection evaluator.

Manual inclusion can override ordinary criteria but cannot override suppression, unresolved identity, missing required channels, opt-out, unknown consent or unreachable contact state when a delivery channel is required.

### Campaigns and outbound work

Campaign preview snapshots the exact selection, template version, destination and policy result. Queueing rechecks live ownership and contact policy. Claiming uses deterministic due-order processing, `FOR UPDATE SKIP LOCKED`, a bounded attempt count and expiring leases. Each claim is evaluated again against live suppression, identity, consent, contactability and destination ownership before dispatch.

Only `disabled` and `dry_run` delivery modes exist. The database constrains delivery attempts to `provider_called = false`; no real provider adapter exists. See [Outbound architecture](./outbound.md).

### Invitation attribution

The invitation-attribution foundation uses an opaque `mi_` bearer token with 32 random bytes and stores only its SHA-256 hash. Each token is immutably bound through a campaign recipient to one campaign, event and intended canonical person, has a fixed expiry, and may move only from active to audited revoked state. Issuance and revocation are service-role-only operations; no admin issuance UI or provider delivery exists yet.

Public checkout accepts the token only as attribution evidence. The atomic registration RPC records `source = 'campaign_invite'` only while the token is active, unexpired, for the current event and intended resolved person, and its campaign/recipient remain valid. A malformed, forwarded-to-another-person, wrong-event, expired or revoked token proceeds as an ordinary unattributed `event_page` registration. It neither blocks a legitimate purchase nor proves delivery or payment. See [Invitation attribution](./invitations.md).

### Check-in

- A paid registration may receive one active opaque check-in bearer token.
- Only a SHA-256 token hash is stored.
- The QR namespace is `marat-checkin:<token>` and contains no attendee, payment or database-record details.
- Atomic RPCs implement issue/reissue, token check-in, manual check-in and revocation.
- Check-in attempts are preserved for audit; duplicate check-in is safe.

See [Check-in operations](./check-in.md).

### Matching

- Matching uses a separate opaque, hash-only participant token.
- Paid and checked-in eligibility is rechecked by each privileged RPC.
- A participant must explicitly activate an event-scoped profile before appearing to others.
- Likes are event-scoped and idempotent; mutual matches use a canonical pair and unique constraint.
- Participant state exposes the participant's own outgoing-like state and mutual matches with limited display name/bio fields, never the identity or count of people who expressed one-sided interest.

The current candidate set is all other active, eligible profiles in the same event. Product rules for gender/audience compatibility are not implemented yet. See [Matching foundation](./matching.md).

### CRM and analytics

The CRM foundation adds bounded notes, tags, follow-up tasks and immutable suppression-history events around canonical people. Suppression changes and terminal task transitions go through audited service-role RPCs. The protected person detail also links a bounded, deterministically ordered history of campaign recipients, invitation state, attributed registrations, current Outbox state and confirmed mutual matches. It omits token hashes, contact destinations, rendered message bodies and every one-sided like identity or count; matching history reads confirmed `matching_matches`, never `matching_likes`.

Event analytics is computed live by a service-role-only, security-invoker SQL RPC. It reports authoritative audience/campaign/outbox/registration/payment/check-in/matching counts, distinct-person metrics, paid revenue, capacity state and deterministic ticket/source/campaign breakdowns. It warns rather than silently truncating when audience evaluation exceeds 5,000.

Protected event exports cover audience selections, attendees, campaign results, event summary and mutual matches. They use deterministic hosted-cap-safe paging with a 5,000-row ceiling, private/no-store responses, safe filenames and spreadsheet-formula neutralization. Exports are non-authoritative mirrors; campaign/outbox statuses never imply real provider delivery.

## Authentication and authorization

The current admin boundary is one server-configured administrator identity with a scrypt password hash and a signed HttpOnly session cookie. Protected layouts and every privileged server action recheck the admin session. This is adequate for the current staging operator model, not a substitute for production RBAC, per-operator accounts, rate limiting or session-revocation tooling.

## Environment boundaries

Current staging-required server variables are defined in `.env.example`. `lib/config/environment-policy.ts` classifies them without exposing values and rejects live Stripe credentials in staging. Development and tests intentionally remain buildable without provider secrets. Production remains fail closed because canonical URL policy, capacity reservation, live Stripe activation, durable abuse controls and restore proof are not implemented.

No outbound-provider or rate-limit-provider variable names have been invented. Add those variables only with an approved provider integration and update `.env.example`, validation, operations documentation and secret-rotation procedures in the same change.

## Observability boundary

`lib/observability` provides structured records with recursive redaction for credentials, bearer tokens, contact fields, request bodies and error details. It also bounds depth and size. New operational logging should emit stable event codes and safe metadata only.

This helper has not yet replaced every existing log site, and no monitoring/error platform is connected. Production readiness requires a full log-site audit, retention/access policy and alerts without raw contact data, webhook bodies, bearer-token URLs or credentials.

## Time and identifiers

- Persist timestamps in UTC.
- Present event/business time and outbound windows in `America/New_York`.
- Treat invitation, check-in and matching URL tokens as bearer credentials.
- Keep public IDs separate from internal profile IDs where participant-facing state requires it.
- Keep Stripe, database and provider idempotency identifiers stable and unique for their intended operation.

## Change discipline

Database changes are forward migrations. Do not edit an already-applied migration. Apply migrations to staging only after review and backup verification, then exercise the affected workflow with test data. A green build is not staging verification.
