export const TEMPLATE_VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export type TemplateRenderErrorCode =
  | "invalid_variable_name"
  | "duplicate_variable"
  | "malformed_placeholder"
  | "undeclared_variable"
  | "missing_variable";

export class TemplateRenderError extends Error {
  constructor(
    readonly code: TemplateRenderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TemplateRenderError";
  }
}

export type TemplateSource = {
  subject: string | null;
  body: string;
  variables: readonly string[];
};

export type RenderedTemplate = {
  subject: string | null;
  body: string;
  usedVariables: string[];
};

const PLACEHOLDER_PATTERN = /{{\s*([a-z][a-z0-9_]*)\s*}}/g;

export function normalizeTemplateVariables(variables: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawVariable of variables) {
    const variable = rawVariable.trim();
    if (!TEMPLATE_VARIABLE_NAME_PATTERN.test(variable)) {
      throw new TemplateRenderError("invalid_variable_name", `Invalid template variable: ${rawVariable}`);
    }
    if (seen.has(variable)) {
      throw new TemplateRenderError("duplicate_variable", `Duplicate template variable: ${variable}`);
    }

    seen.add(variable);
    normalized.push(variable);
  }

  return normalized.sort();
}

function renderText(
  source: string,
  allowedVariables: ReadonlySet<string>,
  values: Readonly<Record<string, string>>,
  usedVariables: Set<string>,
): string {
  const rendered = source.replace(PLACEHOLDER_PATTERN, (_placeholder, variable: string) => {
    if (!allowedVariables.has(variable)) {
      throw new TemplateRenderError("undeclared_variable", `Template variable is not declared: ${variable}`);
    }

    const value = values[variable];
    if (typeof value !== "string") {
      throw new TemplateRenderError("missing_variable", `Template variable is missing: ${variable}`);
    }

    usedVariables.add(variable);
    return value;
  });

  if (rendered.includes("{{") || rendered.includes("}}")) {
    throw new TemplateRenderError("malformed_placeholder", "Template contains a malformed placeholder.");
  }

  return rendered;
}

export function renderTemplate(
  source: TemplateSource,
  values: Readonly<Record<string, string>>,
): RenderedTemplate {
  const variables = normalizeTemplateVariables(source.variables);
  const allowedVariables = new Set(variables);
  const usedVariables = new Set<string>();

  return {
    subject:
      source.subject === null
        ? null
        : renderText(source.subject, allowedVariables, values, usedVariables),
    body: renderText(source.body, allowedVariables, values, usedVariables),
    usedVariables: [...usedVariables].sort(),
  };
}
