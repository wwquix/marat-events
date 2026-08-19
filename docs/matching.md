# Matching foundation

## Current scope

The matching foundation provides private, event-scoped participant access and mutual-like calculation. It does not send match notifications and it is not the complete Phase 4 product.

## Access and activation

- Matching tokens use a separate `mt_` namespace and 32 random bytes.
- Only SHA-256 token hashes are persisted.
- One registration may have only one active matching token; reissue/revocation is supported.
- Default expiry is two days after event start.
- Token issue and every participant RPC recheck `paid` plus an active event check-in.
- A participant must explicitly activate a profile before becoming visible.
- Display name and optional bio are event-scoped profile data, not a public attendee directory.

The `/match/[token]` URL is a bearer credential. Do not log, share or place it in analytics. Distribution of that link is not implemented; it requires an approved secure channel and operations policy.

## Likes, matches and privacy

- A like cannot target the same profile, another event or an inactive/ineligible profile.
- Repeating the same like is idempotent.
- A mutual match uses a deterministic canonical pair and a unique database record.
- Concurrent reverse likes produce at most one match.
- Participant state shows `likedByMe` for the participant's own outgoing actions.
- It never exposes inbound one-sided identities or counts.
- Only mutual matches expose the other active participant's currently limited display name and bio fields.

One-sided privacy also applies to admin/product analytics: do not introduce dashboards or notifications that reveal who liked whom without an explicit product/privacy decision.

## Known product gap

The current candidate query includes all other active, paid, checked-in, unexpired-token profiles within the event. It does not implement gender, preference or audience-compatibility rules. That is a blocking product-policy decision before a real event uses matching.

No provider sends matching links or match notifications. No participant contact details are released. A mutual match UI is not permission to expose email or phone.

The protected CRM person detail may show confirmed mutual matches for operational history. It does not query or display one-sided likes, one-sided counts or participant contact details. Each history view is bounded to the newest 200 rows and explicitly reports truncation.

## Staging acceptance test

1. Create paid+checked-in A and B, plus unpaid, unchecked and cross-event controls.
2. Confirm tokens cannot be issued to ineligible registrations.
3. Activate A and verify B remains invisible until B activates.
4. Verify no self-like or cross-event like.
5. Let A like B and verify B sees no inbound identity/count.
6. Let B like A concurrently/repeatedly and verify exactly one mutual match.
7. Verify both sides see only the approved mutual profile fields.
8. Revoke/expire a token and verify access fails closed.
9. Deactivate a profile and verify it is no longer a valid target.
10. Inspect query/API responses for contact fields and one-sided leakage.

Do not use real participant data until audience-compatibility rules, participant copy/consent, token distribution, retention and support procedures are approved.
