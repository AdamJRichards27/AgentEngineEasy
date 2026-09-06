import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  isWebhookTimestampFresh as integrationTimestampFresh,
  verifyWebhookSignature as verifyIntegrationSignature,
} from "../webhooks.js";
import {
  isWebhookTimestampFresh as communicationsTimestampFresh,
  verifyWebhookSignature as verifyCommunicationsSignature,
} from "../../communications/webhooks.js";

const secret = "sandbox-webhook-test-secret";
const rawBody = Buffer.from('{"eventId":"sandbox-event","eventType":"DELIVERY_RECEIPT"}');
const timestamp = String(Math.floor(Date.now() / 1_000));
const signature = createHmac("sha256", secret).update(timestamp).update(".").update(rawBody).digest("hex");

test("generic and communications signatures bind timestamp to the exact raw body", () => {
  for (const verify of [verifyIntegrationSignature, verifyCommunicationsSignature]) {
    assert.equal(verify({ rawBody, timestamp, signatureHeader: signature, secret }), true);
    assert.equal(verify({ rawBody, timestamp: String(Number(timestamp) + 1), signatureHeader: signature, secret }), false);
    assert.equal(verify({ rawBody: Buffer.from('{"eventId":"tampered"}'), timestamp, signatureHeader: signature, secret }), false);
    assert.equal(verify({ rawBody, timestamp: undefined, signatureHeader: signature, secret }), false);
  }
});

test("generic and communications timestamp validation rejects expired and future callbacks", () => {
  for (const fresh of [integrationTimestampFresh, communicationsTimestampFresh]) {
    assert.equal(fresh(timestamp), true);
    assert.equal(fresh(String(Math.floor((Date.now() - 6 * 60_000) / 1_000))), false);
    assert.equal(fresh(String(Math.floor((Date.now() + 6 * 60_000) / 1_000))), false);
    assert.equal(fresh("not-a-timestamp"), false);
  }
});