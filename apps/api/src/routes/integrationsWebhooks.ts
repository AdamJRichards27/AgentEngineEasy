// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
//
// Inbound webhook route — mounted OUTSIDE requireAuth (a provider callback
// carries no session cookie, mirrors communicationsWebhooksRouter/
// financialWebhooksRouter's own module comment), tenant-safe by URL
// (connectionId is resolved from the path, never trusted from the body),
// and signature-verified against the connection's own mock credential
// reference (never a generic shared secret). The exact raw bytes app.ts's
// express.json({verify}) hook captures onto req.rawBody are what gets
// HMAC'd — never a re-serialised copy of the parsed body (same discipline
// as communications' own webhook route).

import { Router } from "express";
import { z } from "zod";
import { getSecretIdentifierForSigning } from "../lib/integrations/credentials.js";
import { verifyWebhookSignature, processInboundWebhook, MAX_WEBHOOK_PAYLOAD_BYTES } from "../lib/integrations/webhooks.js";

export const integrationsWebhooksRouter = Router();

const webhookBodySchema = z.object({
  providerEventId: z.string().min(1),
  eventType: z.string().min(1),
  payload: z.record(z.unknown()),
});

integrationsWebhooksRouter.post("/integrations/webhooks/:connectionId/:provider", async (req, res) => {
  const { connectionId, provider } = req.params;

  const rawBody = (req as any).rawBody as Buffer | undefined;
  if (!rawBody || rawBody.byteLength > MAX_WEBHOOK_PAYLOAD_BYTES) {
    res.status(413).json({ error: "Payload too large or missing." });
    return;
  }

  const parsed = webhookBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const secret = await getSecretIdentifierForSigning(connectionId);
  const signatureValid = secret != null && verifyWebhookSignature({ rawBody, signatureHeader: req.header("x-integration-signature"), secret });

  try {
    const result = await processInboundWebhook({
      connectionId,
      provider,
      providerEventId: parsed.data.providerEventId,
      eventType: parsed.data.eventType,
      payload: parsed.data.payload,
      signatureValid,
    });
    // A rejected/duplicate/failed webhook still returns 200 to the
    // (mock) provider — providers retry on non-2xx, and a REJECTED
    // signature or DUPLICATE delivery is not something a redelivery would
    // ever fix; the outcome is fully recorded in integration_inbox
    // regardless (Section 6).
    res.status(200).json({ status: result.status, detail: result.detail });
  } catch (err) {
    // NOT_FOUND (unknown connectionId) and VALIDATION (oversized payload)
    // are the only throws processInboundWebhook makes before recording
    // anything — safe to answer with a real error status for those.
    res.status(400).json({ error: err instanceof Error ? err.message : "Webhook processing failed." });
  }
});
