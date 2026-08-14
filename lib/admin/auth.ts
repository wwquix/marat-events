import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const PASSWORD_SCHEME = "scrypt-v1";
const PASSWORD_KEY_BYTES = 64;
const SESSION_VERSION = 1;
export const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;

export type AdminAuthConfig = {
  email: string;
  passwordHash: string;
  sessionSecret: string;
};

export type AdminSession = {
  email: string;
  issuedAt: number;
  expiresAt: number;
};

type SessionPayload = {
  v: number;
  email: string;
  iat: number;
  exp: number;
};

export function normalizeAdminEmail(value: string): string {
  return value.trim().toLowerCase();
}

function digestForComparison(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeStringEqual(left: string, right: string): boolean {
  return timingSafeEqual(digestForComparison(left), digestForComparison(right));
}

function parsePasswordHash(encodedHash: string): { salt: Buffer; digest: Buffer } | null {
  const parts = encodedHash.split("$");
  if (parts.length !== 3 || parts[0] !== PASSWORD_SCHEME) {
    return null;
  }

  try {
    const salt = Buffer.from(parts[1], "base64url");
    const digest = Buffer.from(parts[2], "base64url");

    if (salt.length < 16 || digest.length !== PASSWORD_KEY_BYTES) {
      return null;
    }

    return { salt, digest };
  } catch {
    return null;
  }
}

export function hashAdminPassword(password: string, salt = randomBytes(16)): string {
  if (password.length < 12 || password.length > 256) {
    throw new Error("Admin password must be between 12 and 256 characters.");
  }

  if (salt.length < 16) {
    throw new Error("Admin password salt is too short.");
  }

  const digest = scryptSync(password, salt, PASSWORD_KEY_BYTES);
  return `${PASSWORD_SCHEME}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

export function verifyAdminPassword(password: string, encodedHash: string): boolean {
  if (password.length === 0 || password.length > 256) {
    return false;
  }

  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) {
    return false;
  }

  const candidate = scryptSync(password, parsed.salt, parsed.digest.length);
  return timingSafeEqual(candidate, parsed.digest);
}

export function generateAdminSessionSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function getAdminAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): AdminAuthConfig | null {
  const email = typeof env.ADMIN_EMAIL === "string" ? normalizeAdminEmail(env.ADMIN_EMAIL) : "";
  const passwordHash = env.ADMIN_PASSWORD_HASH ?? "";
  const sessionSecret = env.ADMIN_SESSION_SECRET ?? "";

  if (!email || !passwordHash || !sessionSecret) {
    return null;
  }

  if (!parsePasswordHash(passwordHash) || sessionSecret.length < 32) {
    return null;
  }

  return { email, passwordHash, sessionSecret };
}

export function validateAdminLoginInput(value: unknown):
  | { ok: true; email: string; password: string }
  | { ok: false } {
  if (!value || typeof value !== "object") {
    return { ok: false };
  }

  const input = value as Record<string, unknown>;
  if (typeof input.email !== "string" || typeof input.password !== "string") {
    return { ok: false };
  }

  const email = normalizeAdminEmail(input.email);
  const password = input.password;

  if (
    email.length < 3 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    password.length === 0 ||
    password.length > 256
  ) {
    return { ok: false };
  }

  return { ok: true, email, password };
}

export function verifyAdminCredentials(
  email: string,
  password: string,
  config: AdminAuthConfig,
): boolean {
  const passwordMatches = verifyAdminPassword(password, config.passwordHash);
  const emailMatches = safeStringEqual(normalizeAdminEmail(email), config.email);
  return passwordMatches && emailMatches;
}

function signSessionPayload(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload, "utf8").digest("base64url");
}

export function createAdminSessionToken(
  email: string,
  config: AdminAuthConfig,
  nowMs = Date.now(),
): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const payload: SessionPayload = {
    v: SESSION_VERSION,
    email: normalizeAdminEmail(email),
    iat: issuedAt,
    exp: issuedAt + ADMIN_SESSION_TTL_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signSessionPayload(encodedPayload, config.sessionSecret);
  return `${encodedPayload}.${signature}`;
}

export function verifyAdminSessionToken(
  token: string,
  config: AdminAuthConfig,
  nowMs = Date.now(),
): AdminSession | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }

  const [encodedPayload, suppliedSignature] = parts;
  const expectedSignature = signSessionPayload(encodedPayload, config.sessionSecret);
  if (!safeStringEqual(suppliedSignature, expectedSignature)) {
    return null;
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }

  const now = Math.floor(nowMs / 1000);
  if (
    payload.v !== SESSION_VERSION ||
    typeof payload.email !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    payload.iat > now + 300 ||
    payload.exp <= now ||
    payload.exp - payload.iat !== ADMIN_SESSION_TTL_SECONDS ||
    !safeStringEqual(normalizeAdminEmail(payload.email), config.email)
  ) {
    return null;
  }

  return {
    email: config.email,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}
