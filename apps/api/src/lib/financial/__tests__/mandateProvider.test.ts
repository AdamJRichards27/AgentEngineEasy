import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SandboxMandatePaymentProvider } from "@aee/integration-mandate-payments";

// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage D.
//
// Provider contract tests (Section 35.B) for the MandatePaymentProvider
// interface, exercised against the only implementation this build ships —
// SandboxMandatePaymentProvider. Pure: no database, no HTTP.

describe("SandboxMandatePaymentProvider — scheduleDebit", () => {
  test("returns a Scheduled result with a providerRequestRef and a future scheduledFor", async () => {
    const provider = new SandboxMandatePaymentProvider();
    const result = await provider.scheduleDebit({
      mandateProviderRef: "mandate-1",
      amountCents: 50_000,
      currency: "AUD",
      idempotencyKey: "key-1",
      description: "test debit",
    });
    assert.equal(result.status, "Scheduled");
    assert.ok(result.providerRequestRef.length > 0);
    assert.ok(result.scheduledFor && result.scheduledFor.getTime() > Date.now());
  });

  test("replays the same providerRequestRef for a repeated idempotencyKey instead of scheduling a second debit", async () => {
    const provider = new SandboxMandatePaymentProvider();
    const first = await provider.scheduleDebit({
      mandateProviderRef: "mandate-1",
      amountCents: 50_000,
      currency: "AUD",
      idempotencyKey: "key-replay",
      description: "test debit",
    });
    const second = await provider.scheduleDebit({
      mandateProviderRef: "mandate-1",
      amountCents: 50_000,
      currency: "AUD",
      idempotencyKey: "key-replay",
      description: "test debit",
    });
    assert.equal(second.providerRequestRef, first.providerRequestRef);
  });

  test("a different idempotencyKey schedules a genuinely separate debit", async () => {
    const provider = new SandboxMandatePaymentProvider();
    const first = await provider.scheduleDebit({ mandateProviderRef: "mandate-1", amountCents: 50_000, currency: "AUD", idempotencyKey: "key-a", description: "a" });
    const second = await provider.scheduleDebit({ mandateProviderRef: "mandate-1", amountCents: 50_000, currency: "AUD", idempotencyKey: "key-b", description: "b" });
    assert.notEqual(first.providerRequestRef, second.providerRequestRef);
  });
});

describe("SandboxMandatePaymentProvider — cancelScheduledDebit", () => {
  test("cancels a Scheduled debit without error", async () => {
    const provider = new SandboxMandatePaymentProvider();
    const { providerRequestRef } = await provider.scheduleDebit({ mandateProviderRef: "mandate-1", amountCents: 10_000, currency: "AUD", idempotencyKey: "key-cancel", description: "d" });
    await provider.cancelScheduledDebit(providerRequestRef);
  });

  test("cancelling an already-cancelled (unknown) providerRequestRef throws", async () => {
    const provider = new SandboxMandatePaymentProvider();
    const { providerRequestRef } = await provider.scheduleDebit({ mandateProviderRef: "mandate-1", amountCents: 10_000, currency: "AUD", idempotencyKey: "key-cancel-2", description: "d" });
    await provider.cancelScheduledDebit(providerRequestRef);
    await assert.rejects(() => provider.cancelScheduledDebit(providerRequestRef));
  });

  test("cancelling an entirely unknown providerRequestRef throws", async () => {
    const provider = new SandboxMandatePaymentProvider();
    await assert.rejects(() => provider.cancelScheduledDebit("no-such-ref"));
  });
});

describe("SandboxMandatePaymentProvider — reverseDebit", () => {
  test("reverses a known debit without error", async () => {
    const provider = new SandboxMandatePaymentProvider();
    const { providerRequestRef } = await provider.scheduleDebit({ mandateProviderRef: "mandate-1", amountCents: 10_000, currency: "AUD", idempotencyKey: "key-reverse", description: "d" });
    await provider.reverseDebit(providerRequestRef, 10_000, "test reversal");
  });

  test("reversing an unknown providerRequestRef throws", async () => {
    const provider = new SandboxMandatePaymentProvider();
    await assert.rejects(() => provider.reverseDebit("no-such-ref", 10_000, "test"));
  });
});

describe("SandboxMandatePaymentProvider — webhooks", () => {
  test("verifyWebhookSignature always trusts the sandbox (no real webhook traffic reaches it)", () => {
    const provider = new SandboxMandatePaymentProvider();
    assert.equal(provider.verifyWebhookSignature(), true);
  });

  test("parseWebhook round-trips a well-formed payload", () => {
    const provider = new SandboxMandatePaymentProvider();
    const payload = { providerEventId: "evt-1", providerRequestRef: "sandbox-debit-1", status: "Paid" as const };
    const result = provider.parseWebhook(payload);
    assert.deepEqual(result, { providerEventId: "evt-1", providerRequestRef: "sandbox-debit-1", status: "Paid", failureReason: undefined, disputeReason: undefined });
  });

  test("parseWebhook rejects a malformed payload missing required fields", () => {
    const provider = new SandboxMandatePaymentProvider();
    assert.throws(() => provider.parseWebhook({ status: "Paid" }), /providerEventId, providerRequestRef and status are all required/);
  });
});
