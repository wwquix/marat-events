# Check-in foundation

## Security model

A check-in link is a bearer credential. Anyone who obtains the active token can present its QR until the token expires or is revoked.

- Tokens are 32 random bytes encoded as base64url.
- PostgreSQL stores only the SHA-256 hash.
- One registration may have only one active token.
- Reissuing a token revokes the previous active token.
- Default expiry is two days after the event start unless an earlier/later valid expiry is explicitly supplied.
- QR data is `marat-checkin:<token>` and contains no name, contact, payment or raw database identifier.
- The public ticket page does not query or render attendee contact/payment details.

Do not place tokens in support tickets, analytics events, screenshots, chat messages or structured logs. Review platform access logs because the public ticket URL itself contains the token in its path.

## Eligibility and transitions

Token issue and check-in require a registration whose payment status is `paid`. Token processing validates, in a stable fail-closed order:

- token exists;
- event matches the operator's selected event;
- token is active;
- token is not expired;
- registration is still paid;
- registration is not already checked in.

The token and manual check-in RPCs serialize the registration transition. A duplicate scan returns `already_checked_in` and preserves the original active check-in. Every attempt is auditable, including invalid, wrong-event, revoked, expired, unpaid and duplicate outcomes.

## Operator flow

The protected event check-in page supports:

- issuing or reissuing a token for an eligible registration;
- pasting a raw token, QR namespace value or ticket URL;
- manual attendee search and check-in fallback;
- revoking an active token;
- paged operation over event registrations.

There is no camera-scanner package in this foundation. The manual input is the current scanner fallback and must be tested on the intended event phone/browser.

## Staging acceptance test

1. Create separate paid and pending test registrations.
2. Issue a token for the paid registration and confirm pending issue is rejected.
3. Open the ticket page and inspect the QR payload; confirm no PII or payment fields.
4. Scan/paste it for the correct event and confirm one check-in.
5. Repeat it and confirm `already_checked_in` without a second active check-in.
6. Present it on a different event and confirm `wrong_event`.
7. Reissue a fresh token and confirm the prior token is revoked.
8. Test expiry and manual search fallback.
9. Confirm attempt history and operator identity.
10. Verify the complete workflow on the actual event phone and network conditions.

## Incident response

For a leaked token, revoke it and issue a replacement. For a mistaken check-in, preserve the attempt history and escalate; do not delete audit rows. If the event network is unavailable, use an approved manual roster procedure and reconcile through an explicitly designed admin workflow later—do not invent direct SQL updates during the event.
