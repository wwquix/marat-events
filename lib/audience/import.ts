export type ContactChannel = "email" | "phone" | "instagram" | "linkedin";

export type AudienceImportDecision = "new_person" | "reuse_person" | "review" | "invalid";

export type AudienceContact = {
  channel: ContactChannel;
  value: string;
  normalizedValue: string;
};

export type NormalizedAudienceRow = {
  fullName: string;
  email: string | null;
  phone: string | null;
  gender: "male" | "female" | null;
  city: string | null;
  occupation: string | null;
  education: string | null;
  profileUrl: string | null;
  instagram: string | null;
  linkedin: string | null;
  source: string | null;
  sourceReference: string | null;
  contacts: AudienceContact[];
};

export type PreparedAudienceRow = {
  rowNumber: number;
  raw: Record<string, string>;
  normalized: NormalizedAudienceRow | null;
  decision: AudienceImportDecision;
  candidatePersonIds: string[];
  errors: string[];
};

export type ExistingIdentityIndex = Map<string, Set<string>>;

const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;

const HEADER_ALIASES: Record<string, keyof Omit<NormalizedAudienceRow, "contacts">> = {
  full_name: "fullName",
  "full name": "fullName",
  name: "fullName",
  email: "email",
  phone: "phone",
  phone_number: "phone",
  "phone number": "phone",
  gender: "gender",
  sex: "gender",
  city: "city",
  location: "city",
  occupation: "occupation",
  job: "occupation",
  work: "occupation",
  education: "education",
  university: "education",
  school: "education",
  profile_url: "profileUrl",
  "profile url": "profileUrl",
  profile: "profileUrl",
  instagram: "instagram",
  instagram_url: "instagram",
  "instagram url": "instagram",
  ig: "instagram",
  linkedin: "linkedin",
  linkedin_url: "linkedin",
  "linkedin url": "linkedin",
  source: "source",
  source_reference: "sourceReference",
  "source reference": "sourceReference",
  source_ref: "sourceReference",
};

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeText(value: string | undefined, maxLength: number): string | null {
  if (value === undefined) return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length <= maxLength ? normalized : null;
}

function normalizeEmail(value: string | undefined): string | null | undefined {
  const text = normalizeText(value, 254);
  if (text === null) return null;
  const email = text.toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

function normalizePhone(value: string | undefined): { display: string; normalized: string } | null | undefined {
  const text = normalizeText(value, 40);
  if (text === null) return null;
  if (!/^[0-9+().\-\s]+$/.test(text)) return undefined;
  const digits = text.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return undefined;
  return { display: text, normalized: digits };
}

function normalizeInstagram(value: string | undefined): { display: string; normalized: string } | null | undefined {
  const text = normalizeText(value, 500);
  if (text === null) return null;

  let handle = text;
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (host !== "instagram.com") return undefined;
      handle = url.pathname.split("/").filter(Boolean)[0] ?? "";
    } catch {
      return undefined;
    }
  }

  handle = handle.replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return undefined;
  return { display: text, normalized: handle.toLowerCase() };
}

function normalizeLinkedIn(value: string | undefined): { display: string; normalized: string } | null | undefined {
  const text = normalizeText(value, 500);
  if (text === null) return null;

  const candidate = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "linkedin.com") return undefined;
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    if (!path || path === "/") return undefined;
    return { display: text, normalized: `${host}${path}` };
  } catch {
    return undefined;
  }
}

