# Invitation attribution

## Current scope

This foundation can trace a qualifying public registration to an eligible campaign recipient without storing the raw invitation bearer token. It does not send an invitation and does not provide an admin issuance UI, bulk link generation, link shortening or delivery-status tracking.

## Token and database boundary

- The raw token is `mi_` followed by 43 base64url characters generated from 32 random bytes.
- PostgreSQL stores only the SHA-256 hash; the raw value is never recoverable from the database.
- A token is immutably bound to one campaign, campaign recipient and event. The campaign recipient identifies the intended canonical person.
- Expiry is fixed at issuance, must be in the future and no later than both the event start and 180 days from issuance.
- The only supported mutation is an audited active-to-revoked transition. Delete and identity-field changes are rejected.
- The table has forced RLS and no public-role grants; the service role is the only application role granted table and RPC access.

Issuance requires an eligible/allowed recipient, active resolved person, opted-in reachable destination with unambiguous current ownership, non-cancelled/non-failed campaign and future published event. An exact retry with the same request ID and inputs is idempotent; conflicting reuse fails closed. Issuance and revocation append outbound audit entries without the raw token.

## Checkout attribution

The public event URL may carry `?invite=<raw token>` and preserves a syntactically valid token across a checkout error redirect. Registration creation is atomic in PostgreSQL.

`source = 'campaign_invite'` and the campaign-recipient/token foreign keys are recorded only when the hash identifies a token that is:

- active and unexpired;
- bound to the checkout event;
- bound through the recipient to the canonical person resolved from the checkout identity;
- attached to an eligible/allowed recipient and a campaign that is not cancelled or failed.

A missing, malformed, expired, revoked, wrong-event or wrong-person/forwarded token does not block a legitimate purchase. The registration is created as ordinary `source = 'event_page'` with no invitation attribution. Database constraints and triggers reject forged or later-mutated attribution.

Multiple checkout attempts are not collapsed into one registration because no one-ticket-per-person business rule has been approved. Each attributed attempt remains traceable, but attribution is possible only for the intended canonical person.

## Security and meaning

The complete invitation URL is a bearer credential. Never include it in structured logs, analytics, screenshots, support tickets, chat or retained message previews. The shared structured-redaction helper recognizes the exact `mi_` token format, but production still requires a platform-access-log and application-log audit because query strings may be recorded before application redaction.

Invitation attribution means only that checkout presented a current intended-recipient token. It is not evidence that a provider sent or delivered a message, that the recipient opened it, or that Stripe confirmed payment. Payment state remains controlled exclusively by the verified Stripe webhook.

## Staging acceptance

After deploying the migration, use invented recipients and verify:

1. exact-replay issuance returns the original token record and conflicting request reuse fails;
2. only the hash is stored and public roles cannot read the table or execute its RPCs;
3. a valid token for its intended person and event creates a `campaign_invite` pending registration and audit entry;
4. the same token used by another resolved person or event creates an unattributed `event_page` registration;
5. revoked, expired and malformed tokens also create ordinary unattributed registrations;
6. forged attribution and immutable-token-field updates fail;
7. raw tokens are absent from application logs, platform logs retained for the test, analytics and admin history;
8. the protected person detail shows only invitation state and attributed registration linkage, not raw hashes, destinations or message bodies.

Do not use real participant links until an approved operator UI, canonical application URL, secure distribution channel, retention/access-log policy and incident procedure are in place.
