import { test } from "node:test";
import assert from "node:assert/strict";
import { getBillingProvider, resetBillingProviderCacheForTests } from "../gateway.js";

// Critical Blocker Remediation, Phase 10 — commercial lock verification.
//
// The AE Project Owner's explicit instruction for this remediation pass is
// "no automated subscription/direct-debit/PC success-fee/trust-money
// transaction authorised" and "test/sandbox modes only ... no real ...
// payment ... action authorised". This test exists to prove that instruction
// holds even when a real-looking Stripe credential is present in the
// environment — the exact scenario an operator accidentally carrying over
// Secrets from another deployment would create — not just when credentials
// happen to be absent (which apps/api/src/lib/billing/gateway.ts already
// handled correctly before this phase).
//
// No database access here — getBillingProvider()/loadBillingGatewayConfig()
// touch only process.env and construct plain provider objects, so this runs
// standalone. Every mutated env var is restored in `after` so this file's
// own state never leaks between its own tests (each test file node:test
// runs gets its own process, so this cannot leak into other test files
// either).

const ENV_KEYS = ["NODE_ENV", "BILLING_PROVIDER", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "LIVE_EXTERNAL_TRANSACTIONS_APPROVED"] as const;

function snapshotEnv(): Record<(typeof ENV_KEYS)[number], string | undefined> {
  const snapshot = {} as Record<(typeof ENV_KEYS)[number], string | undefined>;
  for (const key of ENV_KEYS) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreEnv(snapshot: Record<(typeof ENV_KEYS)[number], string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

test("getBillingProvider: a real STRIPE_SECRET_KEY in production is NOT enough on its own to activate real billing", async (t) => {
  const before = snapshotEnv();
  t.after(() => {
    restoreEnv(before);
    resetBillingProviderCacheForTests();
  });

  process.env.NODE_ENV = "production";
  process.env.BILLING_PROVIDER = "stripe";
  process.env.STRIPE_SECRET_KEY = "sk_test_looks_real_but_pilot_lock_must_still_apply";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_looks_real_but_pilot_lock_must_still_apply";
  delete process.env.LIVE_EXTERNAL_TRANSACTIONS_APPROVED;
  resetBillingProviderCacheForTests();

  const provider = getBillingProvider();

  assert.equal(provider.name, "mock", "a fully-credentialed stripe request must still be forced to mock while LIVE_EXTERNAL_TRANSACTIONS_APPROVED is unset in production");
});

test("getBillingProvider: setting LIVE_EXTERNAL_TRANSACTIONS_APPROVED=true restores real provider selection in production", async (t) => {
  const before = snapshotEnv();
  t.after(() => {
    restoreEnv(before);
    resetBillingProviderCacheForTests();
  });

  process.env.NODE_ENV = "production";
  process.env.BILLING_PROVIDER = "stripe";
  process.env.STRIPE_SECRET_KEY = "sk_test_explicitly_approved";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_explicitly_approved";
  process.env.LIVE_EXTERNAL_TRANSACTIONS_APPROVED = "true";
  resetBillingProviderCacheForTests();

  const provider = getBillingProvider();

  assert.equal(provider.name, "stripe", "an explicit LIVE_EXTERNAL_TRANSACTIONS_APPROVED=true must let a fully-credentialed stripe request through, matching pre-Phase-10 behaviour");
});

test("getBillingProvider: outside production, the pilot lock never applies (pre-existing dev/test behaviour is unchanged)", async (t) => {
  const before = snapshotEnv();
  t.after(() => {
    restoreEnv(before);
    resetBillingProviderCacheForTests();
  });

  delete process.env.NODE_ENV; // matches CI/local test runs, which never set NODE_ENV=production
  process.env.BILLING_PROVIDER = "stripe";
  process.env.STRIPE_SECRET_KEY = "sk_test_dev";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_dev";
  delete process.env.LIVE_EXTERNAL_TRANSACTIONS_APPROVED;
  resetBillingProviderCacheForTests();

  const provider = getBillingProvider();

  assert.equal(provider.name, "stripe", "the Phase 10 lock is production-only — a developer pointing BILLING_PROVIDER at stripe locally/in CI must not be silently overridden");
});

test("getBillingProvider: BILLING_PROVIDER=mock (the safe default) is completely unaffected by the lock either way", async (t) => {
  const before = snapshotEnv();
  t.after(() => {
    restoreEnv(before);
    resetBillingProviderCacheForTests();
  });

  process.env.NODE_ENV = "production";
  process.env.BILLING_PROVIDER = "mock";
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.LIVE_EXTERNAL_TRANSACTIONS_APPROVED;
  resetBillingProviderCacheForTests();

  const provider = getBillingProvider();

  assert.equal(provider.name, "mock");
});
