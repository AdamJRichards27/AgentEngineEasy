// AE GROW Pilot Readiness WP2a — summarizeErrorCause() (used when a strict
// audit failure is replaced by a typed fail-closed error) keeps only the
// error's class/code/message/constraint, never enumerable fields such as
// pg's `detail`, which can echo row values.

import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeErrorCause } from "../errorCause.js";

test("summarizeErrorCause keeps name/code/message/constraint and drops detail-like fields", () => {
  const pgLike = Object.assign(new Error("duplicate key value violates unique constraint \"audit_logs_pkey\""), {
    code: "23505",
    constraint: "audit_logs_pkey",
    detail: "Key (id)=(42) already exists. transcript: SENSITIVE_TRANSCRIPT_TEXT",
    parameters: ["SENSITIVE_PARAM"],
  });
  const summary = summarizeErrorCause(pgLike);
  assert.deepEqual(summary, {
    causeName: "Error",
    causeCode: "23505",
    causeMessage: "duplicate key value violates unique constraint \"audit_logs_pkey\"",
    causeConstraint: "audit_logs_pkey",
  });
  assert.doesNotMatch(JSON.stringify(summary), /SENSITIVE/);
});

test("summarizeErrorCause bounds long messages and handles non-Error values", () => {
  assert.equal(summarizeErrorCause(new Error("x".repeat(1000))).causeMessage.length, 300);
  assert.deepEqual(summarizeErrorCause("raw string with SENSITIVE text"), {
    causeName: "string",
    causeMessage: "non-Error value thrown",
  });
});
