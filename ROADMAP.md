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

## Phase 2 — Audience database, import and invitations — IN PROGRESS

Goal: load the existing ~600-person audience and manage invitations safely.

### 2.1 Audience schema — IN PROGRESS
- person profile/source metadata needed for event operations;
- optional primary email so social-only audience records are valid people;
- contact channels separate from registration snapshots;
- consent/contactability fields per channel;
- person-level suppression state;
- import provenance and timestamps;
- identity-conflict / human-review state;
- RLS with no public policies for new audience tables.

### 2.2 Import pipeline — NEXT
- CSV/Sheets-friendly import format;
- validation preview before commit;
- normalized email/phone handling;
- deterministic dedupe on trusted identifiers;
- never auto-merge by name alone;
- explicit conflict report for human review;
- repeatable/idempotent imports.

### 2.3 Segmentation and invite targeting
- event audience/segment selection;
- eligible/ineligible reasoning;
- no invite to suppressed/opted-out contacts;
- source and campaign attribution.

### 2.4 Safe outbound architecture
Before any real provider sends messages:
- Policy Engine;
- Outbox;
- AuditLog;
- DRY_RUN mode;
- idempotency keys;
- channel consent checks;
- America/New_York sending-window rules;
- retry/failure state machine;
- LLM separated from send/state mutation.

### 2.5 Invitation delivery
- connect the approved provider/channel(s);
- invitation templates and tracked event links;
- sent/delivered/failed/opted-out statuses where provider data supports them;
- STOP/unsubscribe handling where applicable.

### 2.6 Phase 2 E2E gate
- import a staging sample and then the real audience after review;
- select a segment;
- DRY_RUN shows exactly who would be contacted and why;
- controlled staging/approved live test;
- registration source traces back to invite/campaign.

Gate to Phase 3: the audience can be imported, deduplicated/reviewed, segmented and invited with consent, auditability and deterministic state.

---

## Phase 3 — QR tickets and event check-in

Goal: know who actually attended.

### 3.1 Ticket/check-in identity
- secure opaque check-in token per eligible paid registration;
- no sensitive personal/payment data encoded directly in the QR;
- token revocation/invalid-state handling.

### 3.2 Check-in UI
- mobile-friendly scanner/admin page;
- valid / already checked in / invalid / unpaid feedback;
- manual attendee search fallback;
- check-in timestamp and operator audit trail.

### 3.3 Attendance state
- checked-in state/history;
- prevent accidental duplicate check-ins while keeping audit history;
- event attendance counts.

### 3.4 Phase 3 E2E gate
- paid registration -> QR -> scan -> attendee becomes checked in;
- duplicate scan is safe;
- unpaid/invalid token cannot check in;
- manual fallback works.

Gate to Phase 4: check-in can be operated reliably from a phone at a real event.

---

## Phase 4 — Likes and mutual matches

Goal: automate the core post-event dating-event outcome without leaking one-sided interest.

### 4.1 Participant access
- secure post-event access tied to an eligible checked-in participant;
- expiration/revocation rules;
- no broad public attendee directory.

### 4.2 Like flow
- show only eligible opposite/target audience according to event rules;
- submit/update likes idempotently;
- prevent self-like and cross-event like;
- preserve privacy of one-sided likes.

### 4.3 Match engine
- deterministic mutual-like calculation;
- unique match records;
- race-safe/idempotent creation;
- only mutual matches are releasable to participants.

### 4.4 Match delivery
- participant match results page and/or approved notification channel;
- release only the data explicitly allowed by product policy;
- audit match notifications.

### 4.5 Phase 4 E2E gate
- two checked-in test participants like each other;
- one-sided likes stay private;
- one mutual match is created exactly once;
- both participants receive/view only approved mutual-match information.

Gate to Phase 5: full event lifecycle works from payment through mutual match.

---

## Phase 5 — Analytics, follow-up and operational CRM

Goal: make the system useful after each event and across many events.

### 5.1 Funnel analytics
- audience -> invited -> registered -> paid -> checked in -> liked -> matched;
- conversion by event/ticket/source/campaign;
- gender/audience balance where appropriate;
- operational counts derived from SQL, not spreadsheets.

### 5.2 Event summary
- per-event operational dashboard;
- attendance and match summary;
- exceptions requiring attention;
- exportable report.

### 5.3 Follow-up/CRM layer
- person event history;
- invitation/registration/attendance history;
- follow-up tasks/statuses;
- source attribution;
- notes with explicit permissions/audit where sensitive.

### 5.4 Sheets/report mirror
- optional reporting sync/export for the team's existing workflow;
- one-way or controlled sync so SQL remains authoritative;
- sync failures visible and retryable.

### 5.5 AI assistance (only after deterministic workflow exists)
- read-only summaries, classification suggestions and report drafting;
- versioned business knowledge/templates;
- no LLM-direct sending, payment mutation, matching mutation or silent identity merge;
- deterministic rules remain authoritative for state transitions.

Gate to Phase 6: Marat can operate multiple events and understand the complete funnel without reconstructing it manually from separate systems.

---

## Phase 6 — Production hardening and launch

Goal: move from staging/test product to a safe production service owned by Marat's business.

### 6.1 Production environment
- separate production Supabase/Vercel configuration;
- Marat-owned Stripe production account/credentials;
- real domain and email/sending-domain configuration as applicable;
- test and production data/keys strictly separated.

### 6.2 Payment and capacity correctness
- transactional/concurrency-safe capacity enforcement before real ticket sales;
- cancellation/refund state model;
- Stripe refund webhook handling where refunds are enabled;
- reconciliation tooling for payment inconsistencies.

### 6.3 Security/privacy
- production RLS/authorization review;
- rate limits/abuse controls on public actions;
- security headers and input limits;
- secret rotation procedure;
- data retention/deletion policy;
- export/privacy process appropriate to stored personal data.

### 6.4 Reliability
- structured operational logging without leaking sensitive data;
- error/uptime monitoring;
- backup schedule;
- tested restore procedure;
- migration rollback/recovery plan;
- webhook/outbox retry monitoring;
- incident runbook.

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
