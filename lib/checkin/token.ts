import { createHash, randomBytes } from "node:crypto";

const CHECK_IN_TOKEN_BYTES = 32;
const CHECK_IN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CHECK_IN_QR_PREFIX = "marat-checkin:";

export function generateCheckInToken(): string {
  return randomBytes(CHECK_IN_TOKEN_BYTES).toString("base64url");
}

export function isCheckInToken(value: string): boolean {
  return CHECK_IN_TOKEN_PATTERN.test(value);
}

export function normalizeCheckInToken(input: string): string | null {
  const value = input.trim();
  if (!value || value.length > 2_048) return null;

  if (value.startsWith(CHECK_IN_QR_PREFIX)) {
    const token = value.slice(CHECK_IN_QR_PREFIX.length);
    return isCheckInToken(token) ? token : null;
  }

  if (isCheckInToken(value)) return value;

  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    const token = segments.at(-1) ?? "";
    return isCheckInToken(token) ? token : null;
  } catch {
    return null;
  }
}

export function hashCheckInToken(token: string): string {
  if (!isCheckInToken(token)) throw new Error("Invalid check-in token.");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function fingerprintCheckInTokenHash(tokenHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error("Invalid check-in token hash.");
  return tokenHash.slice(0, 16);
}

export function checkInQrValue(token: string): string {
  if (!isCheckInToken(token)) throw new Error("Invalid check-in token.");
  return `${CHECK_IN_QR_PREFIX}${token}`;
}

export function checkInTicketPath(token: string): string {
  if (!isCheckInToken(token)) throw new Error("Invalid check-in token.");
  return `/ticket/${encodeURIComponent(token)}`;
}