function normalizeHttpUrl(value: string | undefined): string | null | undefined {
  const text = normalizeText(value, 500);
  if (text === null) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeGender(value: string | undefined): "male" | "female" | null | undefined {
  const text = normalizeText(value, 20)?.toLowerCase() ?? null;
  if (text === null) return null;
  if (["male", "man", "m"].includes(text)) return "male";
  if (["female", "woman", "f"].includes(text)) return "female";
  return undefined;
}

export function identityKey(channel: ContactChannel, normalizedValue: string): string {
  return `${channel}:${normalizedValue}`;
}

export function parseCsv(text: string): string[][] {
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    throw new Error("CSV file is larger than 2 MB.");
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      if (field.length !== 0) throw new Error("Malformed CSV quoting.");
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error("Unclosed quoted CSV field.");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  return rows.filter((candidate) => candidate.some((cell) => cell.trim().length > 0));
}

export function csvRecords(text: string): Record<string, string>[] {
  const matrix = parseCsv(text);
  if (matrix.length < 2) throw new Error("CSV must contain a header and at least one data row.");
  if (matrix.length - 1 > MAX_IMPORT_ROWS) throw new Error(`CSV may contain at most ${MAX_IMPORT_ROWS} data rows.`);

  const rawHeaders = matrix[0];
  const canonicalHeaders: string[] = [];
  const seen = new Set<string>();

  for (const rawHeader of rawHeaders) {
    const alias = HEADER_ALIASES[normalizeHeader(rawHeader)];
    if (!alias) throw new Error(`Unsupported CSV column: ${rawHeader || "(blank)"}`);
    if (seen.has(alias)) throw new Error(`Duplicate CSV column for ${alias}.`);
    seen.add(alias);
    canonicalHeaders.push(alias);
  }

  if (!seen.has("fullName")) throw new Error("CSV requires a full_name (or name) column.");

  return matrix.slice(1).map((cells, rowIndex) => {
    if (cells.length !== canonicalHeaders.length) {
      throw new Error(`CSV row ${rowIndex + 2} has ${cells.length} columns; expected ${canonicalHeaders.length}.`);
    }
    return Object.fromEntries(canonicalHeaders.map((header, index) => [header, cells[index] ?? ""]));
  });
}

export function normalizeAudienceRecord(raw: Record<string, string>): { normalized: NormalizedAudienceRow | null; errors: string[] } {
  const errors: string[] = [];
  const fullName = normalizeText(raw.fullName, 100);
  const email = normalizeEmail(raw.email);
  const phone = normalizePhone(raw.phone);
  const gender = normalizeGender(raw.gender);
  const city = normalizeText(raw.city, 160);
  const occupation = normalizeText(raw.occupation, 240);
  const education = normalizeText(raw.education, 240);
  const profileUrl = normalizeHttpUrl(raw.profileUrl);
  const instagram = normalizeInstagram(raw.instagram);
  const linkedin = normalizeLinkedIn(raw.linkedin);
  const source = normalizeText(raw.source, 120);
  const sourceReference = normalizeText(raw.sourceReference, 500);

  if (!fullName || (fullName.match(/\p{L}/gu) ?? []).length < 2) errors.push("invalid_full_name");
  if (email === undefined) errors.push("invalid_email");
  if (phone === undefined) errors.push("invalid_phone");
  if (gender === undefined) errors.push("invalid_gender");
  if (profileUrl === undefined) errors.push("invalid_profile_url");
  if (instagram === undefined) errors.push("invalid_instagram");
  if (linkedin === undefined) errors.push("invalid_linkedin");
  if (raw.city && city === null) errors.push("invalid_city");
  if (raw.occupation && occupation === null) errors.push("invalid_occupation");
  if (raw.education && education === null) errors.push("invalid_education");
  if (raw.source && source === null) errors.push("invalid_source");
  if (raw.sourceReference && sourceReference === null) errors.push("invalid_source_reference");

  if (errors.length > 0 || !fullName) return { normalized: null, errors };

  const contacts: AudienceContact[] = [];
  if (email) contacts.push({ channel: "email", value: email, normalizedValue: email });
  if (phone) contacts.push({ channel: "phone", value: phone.display, normalizedValue: phone.normalized });
  if (instagram) contacts.push({ channel: "instagram", value: instagram.display, normalizedValue: instagram.normalized });
  if (linkedin) contacts.push({ channel: "linkedin", value: linkedin.display, normalizedValue: linkedin.normalized });

  return {
    normalized: {
      fullName,
      email: email ?? null,
      phone: phone?.display ?? null,
      gender: gender ?? null,
      city,
      occupation,
      education,
      profileUrl: profileUrl ?? null,
      instagram: instagram?.display ?? null,
      linkedin: linkedin?.display ?? null,
      source,
      sourceReference,
      contacts,
    },
    errors: [],
  };
}

export function classifyAudienceRows(
  records: Record<string, string>[],
  existing: ExistingIdentityIndex,
): PreparedAudienceRow[] {
  const prepared = records.map((raw, index): PreparedAudienceRow => {
    const rowNumber = index + 2;
    const normalizedResult = normalizeAudienceRecord(raw);
    if (!normalizedResult.normalized) {
      return {
        rowNumber,
        raw,
        normalized: null,
        decision: "invalid",
        candidatePersonIds: [],
        errors: normalizedResult.errors,
      };
    }

    const candidateIds = new Set<string>();
    for (const contact of normalizedResult.normalized.contacts) {
      for (const personId of existing.get(identityKey(contact.channel, contact.normalizedValue)) ?? []) {
        candidateIds.add(personId);
      }
    }

    if (normalizedResult.normalized.contacts.length === 0) {
      return {
        rowNumber,
        raw,
        normalized: normalizedResult.normalized,
        decision: "review",
        candidatePersonIds: [],
        errors: ["no_trusted_identifier"],
      };
    }

    return {
      rowNumber,
      raw,
      normalized: normalizedResult.normalized,
      decision: candidateIds.size === 0 ? "new_person" : candidateIds.size === 1 ? "reuse_person" : "review",
      candidatePersonIds: [...candidateIds].sort(),
      errors: candidateIds.size > 1 ? ["conflicting_identifiers"] : [],
    };
  });

  const rowsByIdentifier = new Map<string, number[]>();
  for (const row of prepared) {
    for (const contact of row.normalized?.contacts ?? []) {
      const key = identityKey(contact.channel, contact.normalizedValue);
      const indexes = rowsByIdentifier.get(key) ?? [];
      indexes.push(row.rowNumber);
      rowsByIdentifier.set(key, indexes);
    }
  }

  const duplicateRows = new Set<number>();
  for (const rowNumbers of rowsByIdentifier.values()) {
    if (rowNumbers.length > 1) rowNumbers.forEach((rowNumber) => duplicateRows.add(rowNumber));
  }

  return prepared.map((row) => {
    if (!duplicateRows.has(row.rowNumber) || row.decision === "invalid") return row;
    return {
      ...row,
      decision: "review",
      errors: Array.from(new Set([...row.errors, "duplicate_identifier_in_file"])),
    };
  });
}
