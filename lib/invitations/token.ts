import { createHash, randomBytes } from "node:crypto";

const INVITATION_TOKEN_BYTES = 32;
const INVITATION_TOKEN_PREFIX = "mi_";
const INVITATION_TOKEN_PATTERN = /^mi_[A-Za-z0-9_-]{43}$/;

export function generateInvitationToken(): string {
  return `${INVITATION_TOKEN_PREFIX}${randomBytes(INVITATION_TOKEN_BYTES).toString("base64url")}`;
}

export function parseInvitationToken(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const token = value.trim();
  return INVITATION_TOKEN_PATTERN.test(token) ? token : null;
}

export function hashInvitationToken(token: string): string {
  const parsed = parseInvitationToken(token);
  if (!parsed) throw new Error("Invalid invitation token.");

  return createHash("sha256").update(parsed, "utf8").digest("hex");
}
