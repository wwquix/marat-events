# Marat Events — Canonical Roadmap

This file is the execution order for the project. Do not skip phases unless the scope is explicitly changed.

## Product end state

Marat Events should automate the event funnel from the existing people database through invitations, registration/payment, event check-in, post-event likes and mutual matches, and final reporting/follow-up. Profile discovery itself remains a human/assistant workflow; the product starts from the collected people data.

## Non-negotiable engineering rules

- PostgreSQL/Supabase is the system of record. Sheets or exports may mirror/report data but are never authoritative.
- Payment is confirmed only by verified Stripe webhooks. Redirects never prove payment.
- Payment/webhook handling must remain idempotent.
- Privileged Supabase and Stripe secrets remain server-only and never use `NEXT_PUBLIC_`.
- Staging/test never uses Stripe live credentials.
- Store timestamps in UTC; use `America/New_York` for event/business presentation and business-hour rules.
- Identity is not auto-merged by name. Ambiguous identity conflicts require explicit human review.
- Before automated outbound messaging is enabled, sending must go through deterministic policy checks, an Outbox, AuditLog, DRY_RUN support, consent/channel checks, and idempotent processing. LLM output must not directly send messages or mutate business state.
- Every production-facing change requires tests, CI, staging verification, and rollback-safe database migrations.

---

## Phase 0 — Payment core — COMPLETE

Goal: a guest can pay for a published event and the system can prove the payment safely.

Completed:
- public server-rendered event page;
- Stripe-hosted Checkout in test mode;
- pending registration before Checkout;
- verified Stripe webhook;
- conditional `pending -> paid` transition;
- `paid_at`, Checkout Session ID and PaymentIntent tracking;
- duplicate webhook safety;
- staging deployment and real test payment.

Gate: complete.

---

## Phase 1 — Registration core + basic admin — COMPLETE

Goal: turn the payment demo into a usable event-registration system for Marat.

### 1.1 Registration model — COMPLETE
- central `people` table;
- per-event `ticket_types`;
- `person_id`, `ticket_type_id`, age and source on registrations;
- full registration form;
- server-authoritative event/ticket/gender/price validation;
- Men/Women ticket segmentation;
- real staging E2E payment;
- negative gender test confirmed before Stripe with zero DB mutation.

### 1.2 Identity/data-integrity hardening — COMPLETE
- normalized email lookup/storage;
- existing people reused without unauthenticated overwrite of trusted central identity fields;
- registration-time name/email/phone/gender/age snapshots preserved separately;
- concurrent duplicate-email creation handled safely;
- casing, duplicate identity, concurrency and overwrite-attempt tests added;
- staging E2E verified central-person fingerprint remains unchanged during overwrite attempt.

### 1.3 Admin authentication — COMPLETE
- private admin sign-in;
- protected `/admin` routes and server actions;
- scrypt password hash;
- signed bounded HttpOnly session cookie;
- login/logout staging E2E completed.

### 1.4 Event and ticket administration — COMPLETE
- create/edit/publish/hide events;
- create/edit/hide/sell-out ticket types;
- configure gender/audience, price, currency, capacity and event metadata;
- prevent invalid destructive edits after paid registrations exist;
- staging admin-created event with Men/Women tickets verified publicly.

### 1.5 Attendee administration — COMPLETE
- event attendee list;
- paid/pending status;
- person and registration details;
- ticket/gender/source filters;
- search by operational identity fields;
- central person vs registration snapshot visibility;
- filter regression fixed and staging-verified.

### 1.6 CSV export — COMPLETE
- protected server-generated attendee export;
- deterministic columns and UTC timestamps;
- current attendee filters/search preserved in export;
- export pagination beyond the UI display cap;
- UTF-8 BOM and CSV formula-injection neutralization;
- staging verified with 8 total and 5 paid rows.

### 1.7 Phase 1 hardening and E2E gate — COMPLETE
- admin authorization tests;
- event/ticket mutation policy tests;
- attendee/CSV tests;
- Phase 0 verified webhook invariants re-audited;
- secrets scan and RLS/no-public-policy audit;
- staging E2E completed from admin-created event -> public registration -> Stripe test payment -> verified webhook -> paid attendee record.

Gate to Phase 2: **passed**. Marat can create an event, configure tickets, receive a real test registration/payment, and see/export the attendee from the admin UI without editing the database manually.

---

## Phase 2 — Audience database, import and invitations — FOUNDATION IMPLEMENTED, GATE OPEN

Goal: load the existing ~600-person audience and manage invitations safely.

### 2.1 Audience schema — COMPLETE
- person profile/source metadata needed for event operations;
- optional primary email so social-only audience records are valid people;
- contact channels separate from registration snapshots;
- consent/contactability fields per channel;
- person-level suppression state;
- import provenance and timestamps;
- identity-conflict / human-review state;
- RLS with no public policies for new audience tables.

