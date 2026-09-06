import { test } from "node:test";
import assert from "node:assert/strict";
import { communicationsWebhookIngressConfigured } from "../communicationsWebhooks.js";

test("communications webhook ingress is disabled by default and when its secret is omitted", () => {
  assert.equal(communicationsWebhookIngressConfigured({}), false);
  assert.equal(communicationsWebhookIngressConfigured({ COMMUNICATIONS_WEBHOOK_INGRESS_ENABLED: "true" }), false);
  assert.equal(
    communicationsWebhookIngressConfigured({
      COMMUNICATIONS_WEBHOOK_INGRESS_ENABLED: "true",
      COMMUNICATIONS_WEBHOOK_SECRET: "   ",
    }),
    false,
  );
});

test("communications webhook ingress requires exact enablement plus a configured secret", () => {
  assert.equal(
    communicationsWebhookIngressConfigured({
      COMMUNICATIONS_WEBHOOK_INGRESS_ENABLED: "false",
      COMMUNICATIONS_WEBHOOK_SECRET: "test-only-secret",
    }),
    false,
  );
  assert.equal(
    communicationsWebhookIngressConfigured({
      COMMUNICATIONS_WEBHOOK_INGRESS_ENABLED: "true",
      COMMUNICATIONS_WEBHOOK_SECRET: "test-only-secret",
    }),
    true,
  );
});

test("the HTTP route is unavailable when enablement and secret are omitted", async () => {
  const priorEnabled = process.env.COMMUNICATIONS_WEBHOOK_INGRESS_ENABLED;
  const priorSecret = process.env.COMMUNICATIONS_WEBHOOK_SECRET;
  delete process.env.COMMUNICATIONS_WEBHOOK_INGRESS_ENABLED;
  delete process.env.COMMUNICATIONS_WEBHOOK_SECRET;
  const { createApp } = await import("../../app.js");
  const server = createApp().listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected server address");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/communications/webhooks/1/sandbox_email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: "must-not-run", eventType: "DELIVERY_RECEIPT" }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Webhook ingress is disabled." });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    if (priorEnabled === undefined) delete process.env.COMMUNICATIONS_WEBHOOK_INGRESS_ENABLED;
    else process.env.COMMUNICATIONS_WEBHOOK_INGRESS_ENABLED = priorEnabled;
    if (priorSecret === undefined) delete process.env.COMMUNICATIONS_WEBHOOK_SECRET;
    else process.env.COMMUNICATIONS_WEBHOOK_SECRET = priorSecret;
  }
});