import assert from "node:assert/strict";
import test from "node:test";

import { renderTemplate, TemplateRenderError } from "../lib/campaigns/template";

test("renders only explicitly declared variables in deterministic order", () => {
  const rendered = renderTemplate(
    {
      subject: "Invitation for {{ full_name }}",
      body: "Join {{event_title}} at {{venue}}. Ref: {{literal_value}}",
      variables: ["venue", "full_name", "literal_value", "event_title"],
    },
    {
      full_name: "Ada Lovelace",
      event_title: "Marat Test Event",
      venue: "Demo Hall",
      literal_value: "${this is never evaluated}",
    },
  );

  assert.deepEqual(rendered, {
    subject: "Invitation for Ada Lovelace",
    body: "Join Marat Test Event at Demo Hall. Ref: ${this is never evaluated}",
    usedVariables: ["event_title", "full_name", "literal_value", "venue"],
  });
});

test("fails closed for missing, undeclared, malformed, and duplicate variables", () => {
  assert.throws(
    () => renderTemplate({ subject: null, body: "Hi {{full_name}}", variables: ["full_name"] }, {}),
    (error) => error instanceof TemplateRenderError && error.code === "missing_variable",
  );
  assert.throws(
    () => renderTemplate({ subject: null, body: "Hi {{nickname}}", variables: ["full_name"] }, { nickname: "Ada" }),
    (error) => error instanceof TemplateRenderError && error.code === "undeclared_variable",
  );
  assert.throws(
    () => renderTemplate({ subject: null, body: "Hi {{full_name", variables: ["full_name"] }, { full_name: "Ada" }),
    (error) => error instanceof TemplateRenderError && error.code === "malformed_placeholder",
  );
  assert.throws(
    () => renderTemplate({ subject: null, body: "Hi", variables: ["full_name", "full_name"] }, {}),
    (error) => error instanceof TemplateRenderError && error.code === "duplicate_variable",
  );
});
