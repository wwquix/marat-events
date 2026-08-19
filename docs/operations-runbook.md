# Operations runbook

## Scope

This runbook covers the current test/staging foundation. Replace placeholders for incident owner, escalation channel and platform owners before production. Never paste secrets, raw webhook bodies, participant bearer URLs or contact data into logs, tickets or chat.

| Responsibility | Assigned owner/value |
| --- | --- |
| Incident commander | TBD before production |
| Engineering escalation | TBD before production |
| Marat business/operator contact | TBD before production |
| Vercel owner | TBD before production |
| Supabase/database owner | TBD before production |
| Stripe account owner | Marat's business; named operator TBD |
| Backup/restore owner | TBD before production |
| Incident channel and private evidence location | TBD before production |
| Recovery point/time objectives | TBD before production |

Production launch is blocked until every row has a real owner/value and the team has exercised the runbook.

## First response

1. Record UTC start time, environment, deployment commit and affected workflow.
2. Confirm whether the environment is local, preview, staging or production. Production is not currently supported.
3. Stop only the affected operation through an existing safe control: hide an event/ticket, stop queueing, leave outbound disabled, revoke a leaked token or pause operator activity.
4. Preserve audit rows and provider event IDs. Do not delete or rewrite evidence.
5. Check recent deploy/migration/config changes.
6. Use stable error codes and record counts/IDs only where permitted; redact contact and credential values.
7. Escalate if payment correctness, identity ownership, one-sided matching privacy or secret exposure may be affected.

## Environment or secret incident

- Treat any `NEXT_PUBLIC_` secret, committed secret, exposed terminal output or copied bearer token as compromised.
- Rotate the affected Supabase, Stripe or admin credential in its owning system.
- Update only the intended Vercel environment scopes and redeploy.
- Confirm preview/staging never references production Stripe credentials or production data.
- Revoke exposed invitation, check-in or matching tokens and issue replacements only through an approved operator flow.
- Review access logs and audit history for the exposure window.
- Do not print the old/new values while verifying rotation.

## Checkout or webhook incident

Never mark a registration paid because the browser reached `/success`.

1. Confirm Stripe mode and environment; stop if any live-mode material appears in staging.
2. Locate the verified Stripe event and Checkout Session in Stripe using authorized operator access.
3. Compare registration ID, event ID, ticket ID, Session ID, amount and currency with PostgreSQL.
4. Check webhook signature/configuration and application response without copying the raw payload into a ticket.
5. Fix the deterministic cause, then use Stripe's supported retry/redelivery mechanism.
6. Confirm the idempotent transition preserves the original `paid_at` on duplicate delivery.
7. If Stripe created a Session but the application failed to store its ID, quarantine the registration and escalate; the reconciliation workflow is not implemented.
8. For capacity ambiguity, stop sales by hiding/selling out the affected ticket until registrations and Stripe payments are reconciled.

## Import incident

- Stop resolving/committing the affected preview.
- Compare batch `row_count` with actual row and review counts using read-only access.
- Check for partial chunks or missing review rows.
- Treat any row-count mismatch as a quarantined preview; the committed transition will fail closed.
- Discard only a confirmed `preview` batch through the protected UI.
- If cleanup, counts or trusted ownership are uncertain, quarantine the batch and preserve it for investigation.
- Retry commit only after resolving the reported identity conflict; committed batches are retry-safe.
- Never merge people by name or edit identity ownership to make an import pass.

See [Audience imports](./imports.md) for the unresolved preview atomicity and cleanup-reporting risks. Review resolution and commit now share the same advisory lock and should serialize.

## Outbox/DRY_RUN incident

No provider call should occur. If evidence suggests one did, treat it as a P0 secret/code incident.

1. Confirm the campaign delivery mode is `disabled` or `dry_run`.
2. Confirm every attempt has `provider_called=false`.
3. Inspect blocked/retry reason codes, attempt number, `available_at`, lease owner and lease age.
4. A claim lease older than 15 minutes is recovered by the next claim operation; do not hand-edit the lease.
5. Do not update/delete immutable delivery attempts or audit entries.
6. Fix live suppression/consent/contactability/ownership state at its authoritative source, then create a new approved campaign if needed. A blocked terminal row is not silently reopened.
7. DRY_RUN completion is not evidence of delivery.

