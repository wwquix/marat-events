export type DeploymentTarget =
  | "development"
  | "test"
  | "preview"
  | "staging"
  | "production";

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export const STAGING_REQUIRED_SERVER_VARIABLES = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD_HASH",
  "ADMIN_SESSION_SECRET",
] as const;

/**
 * No outbound or abuse-prevention provider has been approved yet. Keeping this
 * list empty is intentional: a provider variable becomes part of the contract
 * only when the provider integration itself is approved and implemented.
 */
export const OPTIONAL_PROVIDER_SERVER_VARIABLES = [] as const;

/**
 * Production variable names are intentionally not part of the contract yet.
 * Add names here only with the implementation that consumes and validates
 * them; conceptual launch requirements are tracked separately below.
 */
export const FUTURE_PRODUCTION_SERVER_VARIABLES = [] as const;

export const FUTURE_PRODUCTION_REQUIREMENTS = [
  "canonical_app_url",
  "capacity_reservation_policy",
  "production_stripe_activation",
  "rate_limit_provider",
  "backup_restore_proof",
] as const;

type StagingVariable = (typeof STAGING_REQUIRED_SERVER_VARIABLES)[number];

export type EnvironmentIssue = Readonly<{
  code:
    | "missing_variable"
    | "public_secret_alias_present"
    | "invalid_supabase_url"
    | "stripe_test_key_required"
    | "invalid_webhook_secret"
    | "invalid_admin_email"
    | "invalid_admin_password_hash"
    | "admin_session_secret_too_short"
    | "production_activation_not_implemented";
  variable?: StagingVariable;
}>;

export type EnvironmentInspection = Readonly<{
  target: DeploymentTarget;
  ready: boolean;
  stagingRequired: typeof STAGING_REQUIRED_SERVER_VARIABLES;
  optionalProviderVariables: typeof OPTIONAL_PROVIDER_SERVER_VARIABLES;
  futureProductionVariables: typeof FUTURE_PRODUCTION_SERVER_VARIABLES;
  futureProductionRequirements: typeof FUTURE_PRODUCTION_REQUIREMENTS;
  issues: readonly EnvironmentIssue[];
}>;

const SERVER_SECRET_VARIABLES = [
  "SUPABASE_SECRET_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "ADMIN_PASSWORD_HASH",
  "ADMIN_SESSION_SECRET",
] as const satisfies readonly StagingVariable[];

function hasValue(env: EnvironmentSource, name: string): boolean {
  return typeof env[name] === "string" && env[name]!.trim().length > 0;
}

function hasValidHttpsUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

function hasValidAdminPasswordHash(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const parts = value.split("$");
  if (
    parts.length !== 3 ||
    parts[0] !== "scrypt-v1" ||
    !/^[A-Za-z0-9_-]+$/.test(parts[1]) ||
    !/^[A-Za-z0-9_-]+$/.test(parts[2])
  ) {
    return false;
  }

  try {
    return Buffer.from(parts[1], "base64url").length >= 16 && Buffer.from(parts[2], "base64url").length === 64;
  } catch {
    return false;
  }
}

function inspectStagingValues(env: EnvironmentSource): EnvironmentIssue[] {
  const issues: EnvironmentIssue[] = [];

  for (const variable of STAGING_REQUIRED_SERVER_VARIABLES) {
    if (!hasValue(env, variable)) {
      issues.push({ code: "missing_variable", variable });
    }
  }

  for (const variable of SERVER_SECRET_VARIABLES) {
    if (hasValue(env, `NEXT_PUBLIC_${variable}`)) {
      issues.push({ code: "public_secret_alias_present", variable });
    }
  }

  if (hasValue(env, "SUPABASE_URL") && !hasValidHttpsUrl(env.SUPABASE_URL)) {
    issues.push({ code: "invalid_supabase_url", variable: "SUPABASE_URL" });
  }

  if (hasValue(env, "STRIPE_SECRET_KEY") && !env.STRIPE_SECRET_KEY!.startsWith("sk_test_")) {
    issues.push({ code: "stripe_test_key_required", variable: "STRIPE_SECRET_KEY" });
  }

  if (
    hasValue(env, "STRIPE_WEBHOOK_SECRET") &&
    !env.STRIPE_WEBHOOK_SECRET!.startsWith("whsec_")
  ) {
    issues.push({ code: "invalid_webhook_secret", variable: "STRIPE_WEBHOOK_SECRET" });
  }

  if (
    hasValue(env, "ADMIN_EMAIL") &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ADMIN_EMAIL!.trim())
  ) {
    issues.push({ code: "invalid_admin_email", variable: "ADMIN_EMAIL" });
  }

  if (
    hasValue(env, "ADMIN_PASSWORD_HASH") &&
    !hasValidAdminPasswordHash(env.ADMIN_PASSWORD_HASH)
  ) {
    issues.push({ code: "invalid_admin_password_hash", variable: "ADMIN_PASSWORD_HASH" });
  }

  if (hasValue(env, "ADMIN_SESSION_SECRET") && env.ADMIN_SESSION_SECRET!.length < 32) {
    issues.push({ code: "admin_session_secret_too_short", variable: "ADMIN_SESSION_SECRET" });
  }

  return issues;
}

export function inspectServerEnvironment(
  target: DeploymentTarget,
  env: EnvironmentSource,
): EnvironmentInspection {
  const requiresStagingConfiguration = target === "preview" || target === "staging";
  const issues = requiresStagingConfiguration ? inspectStagingValues(env) : [];

  if (target === "production") {
    issues.push({ code: "production_activation_not_implemented" });
  }

  return {
    target,
    ready: issues.length === 0,
    stagingRequired: STAGING_REQUIRED_SERVER_VARIABLES,
    optionalProviderVariables: OPTIONAL_PROVIDER_SERVER_VARIABLES,
    futureProductionVariables: FUTURE_PRODUCTION_SERVER_VARIABLES,
    futureProductionRequirements: FUTURE_PRODUCTION_REQUIREMENTS,
    issues,
  };
}

export function assertStagingServerEnvironment(env: EnvironmentSource): void {
  const inspection = inspectServerEnvironment("staging", env);
  if (inspection.ready) {
    return;
  }

  const issueSummary = inspection.issues
    .map((issue) => (issue.variable ? `${issue.code}:${issue.variable}` : issue.code))
    .join(", ");

  throw new Error(`Server environment is not staging-ready (${issueSummary}).`);
}
