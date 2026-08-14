import assert from "node:assert/strict";
import test from "node:test";

import {
  resolvePersonIdentity,
  type PersonIdentityInput,
  type PersonRepository,
} from "../lib/checkout/person";

const input: PersonIdentityInput = {
  fullName: "Phase One Test",
  email: "phase-one@example.com",
  phone: "+1 212 555 0198",
  gender: "female",
};

test("reuses an existing person without creating or overwriting it", async () => {
  let createCalls = 0;
  const repository: PersonRepository = {
    async loadByEmail(email) {
      assert.equal(email, input.email);
      return "existing-person-id";
    },
    async create() {
      createCalls += 1;
      return "unexpected-new-id";
    },
  };

  const personId = await resolvePersonIdentity(repository, input);

  assert.equal(personId, "existing-person-id");
  assert.equal(createCalls, 0);
});

test("creates a person when the normalized email is new", async () => {
  const createdInputs: PersonIdentityInput[] = [];
  const repository: PersonRepository = {
    async loadByEmail() {
      return null;
    },
    async create(value) {
      createdInputs.push(value);
      return "new-person-id";
    },
  };

  const personId = await resolvePersonIdentity(repository, input);

  assert.equal(personId, "new-person-id");
  assert.deepEqual(createdInputs, [input]);
});

test("reuses the concurrent winner after a unique-email create race", async () => {
  let lookupCount = 0;
  const uniqueError = new Error("unique email conflict");
  const repository: PersonRepository = {
    async loadByEmail() {
      lookupCount += 1;
      return lookupCount === 1 ? null : "concurrent-person-id";
    },
    async create() {
      throw uniqueError;
    },
  };

  const personId = await resolvePersonIdentity(repository, input);

  assert.equal(personId, "concurrent-person-id");
  assert.equal(lookupCount, 2);
});

test("propagates create failure when no concurrent person appears", async () => {
  const databaseError = new Error("database unavailable");
  const repository: PersonRepository = {
    async loadByEmail() {
      return null;
    },
    async create() {
      throw databaseError;
    },
  };

  await assert.rejects(
    () => resolvePersonIdentity(repository, input),
    (error) => error === databaseError,
  );
});