## Invitation attribution incident

- Treat a raw `mi_` URL as a bearer credential. Remove it from tickets/chat where possible, review platform access logs and revoke the token through the audited service operation.
- A wrong-person, wrong-event, malformed, expired or revoked token must produce an ordinary `event_page` registration with no campaign recipient/token linkage. If it does not, stop checkout attribution and escalate as a privacy incident.
- Preserve invitation and attribution audit rows. Do not delete, rewrite or manually attach a registration to a campaign.
- Attribution does not prove a message was sent, received or opened, and it does not prove payment.
- There is no operator issuance/revocation UI or provider delivery yet. Do not generate or distribute real participant links through ad hoc scripts.

## Check-in incident

- Wrong event/unpaid/revoked/expired tokens must remain rejected.
- Revoke and reissue a leaked token.
- For duplicate scans, preserve the original active check-in and the attempt audit.
- Use the protected manual search fallback when scanning is unavailable.
- Do not use direct SQL to improvise offline check-in. Record an approved offline roster and reconcile only through a designed audited workflow.
- Escalate a mistaken check-in; do not delete audit history.

## Matching/privacy incident

- Revoke exposed participant tokens immediately.
- Disable operator issuance/distribution if one-sided interest may have leaked.
- Preserve likes/matches/audit state; do not notify participants from raw database queries.
- Confirm participant responses contain only own outgoing state and mutual matches.
- Treat any inbound one-sided identity/count exposure as a privacy incident.
- The current candidate policy is incomplete; do not use matching with real participants until audience/preference rules are approved.

## Analytics or export incident

- Treat PostgreSQL as authoritative; never repair a mismatch by editing an export.
- Compare dashboard metrics with narrowly scoped read-only counts from the same deployment.
- Confirm distinct-person versus registration/profile counts before calling a discrepancy a defect.
- Treat `audience_limit_exceeded` as incomplete evaluation requiring investigation, not as zero or a final count.
- Campaign/outbox state is operational DRY_RUN state and is not evidence of provider delivery.
- Confirm the event scope and admin authorization on every export route.
- Quarantine a CSV that contains unexpected PII, a spreadsheet formula, more than 5,000 rows or another event's data, and escalate as a privacy incident.

## Database or migration incident

1. Stop affected writes and capture the migration/deployment commit.
2. Do not edit an applied migration or run destructive rollback SQL ad hoc.
3. Determine whether a forward fix is safe; otherwise restore an isolated copy first.
4. Validate RLS, grants, service-role RPC execution, row counts, foreign keys, unique constraints and critical state transitions.
5. Re-run automated gates against the exact commit.
6. Resume staged operation only after the affected workflow passes a manual test.

## Backup and restore drill

At the approved cadence:

1. Confirm backup/PITR coverage, retention, region and owner.
2. Restore into an isolated non-production Supabase project.
3. Configure fresh isolated credentials; never point a preview at production.
4. Verify migration history and representative counts without exporting PII.
5. Test admin read access, payment invariants, import batch integrity, outbox audit, check-in and matching uniqueness.
6. Confirm restored credentials/connections work and old credentials are not accidentally reused.
7. Record recovery-point age, recovery duration, checks run and result.
8. Destroy the isolated copy using the approved data-handling process after evidence is retained safely.

## Deployment checklist

Before staging deployment:

- review all migration SQL and generated diff;
- confirm Node.js 22+;
- run lint, typecheck, all tests and build;
- verify environment variable names/scopes without printing values;
- confirm Stripe keys are test-mode and outbound has no provider;
- confirm backup/restore readiness for the target;
- apply migrations through the normal reviewed process;
- run the affected manual staging flow;
- inspect logs and audit rows for sensitive-data leakage.

## Incident closure

Record root cause, impact, exact data/state correction, credential rotations, evidence, tests, monitoring gap and owner/date for follow-up. A successful retry alone is not closure.
