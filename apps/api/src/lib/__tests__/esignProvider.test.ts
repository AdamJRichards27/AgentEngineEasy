import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, test } from "node:test";
import {
  HttpESignProvider,
  MockESignProvider,
  assertESignProviderConfigured,
  createESignProvider,
  isESignWebhookProcessingEnabled,
} from "@aee/integration-esign";

const ENV_KEYS = [
  "NODE_ENV",
  "LIVE_EXTERNAL_TRANSACTIONS_APPROVED",
  "ESIGN_PROVIDER",
  "ESIGN_API_BASE_URL",
  "ESIGN_PROVIDER_API_KEY",
  "ESIGN_WEBHOOK_SECRET",
] as const;
const originalEnvironment = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("mock callbacks require a valid HMAC signature", () => {
  process.env.ESIGN_WEBHOOK_SECRET =
    "test-only-esign-webhook-secret-not-for-real-use-0123456789";
  const provider = new MockESignProvider();
  const payload = Buffer.from('{"status":"Completed"}');
  const signature = createHmac(
    "sha256",
    process.env.ESIGN_WEBHOOK_SECRET,
  )
    .update(payload)
    .digest("hex");

  assert.equal(provider.verifyWebhookSignature(payload, ""), false);
  assert.equal(provider.verifyWebhookSignature(payload, "invalid"), false);
  assert.equal(provider.verifyWebhookSignature(payload, signature), true);
});

test("production-disabled mode forces mock outbound behavior and disables webhook processing", () => {
  process.env.NODE_ENV = "production";
  process.env.ESIGN_PROVIDER = "http";
  delete process.env.LIVE_EXTERNAL_TRANSACTIONS_APPROVED;
  const provider = createESignProvider();

  assert.equal(provider.kind, "mock");
  assert.equal(isESignWebhookProcessingEnabled(provider), false);
  assert.doesNotThrow(() => assertESignProviderConfigured());
});

test("approved production e-sign fails closed unless the real HMAC provider is complete", () => {
  process.env.NODE_ENV = "production";
  process.env.LIVE_EXTERNAL_TRANSACTIONS_APPROVED = "true";
  process.env.ESIGN_PROVIDER = "mock";
  assert.throws(() => createESignProvider(), /ESIGN_PROVIDER is not http/);

  process.env.ESIGN_PROVIDER = "http";
  process.env.ESIGN_API_BASE_URL = "http://esign.example.test";
  process.env.ESIGN_PROVIDER_API_KEY = "test-provider-key";
  process.env.ESIGN_WEBHOOK_SECRET =
    "test-only-esign-webhook-secret-not-for-real-use-0123456789";
  assert.throws(() => createESignProvider(), /must be an HTTPS URL/);

  process.env.ESIGN_API_BASE_URL = "https://esign.example.test";
  delete process.env.ESIGN_PROVIDER_API_KEY;
  assert.throws(() => createESignProvider(), /ESIGN_PROVIDER_API_KEY/);

  process.env.ESIGN_PROVIDER_API_KEY = "test-provider-key";
  process.env.ESIGN_WEBHOOK_SECRET = "too-short";
  assert.throws(() => createESignProvider(), /at least 32 characters/);
});

test("approved production uses the HTTP provider and validates exact raw-body HMAC", () => {
  process.env.NODE_ENV = "production";
  process.env.LIVE_EXTERNAL_TRANSACTIONS_APPROVED = "true";
  process.env.ESIGN_PROVIDER = "http";
  process.env.ESIGN_API_BASE_URL = "https://esign.example.test";
  process.env.ESIGN_PROVIDER_API_KEY = "test-provider-key";
  process.env.ESIGN_WEBHOOK_SECRET =
    "test-only-esign-webhook-secret-not-for-real-use-0123456789";
  const provider = createESignProvider();
  const payload = Buffer.from('{"status":"Completed","id":"env-123"}');
  const signature = createHmac(
    "sha256",
    process.env.ESIGN_WEBHOOK_SECRET,
  )
    .update(payload)
    .digest("hex");

  assert.ok(provider instanceof HttpESignProvider);
  assert.equal(provider.kind, "http");
  assert.equal(isESignWebhookProcessingEnabled(provider), true);
  assert.equal(provider.verifyWebhookSignature(payload, signature), true);
  assert.equal(
    provider.verifyWebhookSignature(
      Buffer.from('{"id":"env-123","status":"Completed"}'),
      signature,
    ),
    false,
  );
});