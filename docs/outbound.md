# Outbound architecture

## Current guarantee

Marat Events cannot send a real email, SMS, WhatsApp, Telegram or Instagram message in the current implementation.

- Database delivery mode is constrained to `disabled` or `dry_run`.
- The only adapters are local disabled and DRY_RUN adapters.
- Both return `providerCalled: false`.
- Delivery-attempt rows enforce `provider_called = false`.
- No provider SDK, credential, webhook or network-send implementation exists.

DRY_RUN means the system evaluates, renders, queues, claims and records an outbound message without contacting a provider. It does not prove provider deliverability, domain reputation, link behavior, unsubscribe handling or recipient consent outside the data recorded in PostgreSQL.

## Data flow

1. An admin creates a typed audience segment.
2. The admin snapshots it into an event audience selection with a required channel.
3. The shared `preview_event_audience_selection` SQL evaluator classifies current people.
4. Campaign preview binds an immutable template version and snapshots recipients and policy reasons.
5. Queueing rechecks current suppression, identity, contact, destination and destination ownership.
6. Claiming leases due rows using `FOR UPDATE SKIP LOCKED` and recovers leases older than 15 minutes.
7. The dispatcher re-evaluates live policy and the America/New_York sending window.
8. The disabled/DRY_RUN adapter returns without a network call.
9. The outcome is written to immutable delivery attempts and outbound audit history.

The preview, queue and claim layers intentionally repeat safety checks. A stale preview never authorizes a later delivery.

Tracked invitation-link issuance is a separate, provider-independent foundation; it is not part of DRY_RUN dispatch today. No admin control automatically issues or distributes those links. See [Invitation attribution](./invitations.md).

## Policy precedence

Outbound work fails closed in this order:

1. person suppression;
2. unresolved identity;
3. explicit contact opt-out;
4. unknown consent;
5. wrong or unusable channel/destination;
6. destination owned by multiple people;
7. stale destination snapshot;
8. suppressed, unreachable or unknown contactability;
9. closed sending window.

A closed sending window defers work to the next permitted minute. Safety failures block the row. Manual segment inclusion does not bypass delivery policy.

## Templates

Templates are versioned. Placeholder names must be explicitly declared and match the bounded variable-name grammar. Rendering fails closed for missing, undeclared, duplicated or malformed variables. A campaign keeps the exact template version it previewed; editing a logical template creates a new version rather than silently changing queued content.

Templates are deterministic business content. An LLM may eventually suggest a draft, but it must never dispatch a message or directly mutate campaign/outbox state.

## Tracked invitation links

An approved future delivery may carry an opaque `/events/[slug]?invite=mi_...` bearer URL. The current server helper and service-role-only RPC can issue a hash-only token for an eligible campaign recipient, with exact-request replay protection, fixed expiry and immutable campaign/event/recipient identity. Issuance rechecks the recipient's resolved identity, suppression, consent, contactability, destination ownership, campaign state and future published event. Revocation is audited and idempotent.

This foundation does not include an issuance UI, bulk generation, secure distribution, short-link service or provider send. Raw invitation URLs must not appear in logs, screenshots, analytics, support tickets or message previews retained outside the approved secret-handling boundary. The public checkout attributes only a valid active token for the resolved intended person and event; any invalid or forwarded token becomes an ordinary unattributed checkout. Attribution is not delivery evidence and never proves payment.

## Idempotency and retries

- Template creation and campaign preview accept request IDs for retry safety.
- Each outbox row has a unique idempotency key.
- Claiming is concurrent-worker safe and caps processing attempts at five.
- Attempt recording is idempotent for the same lease and attempt number.
- Delivery attempts and outbound audit entries are immutable.
- Terminal blocked, disabled and DRY_RUN-completed rows are not retried.

Retry scheduling currently models local/deterministic processing only. Provider error taxonomy, provider idempotency semantics, rate limits and provider receipt reconciliation do not exist.

## Enabling a real provider

Do not turn DRY_RUN into a real send by changing a flag. A provider-enablement change requires explicit approval and must include, in one reviewed slice:

- Marat-owned provider account and staging credentials;
- separate staging and production secrets, never `NEXT_PUBLIC_`;
- a provider adapter that preserves the existing policy and outbox boundaries;
- provider-side idempotency and stored provider message IDs;
- timeout, retryable/permanent error classification and rate-limit handling;
- delivery/status webhook verification and idempotent processing where supported;
- STOP/unsubscribe or equivalent channel-compliance handling;
- suppression updates that take effect before subsequent claims;
- safe structured logs, metrics and alerts;
- controlled staging recipients and an emergency kill switch;
- tests proving a policy-blocked row cannot reach the provider;
- secure invitation-link generation/distribution that never persists or logs the raw bearer token;
- operations and secret-rotation updates.

Provider failures must never roll back a confirmed payment. Email or messaging is downstream of payment state.

## Operator checks for DRY_RUN

Before queueing:

- confirm the event, selection and immutable template version;
- review every blocked reason and unexpected destination;
- verify eligible count and the required channel;
- confirm consent is `opted_in`, contactability is `reachable`, identity is resolved and person is active;
- confirm the configured sending window and schedule.

After dispatching a DRY_RUN batch:

- confirm the campaign reaches `dry_run_completed` only when every queued row is terminal;
- confirm all delivery attempts have `provider_called=false`;
- investigate retry-scheduled or blocked rows rather than editing audit records;
- never interpret DRY_RUN completion as a real delivery.
