// Agent Engine 2.0 — Communications Hub (Priority 8).
// Pure-function tests for the message-status transition table and its
// small classification/retry helpers — no DB, no server (mirrors
// lib/pitCrew/__tests__/types.test.ts's style).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMUNICATION_MESSAGE_STATUS_TRANSITIONS,
  isValidCommunicationStatusTransition,
  isRetryableFailure,
  isDispatchedChannel,
  isInternalOnlyChannel,
  consentChannelFor,
  IN_FLIGHT_MESSAGE_STATUSES,
  TERMINAL_FAILURE_STATUSES,
  COMMUNICATION_MESSAGE_STATUSES,
} from "../types.js";

test("every status in the transition table is a declared status, and every transition target is too", () => {
  for (const status of COMMUNICATION_MESSAGE_STATUSES) {
    assert.ok(status in COMMUNICATION_MESSAGE_STATUS_TRANSITIONS, `${status} is missing from the transition table`);
    for (const target of COMMUNICATION_MESSAGE_STATUS_TRANSITIONS[status]) {
      assert.ok(COMMUNICATION_MESSAGE_STATUSES.includes(target), `${status} -> ${target} names an undeclared status`);
    }
  }
});

test("DRAFT can reach QUEUED directly (no approval required by the state machine itself)", () => {
  assert.equal(isValidCommunicationStatusTransition("DRAFT", "QUEUED"), true);
});

test("SENT != DELIVERED — SENT can become DELIVERED, FAILED, BOUNCED, or UNDELIVERABLE, never back to an earlier state", () => {
  assert.equal(isValidCommunicationStatusTransition("SENT", "DELIVERED"), true);
  assert.equal(isValidCommunicationStatusTransition("SENT", "QUEUED"), false);
  assert.equal(isValidCommunicationStatusTransition("SENT", "DRAFT"), false);
});

test("RECEIVED, BOUNCED, UNDELIVERABLE, CANCELLED are all terminal (no outbound transitions)", () => {
  for (const terminal of ["RECEIVED", "BOUNCED", "UNDELIVERABLE", "CANCELLED"] as const) {
    assert.deepEqual(COMMUNICATION_MESSAGE_STATUS_TRANSITIONS[terminal], []);
  }
});

test("DELIVERED is not fully terminal — a late-reported bounce can still move it to BOUNCED, nothing else", () => {
  assert.deepEqual(COMMUNICATION_MESSAGE_STATUS_TRANSITIONS.DELIVERED, ["BOUNCED"]);
  assert.equal(isValidCommunicationStatusTransition("DELIVERED", "BOUNCED"), true);
  assert.equal(isValidCommunicationStatusTransition("DELIVERED", "SENT"), false);
  assert.equal(isValidCommunicationStatusTransition("DELIVERED", "FAILED"), false);
});

test("FAILED can only move to RETRY_SCHEDULED — never silently back to SENDING", () => {
  assert.deepEqual(COMMUNICATION_MESSAGE_STATUS_TRANSITIONS.FAILED, ["RETRY_SCHEDULED"]);
  assert.equal(isValidCommunicationStatusTransition("FAILED", "SENDING"), false);
});

test("BLOCKED_BY_CONSENT and BLOCKED_BY_COST_CONTROL can both be requeued or cancelled, nothing else", () => {
  assert.deepEqual(COMMUNICATION_MESSAGE_STATUS_TRANSITIONS.BLOCKED_BY_CONSENT, ["QUEUED", "CANCELLED"]);
  assert.deepEqual(COMMUNICATION_MESSAGE_STATUS_TRANSITIONS.BLOCKED_BY_COST_CONTROL, ["QUEUED", "CANCELLED"]);
});

test("an arbitrary invalid jump (DRAFT -> DELIVERED) is rejected", () => {
  assert.equal(isValidCommunicationStatusTransition("DRAFT", "DELIVERED"), false);
});

test("isRetryableFailure recognises only the declared retryable categories", () => {
  assert.equal(isRetryableFailure("PROVIDER_TIMEOUT"), true);
  assert.equal(isRetryableFailure("RATE_LIMITED"), true);
  assert.equal(isRetryableFailure("INVALID_DESTINATION"), false);
  assert.equal(isRetryableFailure("UNSUBSCRIBED"), false);
  assert.equal(isRetryableFailure(null), false);
  assert.equal(isRetryableFailure(undefined), false);
  assert.equal(isRetryableFailure("SOME_UNKNOWN_CATEGORY"), false);
});

test("channel helpers: EMAIL/SMS are dispatched, PHONE_CALL/EXTERNAL_MESSAGE are record-only, INTERNAL_NOTE is internal-only", () => {
  assert.equal(isDispatchedChannel("EMAIL"), true);
  assert.equal(isDispatchedChannel("SMS"), true);
  assert.equal(isDispatchedChannel("PHONE_CALL"), false);
  assert.equal(isDispatchedChannel("EXTERNAL_MESSAGE"), false);
  assert.equal(isDispatchedChannel("INTERNAL_NOTE"), false);
  assert.equal(isInternalOnlyChannel("INTERNAL_NOTE"), true);
  assert.equal(isInternalOnlyChannel("EMAIL"), false);
});

test("consentChannelFor maps EMAIL/SMS onto themselves and everything else to null", () => {
  assert.equal(consentChannelFor("EMAIL"), "EMAIL");
  assert.equal(consentChannelFor("SMS"), "SMS");
  assert.equal(consentChannelFor("PHONE_CALL"), null);
  assert.equal(consentChannelFor("EXTERNAL_MESSAGE"), null);
  assert.equal(consentChannelFor("INTERNAL_NOTE"), null);
});

test("IN_FLIGHT_MESSAGE_STATUSES and TERMINAL_FAILURE_STATUSES are disjoint and both subsets of the declared statuses", () => {
  for (const status of IN_FLIGHT_MESSAGE_STATUSES) {
    assert.ok(COMMUNICATION_MESSAGE_STATUSES.includes(status));
    assert.ok(!TERMINAL_FAILURE_STATUSES.includes(status));
  }
  for (const status of TERMINAL_FAILURE_STATUSES) {
    assert.ok(COMMUNICATION_MESSAGE_STATUSES.includes(status));
  }
});
