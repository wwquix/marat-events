import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyAudienceRows,
  commitImport,
  csvRecords,
  identityKey,
  normalizeEmail,
  normalizeAudienceRecord,
  normalizePhone,
  parseCsv,
  validateImport,
  type AudienceImportCommitRepository,
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
    telegram: "https://t.me/Jane_Doe",
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
      ["telegram", "jane_doe"],
      ["linkedin", "linkedin.com/in/jane-doe"],
    ],
  );
});

test("accepts a UTF-8 BOM from spreadsheet CSV exports", () => {
  assert.deepEqual(csvRecords("\uFEFFfull_name,email\nJane Doe,jane@example.com\n"), [
    { fullName: "Jane Doe", email: "jane@example.com" },
  ]);
});

test("normalizes email and phone for trusted identity matching", () => {
  assert.equal(normalizeEmail(" JANE@Example.COM "), "jane@example.com");
  assert.deepEqual(normalizePhone("+1 (212) 555-0100"), {
    display: "+1 (212) 555-0100",
    normalized: "12125550100",
  });
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
  assert.equal(rows[1].decision, "review");
  assert.deepEqual(rows[1].errors, ["no_trusted_identifier"]);
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
      { fullName: "Jane Two", phone: "+1 646 555 0100" },
      { fullName: "Jane Three", phone: "+1 (646) 555-0100" },
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

test("validateImport reports new, duplicate, conflict, and invalid rows", () => {
  const existing: ExistingIdentityIndex = new Map([
    [identityKey("email", "known@example.com"), new Set(["person-1"])],
    [identityKey("phone", "12125550100"), new Set(["person-2"])],
    [identityKey("email", "conflict@example.com"), new Set(["person-3"])],
  ]);

  const preview = validateImport(
    [
      "full_name,email,phone",
      "New Person,new@example.com,",
      "Known Person,known@example.com,",
      "Conflict Person,conflict@example.com,+1 212 555 0100",
      "Invalid Person,not-an-email,",
    ].join("\n"),
    existing,
  );

  assert.deepEqual(preview.report, {
    newRows: 1,
    duplicateRows: 1,
    conflictRows: 1,
    invalidRows: 1,
  });
});

test("people with the same name and different emails are never merged", () => {
  const preview = validateImport(
    "full_name,email\nSame Name,first@example.com\nSame Name,second@example.com\n",
    new Map(),
  );

  assert.deepEqual(preview.rows.map((row) => row.decision), ["new_person", "new_person"]);
  assert.deepEqual(preview.rows.map((row) => row.candidatePersonIds), [[], []]);
});

test("commitImport requires confirmation and an idempotent repository reuses the canonical batch", async () => {
  const fileByBatch = new Map([
    ["preview-1", "same-file"],
    ["preview-2", "same-file"],
  ]);
  const canonicalByFile = new Map<string, string>();
  let createdPeople = 0;

  const repository: AudienceImportCommitRepository = {
    async commitBatch(batchId) {
      const file = fileByBatch.get(batchId);
      assert.ok(file);
      const existingBatch = canonicalByFile.get(file);
      if (existingBatch) {
        return {
          batchId: existingBatch,
          alreadyCommitted: true,
          createdPeople: 0,
          reusedPeople: 0,
          reviewRows: 0,
        };
      }

      canonicalByFile.set(file, batchId);
      createdPeople += 1;
      return {
        batchId,
        alreadyCommitted: false,
        createdPeople: 1,
        reusedPeople: 0,
        reviewRows: 0,
      };
    },
  };

  await assert.rejects(
    () => commitImport(repository, { batchId: "preview-1", confirmed: false }),
    /explicit confirmation/,
  );
  const first = await commitImport(repository, { batchId: "preview-1", confirmed: true });
  const repeated = await commitImport(repository, { batchId: "preview-2", confirmed: true });

  assert.equal(first.alreadyCommitted, false);
  assert.equal(repeated.alreadyCommitted, true);
  assert.equal(repeated.batchId, "preview-1");
  assert.equal(createdPeople, 1);
});

test("fails closed on malformed CSV", () => {
  assert.throws(() => parseCsv('name,email\n"Jane Doe,jane@example.com\n'), /Unclosed/);
  assert.throws(() => csvRecords("name,unknown\nJane Doe,x\n"), /Unsupported CSV column/);
});
