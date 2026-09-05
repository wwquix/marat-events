import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  checkInQrValue,
  fingerprintCheckInTokenHash,
  generateCheckInToken,
  hashCheckInToken,
  isCheckInToken,
  normalizeCheckInToken,
} from "../lib/checkin/token";
import { decideTokenCheckIn } from "../lib/checkin/policy";

const NOW = new Date("2026-08-18T20:00:00.000Z");

test("check-in tokens are opaque, random, and hash-only persistence values", () => {
  const tokens = Array.from({ length: 32 }, () => generateCheckInToken());
  assert.equal(new Set(tokens).size, tokens.length);

  for (const token of tokens) {
    assert.equal(isCheckInToken(token), true);
    assert.equal(token.length, 43);
    const hash = hashCheckInToken(token);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(fingerprintCheckInTokenHash(hash), hash.slice(0, 16));
    assert.equal(hash.includes(token), false);
  }
});

test("manual scanner input accepts only the token, QR namespace, or a ticket URL", () => {
  const token = generateCheckInToken();
  assert.equal(normalizeCheckInToken(token), token);
  assert.equal(normalizeCheckInToken(checkInQrValue(token)), token);
  assert.equal(normalizeCheckInToken(`https://events.example.test/ticket/${token}`), token);
  assert.equal(normalizeCheckInToken("marat-checkin:not-a-token"), null);
  assert.equal(normalizeCheckInToken("https://events.example.test/ticket/not-a-token"), null);
  assert.equal(normalizeCheckInToken(""), null);
});

test("check-in eligibility fails closed in stable safety order", () => {
  const base = {
    tokenFound: true,
    eventMatches: true,
    tokenStatus: "active" as const,
    expiresAt: new Date("2026-08-20T20:00:00.000Z"),
    paymentStatus: "paid",
    checkedInAt: null,
  };

  assert.equal(decideTokenCheckIn({ ...base, tokenFound: false }, NOW), "invalid_token");
  assert.equal(decideTokenCheckIn({ ...base, eventMatches: false }, NOW), "wrong_event");
  assert.equal(decideTokenCheckIn({ ...base, tokenStatus: "revoked" }, NOW), "revoked");
  assert.equal(decideTokenCheckIn({ ...base, expiresAt: NOW }, NOW), "expired");
  assert.equal(decideTokenCheckIn({ ...base, paymentStatus: "pending" }, NOW), "unpaid");
  assert.equal(decideTokenCheckIn({ ...base, checkedInAt: NOW }, NOW), "already_checked_in");
  assert.equal(decideTokenCheckIn(base, NOW), "checked_in");
});

test("check-in migration enforces opaque tokens, paid eligibility, audit, and race safety", () => {
  const sql = readFileSync(
    path.join(process.cwd(), "supabase", "migrations", "20260818195538_phase_3_check_in.sql"),
    "utf8",
  );

  assert.match(sql, /create table public\.registration_check_in_tokens/i);
  assert.match(sql, /token_hash text not null unique check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.doesNotMatch(sql, /\braw_token\b|\btoken_value\b/i);
  assert.match(sql, /foreign key \(registration_id, event_id\)[\s\S]*references public\.registrations\(id, event_id\)/i);
  assert.match(sql, /unique index registration_check_in_tokens_one_active_idx[\s\S]*where status = 'active'/i);
  assert.match(sql, /unique index registration_check_ins_one_active_idx[\s\S]*where status = 'checked_in'/i);
  assert.match(sql, /payment_status <> 'paid'/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /'already_checked_in'/i);
  assert.match(sql, /'wrong_event'/i);
  assert.match(sql, /create table public\.check_in_attempts/i);
  assert.match(sql, /alter table public\.registration_check_in_tokens enable row level security/i);
  assert.match(sql, /alter table public\.registration_check_ins enable row level security/i);
  assert.match(sql, /alter table public\.check_in_attempts enable row level security/i);
  assert.match(sql, /security invoker/gi);
  assert.doesNotMatch(sql, /security definer/i);
  assert.match(sql, /set search_path = ''/i);
  assert.match(sql, /revoke all on function public\.process_registration_check_in[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.process_registration_check_in[\s\S]*to service_role/i);
});

test("every check-in mutation rechecks admin authentication", () => {
  const actions = readFileSync(
    path.join(process.cwd(), "app", "admin", "(protected)", "check-in", "actions.ts"),
    "utf8",
  );
  const exportedActions = actions.match(/export async function \w+Action/g) ?? [];
  const sessionChecks = actions.match(/await requireAdminSession\(\)/g) ?? [];
  assert.equal(exportedActions.length, 4);
  assert.equal(sessionChecks.length, exportedActions.length);
});

test("public ticket lookup never selects attendee contact or payment detail fields", () => {
  const page = readFileSync(path.join(process.cwd(), "app", "ticket", "[token]", "page.tsx"), "utf8");
  assert.doesNotMatch(page, /\.select\("[^"]*(?:email|phone|amount_cents|stripe_)[^"]*"\)/i);
  assert.match(page, /checkInQrValue\(token\)/);
  assert.match(page, /bearer credential/i);
});
