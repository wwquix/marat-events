import { createHash, randomBytes } from "node:crypto";

const MATCHING_TOKEN_BYTES = 32;
const MATCHING_TOKEN_PREFIX = "mt_";
const MATCHING_TOKEN_PATTERN = /^mt_[A-Za-z0-9_-]{43}$/;

export function generateMatchingToken(): string {
  return `${MATCHING_TOKEN_PREFIX}${randomBytes(MATCHING_TOKEN_BYTES).toString("base64url")}`;
}

export function isMatchingToken(value: string): boolean {
  return MATCHING_TOKEN_PATTERN.test(value);
}

export function normalizeMatchingToken(input: string): string | null {
  const value = input.trim();
  if (!value || value.length > 2_048) return null;
  if (isMatchingToken(value)) return value;

  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    const token = segments.at(-1) ?? "";
    return isMatchingToken(token) ? token : null;
  } catch {
    return null;
  }
}

export function hashMatchingToken(token: string): string {
  if (!isMatchingToken(token)) throw new Error("Invalid matching token.");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function matchingParticipantPath(token: string): string {
  if (!isMatchingToken(token)) throw new Error("Invalid matching token.");
  return `/match/${encodeURIComponent(token)}`;
}
