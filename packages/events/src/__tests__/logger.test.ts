// Agent Engine 2.0 — Step 2: Security & Observability Hardening.
//
// Proves the structured logger: every entry is well-formed JSON with the
// required timestamp/level/message shape, fields are redacted before they
// ever reach buildLogEntry's output (not just "usually" — this is the
// contract logger.ts's module comment makes), and the ambient
// correlationId/causationId from context.ts are attached automatically
// without the caller having to pass them in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLogEntry } from "../logger.js";
import { runWithCorrelationId } from "../context.js";

test("buildLogEntry produces the required timestamp/level/message shape", () => {
  const entry = buildLogEntry("info", "something_happened");
  assert.equal(entry.level, "info");
  assert.equal(entry.message, "something_happened");
  assert.ok(typeof entry.timestamp === "string");
  assert.ok(!Number.isNaN(Date.parse(entry.timestamp)), "timestamp should be a parseable ISO string");
});

test("buildLogEntry serialises to valid single-line JSON with no undefined leaking through", () => {
  const entry = buildLogEntry("warn", "test_event", { brokerageId: 1, note: "fine" });
  const line = JSON.stringify(entry);
  assert.doesNotThrow(() => JSON.parse(line));
  assert.ok(!line.includes("\n"), "a log line must never contain an embedded newline");
});

test("buildLogEntry omits correlationId/causationId entirely when no context is active, rather than emitting null/undefined keys", () => {
  const entry = buildLogEntry("info", "no_context_event");
  assert.equal("correlationId" in entry, false);
  assert.equal("causationId" in entry, false);
});

test("buildLogEntry attaches the ambient correlationId automatically", () => {
  const id = "99999999-9999-9999-9999-999999999999";
  const entry = runWithCorrelationId(id, () => buildLogEntry("info", "with_context_event"));
  assert.equal(entry.correlationId, id);
});

test("buildLogEntry attaches the ambient causationId when one is set", () => {
  const entry = runWithCorrelationId(
    "aaaaaaaa-1111-1111-1111-111111111111",
    () => buildLogEntry("info", "with_causation_event"),
    "predecessor-id",
  );
  assert.equal(entry.causationId, "predecessor-id");
});

test("buildLogEntry redacts never-log fields before they reach the entry — this is the whole point of routing every call through here", () => {
  const entry = buildLogEntry("error", "login_failed", { userId: 42, password: "hunter2", sessionSecret: "abc" });
  assert.equal(entry.userId, 42);
  assert.equal(entry.password, "[REDACTED]");
  assert.equal(entry.sessionSecret, "[REDACTED]");
});

test("buildLogEntry redacts fields nested inside a passed object, not just top-level ones", () => {
  const entry = buildLogEntry("error", "webhook_failed", {
    provider: "mock_payment_status_v1",
    request: { headers: { authorization: "Bearer sk_live_abc123456789" } },
  });
  const request = entry.request as any;
  assert.equal(request.headers.authorization, "[REDACTED]");
  assert.equal(entry.provider, "mock_payment_status_v1");
});

test("message and level are never themselves subject to redaction (they are not user-controlled field data)", () => {
  const entry = buildLogEntry("info", "password_reset_requested");
  assert.equal(entry.message, "password_reset_requested");
});

test("fields object passed to buildLogEntry is not mutated in place", () => {
  const fields = { password: "hunter2" };
  buildLogEntry("info", "event", fields);
  assert.equal(fields.password, "hunter2", "redaction must operate on a copy, never mutate the caller's object");
});