### 2.2 Import pipeline — FOUNDATION IMPLEMENTED, HARDENING OPEN
- CSV/Sheets-friendly import format — complete;
- validation preview before commit — complete and staging-verified;
- normalized email/phone/Instagram/LinkedIn handling — complete;
- deterministic dedupe on trusted identifiers, never by name alone — complete for preview and commit;
- explicit review resolution to reuse, create or exclude — complete;
- complete 5,000-row review UI and hosted 1,000-row API-cap handling — complete;
- atomic, retry-safe PostgreSQL commit with current-state and batch-wide planned-ownership revalidation — complete;
- committed-batch row-count equality, immutable history and shared review/commit lock order — complete;
- atomic preview persistence and explicit cleanup-failure reporting — pending;
- staging E2E verification of review resolution and commit — pending after migration deployment;
- operational validation with the full real-audience import remains pending.

### 2.3 Segmentation and invite targeting — FOUNDATION IMPLEMENTED
- typed audience segments and event-scoped criteria snapshots;
- deterministic eligible/ineligible reason codes;
- explicit include/exclude overrides that cannot bypass suppression or required-channel safety;
- shared service-role-only SQL evaluator for selection and campaign preview;
- source/import/prior-registration/contact criteria;
- staging full-data performance and product acceptance — pending.

### 2.4 Safe outbound architecture — PROVIDER-DISABLED FOUNDATION IMPLEMENTED
- deterministic Policy Engine with live suppression, identity, consent, contactability and ownership checks;
- immutable template versions and deterministic rendering;
- durable Outbox, immutable delivery attempts and audit history;
- database and application DRY_RUN/disabled enforcement with `provider_called=false`;
- idempotency keys, claim leases, bounded attempts and concurrent-worker-safe claiming;
- America/New_York sending-window rules;
- LLM separated from send/state mutation;
- no real provider adapter, SDK, credential or delivery webhook.

### 2.5 Invitation delivery — ATTRIBUTION FOUNDATION ONLY
- opaque `mi_` tracked-link tokens with hash-only persistence — implemented;
- immutable event/campaign-recipient/intended-person binding, expiry and audited revocation — implemented;
- valid active intended-person checkout attribution to `campaign_invite`, with invalid/forwarded tokens falling back to ordinary `event_page` — implemented;
- operator issuance/revocation UI and approved secure raw-link distribution — pending;
- connect the approved provider/channel(s) — pending;
- sent/delivered/failed/opted-out statuses where provider data supports them — pending;
- STOP/unsubscribe handling where applicable — pending.

### 2.6 Phase 2 E2E gate — PENDING
- import a staging sample and then the real audience after review;
- select a segment;
- DRY_RUN shows exactly who would be contacted and why;
- controlled staging/approved live test;
- registration source traces back to a valid invite/campaign without misattributing a forwarded token.

Gate to Phase 3: the audience can be imported, deduplicated/reviewed, segmented and invited with consent, auditability and deterministic state.

---

## Phase 3 — QR tickets and event check-in — FOUNDATION IMPLEMENTED, GATE OPEN

Goal: know who actually attended.

### 3.1 Ticket/check-in identity — FOUNDATION IMPLEMENTED
- secure opaque, hash-only check-in token per eligible paid registration;
- no sensitive personal/payment data encoded directly in the QR;
- issue/reissue, expiry, revocation and invalid-state handling.

### 3.2 Check-in UI — FOUNDATION IMPLEMENTED
- protected event check-in page and public bearer-token ticket page;
- valid / already checked in / wrong-event / revoked / expired / unpaid feedback;
- manual token input and attendee search fallback;
- check-in timestamp and operator audit trail;
- camera scanning and real-phone/browser verification — pending.

### 3.3 Attendance state — FOUNDATION IMPLEMENTED
- checked-in state/history;
- prevent accidental duplicate check-ins while keeping audit history;
- event attendance counts.

### 3.4 Phase 3 E2E gate — PENDING
- paid registration -> QR -> scan -> attendee becomes checked in;
- duplicate scan is safe;
- unpaid/invalid token cannot check in;
- manual fallback works.

Gate to Phase 4: check-in can be operated reliably from a phone at a real event.

---

## Phase 4 — Likes and mutual matches — PRIVACY FOUNDATION IMPLEMENTED, GATE OPEN

Goal: automate the core post-event dating-event outcome without leaking one-sided interest.

### 4.1 Participant access — FOUNDATION IMPLEMENTED
- separate secure hash-only post-event token tied to a paid, checked-in participant;
- expiration, reissue and revocation rules;
- explicit event-scoped participant profile activation;
- no broad public attendee directory;
- approved secure token distribution — pending.

### 4.2 Like flow — PARTIAL FOUNDATION
- same-event active paid+checked-in candidate enforcement — complete;
- submit repeated likes idempotently — complete;
- prevent self-like and cross-event like — complete;
- preserve privacy of one-sided identities and counts — complete;
- eligible opposite/target audience and preference policy — pending product decision and implementation.

### 4.3 Match engine — FOUNDATION IMPLEMENTED
- deterministic mutual-like calculation;
- unique match records;
- race-safe/idempotent creation;
- only mutual matches are releasable to participants.

### 4.4 Match delivery — PARTIAL FOUNDATION
- participant results page exposes only the current limited mutual profile fields;
- real notification channel and audited notification delivery — pending;
- participant contact release policy — not approved and not implemented.

