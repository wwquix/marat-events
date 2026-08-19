import assert from "node:assert/strict";
import test from "node:test";

import nextConfig, { SECURITY_HEADERS } from "../next.config";

test("conservative security headers apply to every route", async () => {
  assert.deepEqual(SECURITY_HEADERS, [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    {
      key: "Permissions-Policy",
      value: "camera=(self), geolocation=(), microphone=()",
    },
  ]);

  assert.equal(typeof nextConfig.headers, "function");
  const configured = await nextConfig.headers!();
  assert.deepEqual(configured, [{ source: "/(.*)", headers: [...SECURITY_HEADERS] }]);
});
