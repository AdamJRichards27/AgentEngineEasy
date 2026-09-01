// Agent Engine 2.0 — Communications Hub (Priority 8).
// Pure-function tests for the placeholder allow-list and template
// rendering (Section 14) — no DB, no server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPlaceholderTokens, assertPlaceholdersDeclared, renderTemplate, CommunicationTemplateError } from "../templates.js";

test("extractPlaceholderTokens finds every {{token}} across subject/body/html, deduplicated", () => {
  const tokens = extractPlaceholderTokens("Hello {{agent.firstName}}", "Body mentions {{property.address}} twice: {{property.address}}", "<p>{{agent.firstName}}</p>");
  assert.deepEqual([...tokens].sort(), ["agent.firstName", "property.address"]);
});

test("extractPlaceholderTokens tolerates missing/null parts", () => {
  assert.deepEqual(extractPlaceholderTokens(null, undefined, "no tokens here"), []);
});

test("assertPlaceholdersDeclared passes when every used token is declared", () => {
  assert.doesNotThrow(() =>
    assertPlaceholdersDeclared({ subject: "Hi {{agent.firstName}}", bodyText: "Re: {{property.address}}", bodyHtml: null }, ["agent.firstName", "property.address"]),
  );
});

test("assertPlaceholdersDeclared throws naming the undeclared token(s)", () => {
  assert.throws(
    () => assertPlaceholdersDeclared({ subject: null, bodyText: "Re: {{property.address}}", bodyHtml: null }, ["agent.firstName"]),
    (err: unknown) => err instanceof CommunicationTemplateError && /property\.address/.test((err as Error).message),
  );
});

test("renderTemplate substitutes every declared placeholder with the supplied value", () => {
  const rendered = renderTemplate(
    { subject: "Update on {{property.address}}", bodyText: "Hi {{buyer.firstName}}, your offer on {{property.address}} was accepted.", bodyHtml: null, placeholders: ["property.address", "buyer.firstName"] },
    { "property.address": "12 Test St", "buyer.firstName": "Bob" },
  );
  assert.equal(rendered.subject, "Update on 12 Test St");
  assert.equal(rendered.bodyText, "Hi Bob, your offer on 12 Test St was accepted.");
  assert.equal(rendered.bodyHtml, null);
});

test("renderTemplate throws when a declared, used placeholder has no supplied value", () => {
  assert.throws(
    () => renderTemplate({ subject: null, bodyText: "Hi {{buyer.firstName}}", bodyHtml: null, placeholders: ["buyer.firstName"] }, {}),
    (err: unknown) => err instanceof CommunicationTemplateError && /buyer\.firstName/.test((err as Error).message),
  );
});

test("renderTemplate refuses to render content that uses an undeclared placeholder, even if a value happens to be supplied for it", () => {
  assert.throws(
    () =>
      renderTemplate({ subject: null, bodyText: "Hi {{buyer.firstName}}", bodyHtml: null, placeholders: [] }, { "buyer.firstName": "Bob" }),
    CommunicationTemplateError,
  );
});

test("renderTemplate never leaves a raw {{...}} token in the output for a fully-declared, fully-supplied template", () => {
  const rendered = renderTemplate(
    { subject: null, bodyText: "{{a}}{{b}}{{a}}", bodyHtml: null, placeholders: ["a", "b"] },
    { a: "X", b: "Y" },
  );
  assert.equal(rendered.bodyText, "XYX");
  assert.doesNotMatch(rendered.bodyText, /\{\{/);
});