### 4.5 Phase 4 E2E gate — PENDING
- two checked-in test participants like each other;
- one-sided likes stay private;
- one mutual match is created exactly once;
- both participants receive/view only approved mutual-match information.

Gate to Phase 5: full event lifecycle works from payment through mutual match.

---

## Phase 5 — Analytics, follow-up and operational CRM — FOUNDATION IMPLEMENTED, GATE OPEN

Goal: make the system useful after each event and across many events.

### 5.1 Funnel analytics — FOUNDATION IMPLEMENTED
- audience selection, campaigns/outbox, registered, paid, checked-in, active matching, liked and matched counts;
- distinct-person metrics where applicable;
- conversion context by ticket, source and campaign;
- paid revenue plus remaining/oversold capacity signals;
- operational counts derived live from service-role-only SQL, not mutable counters or spreadsheets;
- explicit warning when an audience evaluation exceeds the 5,000-row bound;
- hosted query-plan/performance verification with realistic data — pending.

### 5.2 Event summary — FOUNDATION IMPLEMENTED
- protected per-event operational dashboard;
- attendance, campaign/outbox and matching summary;
- ticket/source/campaign breakdowns and capacity exceptions;
- private/no-store CSV exports for audience, attendees, campaign results, event summary and mutual matches;
- deterministic paging through 5,000 rows and spreadsheet-formula neutralization;
- browser/large-file staging verification — pending.

### 5.3 Follow-up/CRM layer — FOUNDATION IMPLEMENTED
- canonical-person operational index and detail history;
- registration/payment/check-in visibility;
- bounded follow-up tasks with terminal status enforcement;
- source attribution, tags and bounded notes;
- immutable suppression/reactivation history;
- bounded campaign, invitation, attributed-registration and Outbox history on the canonical person detail;
- mutual-match history without one-sided like queries, identities or counts;
- production permissions, retention and multi-operator audit model — pending.

### 5.4 Sheets/report mirror — EXPORT FOUNDATION ONLY
- protected CSV reporting exports — implemented;
- optional Sheets sync for the team's workflow — not connected;
- any future sync must remain one-way/controlled so SQL is authoritative;
- future sync failures must be visible and retryable.

### 5.5 AI assistance (only after deterministic workflow exists)
- read-only summaries, classification suggestions and report drafting;
- versioned business knowledge/templates;
- no LLM-direct sending, payment mutation, matching mutation or silent identity merge;
- deterministic rules remain authoritative for state transitions.

Gate to Phase 6: Marat can operate multiple events and understand the complete funnel without reconstructing it manually from separate systems.

---

## Phase 6 — Production hardening and launch — STARTED, PRODUCTION BLOCKED

Goal: move from staging/test product to a safe production service owned by Marat's business.

### 6.1 Production environment
- separate production Supabase/Vercel configuration;
- Marat-owned Stripe production account/credentials;
- real domain and email/sending-domain configuration as applicable;
- test and production data/keys strictly separated.

Current foundation classifies staging server variables and keeps production fail closed. Canonical URL policy and production/provider variable contracts remain intentionally undefined until implementation approval.

### 6.2 Payment and capacity correctness
- transactional/concurrency-safe capacity enforcement before real ticket sales;
- cancellation/refund state model;
- Stripe refund webhook handling where refunds are enabled;
- reconciliation tooling for payment inconsistencies.

### 6.3 Security/privacy
- production RLS/authorization review;
- rate limits/abuse controls on public actions;
- conservative response headers — implemented;
- Content Security Policy and complete input limits — pending;
- secret rotation procedure;
- data retention/deletion policy;
- export/privacy process appropriate to stored personal data.

### 6.4 Reliability
- structured redaction/logger foundation — implemented but not adopted at every log site;
- error/uptime monitoring;
- backup schedule;
- tested restore procedure;
- migration rollback/recovery plan;
- webhook/outbox retry monitoring;
- initial incident/restore runbook — documented; owners/platform procedures still pending.

### 6.5 Production acceptance test
- one controlled real-money test with Marat's production Stripe account;
- verify payment, attendee, refund/cancel path if enabled, check-in and post-event workflow;
- verify reporting and audit trail;
- verify backup/restore drill.

Gate: production launch approved only after the acceptance checklist passes.

---

## Phase 7 — First real event and project completion

Goal: prove the system in normal operation and remove temporary/manual scaffolding.

- operate one real event end-to-end;
- record every operational issue discovered;
- fix P0/P1 launch issues;
- remove demo-only data/configuration from production paths;
- finalize operator documentation;
- finalize backup/incident procedures;
- confirm no routine step requires manual SQL edits;
- confirm the complete funnel is reportable from the database.

## Definition of project complete

The project is complete when a normal event can run through:

`people database -> eligible audience -> invitation -> registration -> verified payment -> check-in -> likes -> mutual matches -> follow-up/reporting`

with admin operation through the product, SQL as the source of truth, auditable outbound actions, no manual database edits in the normal flow, and production security/reliability checks passed.
