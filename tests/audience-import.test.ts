import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyAudienceRows,
  csvRecords,
  identityKey,
  normalizeAudienceRecord,
  parseCsv,
  type ExistingIdentityIndex,
} from "../lib/audience/import";

test("parses quoted CSV fields and aliases", () => {
  const rows = csvRecords(
    'name,email,instagram,occupation\r\n"Jane, Doe",JANE@example.com,@Jane.Doe,"Founder, Acme"\r\n',
  );

  assert.deepEqual(rows, [
    {
      fullName: "Jane, Doe",
      email: "JANE@example.com",
      instagram: "@Jane.Doe",
      occupation: "Founder, Acme",
    },
  ]);
});

test("normalizes audience identity fields deterministically", () => {
  const result = normalizeAudienceRecord({
    fullName: "  Jane   Doe ",
    email: " JANE@Example.COM ",
    phone: "+1 (212) 555-0100",
    gender: "Woman",
    instagram: "https://www.instagram.com/Jane.Doe/?utm_source=test",
    linkedin: "https://www.linkedin.com/in/Jane-Doe/?trk=test",
  });

  assert.equal(result.errors.length, 0);
  assert.ok(result.normalized);
  assert.equal(result.normalized.fullName, "Jane Doe");
  assert.equal(result.normalized.email, "jane@example.com");
  assert.equal(result.normalized.gender, "female");
  assert.deepEqual(
    result.normalized.contacts.map((contact) => [contact.channel, contact.normalizedValue]),
    [
      ["email", "jane@example.com"],
      ["phone", "12125550100"],
      ["instagram", "jane.doe"],
      ["linkedin", "linkedin.com/in/jane-doe"],
    ],
  );
});

test("rejects malformed provided identifiers instead of silently dropping them", () => {
  const result = normalizeAudienceRecord({
    fullName: "Jane Doe",
    email: "not-an-email",
    instagram: "https://example.com/jane",
  });

  assert.equal(result.normalized, null);
  assert.deepEqual(result.errors.sort(), ["invalid_email", "invalid_instagram"]);
});

test("classifies deterministic reuse by trusted identifier and never by name", () => {
  const existing: ExistingIdentityIndex = new Map([
    [identityKey("email", "jane@example.com"), new Set(["person-1"])],
  ]);

  const rows = classifyAudienceRows(
    [
      { fullName: "Totally Different Name", email: "jane@example.com" },
      { fullName: "Jane Doe", instagram: "newhandle" },
      { fullName: "Jane Doe" },
    ],
    existing,
  );

  assert.equal(rows[0].decision, "reuse_person");
  assert.deepEqual(rows[0].candidatePersonIds, ["person-1"]);
  assert.equal(rows[1].decision, "new_person");
  assert.equal(rows[2].decision, "review");
  assert.deepEqual(rows[2].errors, ["no_trusted_identifier"]);
});

test("conflicting identifiers and duplicates inside one file require review", () => {
  const existing: ExistingIdentityIndex = new Map([
    [identityKey("email", "jane@example.com"), new Set(["person-1"])],
    [identityKey("phone", "12125550100"), new Set(["person-2"])],
  ]);

  const rows = classifyAudienceRows(
    [
      { fullName: "Jane One", email: "jane@example.com", phone: "+1 212 555 0100" },
      { fullName: "Jane Two", instagram: "same.handle" },
      { fullName: "Jane Three", instagram: "same.handle" },
    ],
    existing,
  );

  assert.equal(rows[0].decision, "review");
  assert.deepEqual(rows[0].candidatePersonIds, ["person-1", "person-2"]);
  assert.ok(rows[0].errors.includes("conflicting_identifiers"));
  assert.equal(rows[1].decision, "review");
  assert.equal(rows[2].decision, "review");
  assert.ok(rows[1].errors.includes("duplicate_identifier_in_file"));
  assert.ok(rows[2].errors.includes("duplicate_identifier_in_file"));
});

test("fails closed on malformed CSV", () => {
  assert.throws(() => parseCsv('name,email\n"Jane Doe,jane@example.com\n'), /Unclosed/);
  assert.throws(() => csvRecords("name,unknown\nJane Doe,x\n"), /Unsupported CSV column/);
});
