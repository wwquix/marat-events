import assert from "node:assert/strict";
import test from "node:test";

import { createSafeLogRecord, redactForLog } from "../lib/observability/redaction";

test("structured logging redacts credentials, contacts, bearer tokens and payloads", () => {
  const output = redactForLog({
    operation: "stripe_webhook",
    authorization: "Bearer raw-bearer-token",
    stripeSecret: "sk_test_sensitive",
    nested: {
      email: "person@example.com",
      phone: "+1 212 555 0100",
      payload: { full_name: "Sensitive Person" },
      value: "@private_profile",
      route: `/ticket/${"a".repeat(43)}`,
      invite: `mi_${"c".repeat(43)}`,
      opaqueReference: "b".repeat(64),
      harmless: "Bearer also-sensitive",
    },
  });
  const serialized = JSON.stringify(output);

  assert.doesNotMatch(serialized, /raw-bearer-token/);
  assert.doesNotMatch(serialized, /sk_test_sensitive/);
  assert.doesNotMatch(serialized, /person@example\.com/);
  assert.doesNotMatch(serialized, /212 555 0100/);
  assert.doesNotMatch(serialized, /Sensitive Person/);
  assert.doesNotMatch(serialized, /private_profile/);
  assert.doesNotMatch(serialized, new RegExp("a".repeat(43)));
  assert.doesNotMatch(serialized, new RegExp(`mi_${"c".repeat(43)}`));
  assert.doesNotMatch(serialized, new RegExp("b".repeat(64)));
  assert.match(serialized, /\[REDACTED\]/);
});

test("structured logging never serializes error messages or stacks", () => {
  const output = redactForLog(new Error("contains whsec_sensitive and person@example.com"));
  const serialized = JSON.stringify(output);

  assert.deepEqual(output, { name: "Error", details: "[REDACTED]" });
  assert.doesNotMatch(serialized, /whsec_sensitive|person@example\.com|at /);
});

test("log records accept stable event codes and reject arbitrary event text", () => {
  const now = () => new Date("2026-08-18T20:00:00.000Z");
  const safe = createSafeLogRecord("info", "outbox.claimed", { count: 2 }, now);
  const unsafe = createSafeLogRecord(
    "error",
    "person@example.com failed",
    { errorCode: "provider_unavailable" },
    now,
  );

  assert.deepEqual(safe, {
    timestamp: "2026-08-18T20:00:00.000Z",
    level: "info",
    event: "outbox.claimed",
    context: { count: 2 },
  });
  assert.equal(unsafe.event, "invalid_log_event");
});

test("redaction handles circular and excessively deep structures safely", () => {
  const circular: Record<string, unknown> = { status: "pending" };
  circular.self = circular;
  const output = redactForLog({ circular, deep: { a: { b: { c: { d: { e: 1 } } } } } });
  const serialized = JSON.stringify(output);

  assert.match(serialized, /\[CIRCULAR\]/);
  assert.match(serialized, /\[MAX_DEPTH\]/);
});

test("redaction refuses binary and non-plain objects", () => {
  class CredentialContainer {
    secret = "do-not-serialize";
  }

  assert.deepEqual(redactForLog({
    binary: Buffer.from("private-key-material"),
    custom: new CredentialContainer(),
  }), {
    binary: "[BINARY_REDACTED]",
    custom: "[NON_PLAIN_OBJECT_REDACTED]",
  });
});

test("redaction does not invoke accessors and fails closed for hostile objects", () => {
  let accessorInvoked = false;
  const withAccessor = Object.defineProperty({}, "details", {
    enumerable: true,
    get() {
      accessorInvoked = true;
      throw new Error("sensitive getter value");
    },
  });
  const hostile = new Proxy({}, {
    getPrototypeOf() {
      throw new Error("sensitive proxy value");
    },
  });

  assert.deepEqual(redactForLog(withAccessor), { details: "[ACCESSOR_REDACTED]" });
  assert.equal(accessorInvoked, false);
  assert.equal(redactForLog(hostile), "[UNSERIALIZABLE_REDACTED]");
});
