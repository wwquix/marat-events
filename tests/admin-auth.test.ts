import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_SESSION_TTL_SECONDS,
  createAdminSessionToken,
  getAdminAuthConfig,
  hashAdminPassword,
  normalizeAdminEmail,
  validateAdminLoginInput,
  verifyAdminCredentials,
  verifyAdminPassword,
  verifyAdminSessionToken,
  type AdminAuthConfig,
} from "../lib/admin/auth";

const password = "correct horse battery staple";
const passwordHash = hashAdminPassword(password, Buffer.alloc(16, 7));
const config: AdminAuthConfig = {
  email: "admin@example.com",
  passwordHash,
  sessionSecret: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
};

test("normalizes and validates admin login input", () => {
  assert.equal(normalizeAdminEmail("  ADMIN@Example.COM  "), "admin@example.com");

  assert.deepEqual(
    validateAdminLoginInput({ email: " ADMIN@Example.COM ", password }),
    { ok: true, email: "admin@example.com", password },
  );
  assert.deepEqual(validateAdminLoginInput({ email: "not-an-email", password }), { ok: false });
  assert.deepEqual(validateAdminLoginInput({ email: "admin@example.com", password: "" }), {
    ok: false,
  });
});

test("verifies the scrypt password hash without storing plaintext", () => {
  assert.equal(passwordHash.startsWith("scrypt-v1$"), true);
  assert.equal(passwordHash.includes(password), false);
  assert.equal(verifyAdminPassword(password, passwordHash), true);
  assert.equal(verifyAdminPassword("wrong password", passwordHash), false);
});

test("requires both the configured email and password", () => {
  assert.equal(verifyAdminCredentials("ADMIN@example.com", password, config), true);
  assert.equal(verifyAdminCredentials("other@example.com", password, config), false);
  assert.equal(verifyAdminCredentials("admin@example.com", "wrong password", config), false);
});

test("creates and verifies a bounded signed admin session", () => {
  const now = 1_800_000_000_000;
  const token = createAdminSessionToken("ADMIN@example.com", config, now);
  const session = verifyAdminSessionToken(token, config, now + 60_000);

  assert.ok(session);
  assert.equal(session.email, "admin@example.com");
  assert.equal(session.expiresAt - session.issuedAt, ADMIN_SESSION_TTL_SECONDS);
});

test("rejects tampered, expired, and differently configured sessions", () => {
  const now = 1_800_000_000_000;
  const token = createAdminSessionToken(config.email, config, now);
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

  assert.equal(verifyAdminSessionToken(tampered, config, now), null);
  assert.equal(
    verifyAdminSessionToken(token, config, now + (ADMIN_SESSION_TTL_SECONDS + 1) * 1000),
    null,
  );
  assert.equal(
    verifyAdminSessionToken(
      token,
      { ...config, email: "someone-else@example.com" },
      now,
    ),
    null,
  );
});

test("environment config fails closed when credentials are incomplete or malformed", () => {
  assert.equal(getAdminAuthConfig({}), null);
  assert.equal(
    getAdminAuthConfig({
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD_HASH: "bad-hash",
      ADMIN_SESSION_SECRET: config.sessionSecret,
    }),
    null,
  );
  assert.deepEqual(
    getAdminAuthConfig({
      ADMIN_EMAIL: " ADMIN@example.com ",
      ADMIN_PASSWORD_HASH: passwordHash,
      ADMIN_SESSION_SECRET: config.sessionSecret,
    }),
    config,
  );
});
