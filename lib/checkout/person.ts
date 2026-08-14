export type PersonIdentityInput = {
  fullName: string;
  email: string;
  phone: string;
  gender: "male" | "female";
};

export type PersonRepository = {
  loadByEmail(email: string): Promise<string | null>;
  create(input: PersonIdentityInput): Promise<string>;
};

/**
 * Resolve a central person record by normalized email without allowing a public
 * registration to overwrite an existing person's trusted central fields.
 *
 * If two requests race to create the same unique email, the loser reloads once
 * and reuses the row created by the winner.
 */
export async function resolvePersonIdentity(
  repository: PersonRepository,
  input: PersonIdentityInput,
): Promise<string> {
  const existingPersonId = await repository.loadByEmail(input.email);
  if (existingPersonId) {
    return existingPersonId;
  }

  try {
    return await repository.create(input);
  } catch (error) {
    const concurrentPersonId = await repository.loadByEmail(input.email);
    if (concurrentPersonId) {
      return concurrentPersonId;
    }

    throw error;
  }
}
