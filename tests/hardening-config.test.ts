import assert from "node:assert/strict";
import test from "node:test";

import {
  FUTURE_PRODUCTION_REQUIREMENTS,
  FUTURE_PRODUCTION_SERVER_VARIABLES,
  OPTIONAL_PROVIDER_SERVER_VARIABLES,
  assertStagingServerEnvironment,
  inspectServerEnvironment,
} from "../lib/config/environment-policy";

const validStagingEnvironment = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_example",
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_PASSWORD_HASH: `scrypt-v1$${Buffer.alloc(16, 1).toString("base64url")}$${Buffer.alloc(64, 2).toString("base64url")}`,
  ADMIN_SESSION_SECRET: "a".repeat(32),
};

test("development and tests remain buildable without provider secrets", () => {
  assert.equal(inspectServerEnvironment("development", {}).ready, true);
  assert.equal(inspectServerEnvironment("test", {}).ready, true);
});

test("staging requires the implemented server-only configuration", () => {
  const report = inspectServerEnvironment("staging", validStagingEnvironment);

  assert.equal(report.ready, true);
  assert.deepEqual(report.issues, []);
});

test("staging rejects live Stripe credentials and public aliases of secrets", () => {
  const report = inspectServerEnvironment("staging", {
    ...validStagingEnvironment,
    STRIPE_SECRET_KEY: "sk_live_do_not_use",
    NEXT_PUBLIC_SUPABASE_SECRET_KEY: "leaked",
  });

  assert.equal(report.ready, false);
  assert.ok(
    report.issues.some(
      (issue) =>
        issue.code === "stripe_test_key_required" && issue.variable === "STRIPE_SECRET_KEY",
    ),
  );
  assert.ok(
    report.issues.some(
      (issue) =>
        issue.code === "public_secret_alias_present" &&
        issue.variable === "SUPABASE_SECRET_KEY",
    ),
  );
});

test("staging validation reports malformed values without echoing them", () => {
  const report = inspectServerEnvironment("preview", {
    ...validStagingEnvironment,
    SUPABASE_URL: "http://not-staging.invalid",
    STRIPE_WEBHOOK_SECRET: "not-a-webhook-secret",
    ADMIN_EMAIL: "not-an-email",
    ADMIN_PASSWORD_HASH: "not-a-password-hash",
    ADMIN_SESSION_SECRET: "too-short",
  });

  assert.equal(report.ready, false);
  assert.deepEqual(report.issues, [
    { code: "invalid_supabase_url", variable: "SUPABASE_URL" },
    { code: "invalid_webhook_secret", variable: "STRIPE_WEBHOOK_SECRET" },
    { code: "invalid_admin_email", variable: "ADMIN_EMAIL" },
    { code: "invalid_admin_password_hash", variable: "ADMIN_PASSWORD_HASH" },
    { code: "admin_session_secret_too_short", variable: "ADMIN_SESSION_SECRET" },
  ]);

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(
    serialized,
    /not-staging|not-a-webhook|not-an-email|not-a-password|too-short/,
  );
});

test("validation errors name configuration fields but never include their values", () => {
  const leakedValue = "sk_live_sensitive_material";

  assert.throws(
    () =>
      assertStagingServerEnvironment({
        ...validStagingEnvironment,
        STRIPE_SECRET_KEY: leakedValue,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /stripe_test_key_required:STRIPE_SECRET_KEY/);
      assert.doesNotMatch(error.message, new RegExp(leakedValue));
      return true;
    },
  );
});

test("provider variables remain uncommitted and production stays fail closed", () => {
  assert.deepEqual(OPTIONAL_PROVIDER_SERVER_VARIABLES, []);
  assert.deepEqual(FUTURE_PRODUCTION_SERVER_VARIABLES, []);
  assert.deepEqual(FUTURE_PRODUCTION_REQUIREMENTS, [
    "canonical_app_url",
    "capacity_reservation_policy",
    "production_stripe_activation",
    "rate_limit_provider",
    "backup_restore_proof",
  ]);

  const production = inspectServerEnvironment("production", validStagingEnvironment);
  assert.equal(production.ready, false);
  assert.deepEqual(production.issues, [{ code: "production_activation_not_implemented" }]);
});
