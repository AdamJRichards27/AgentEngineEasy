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
import { logger } from "@aee/events";
import { getSecretIdentifierForSigning } from "../lib/integrations/credentials.js";
import { verifyWebhookSignature, processInboundWebhook, MAX_WEBHOOK_PAYLOAD_BYTES } from "../lib/integrations/webhooks.js";
import { IntegrationError } from "../lib/integrations/types.js";

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

  try {
    // AE Step 2 closure — Part C (typed-error-handling audit): this
    // signature/secret lookup used to sit OUTSIDE this try block, awaited
    // directly in the async handler with nothing catching a rejection.
    // connectionId comes straight from the URL path with no format
    // pre-check, and both this lookup and processInboundWebhook's own
    // first query compare it against a `uuid` column — a non-UUID-shaped
    // connectionId (trivially sent by any caller, since this route is
    // deliberately unauthenticated) makes Postgres throw
    // "invalid input syntax for type uuid", and with nothing to catch
    // that rejection, the request hung forever: the exact same bug class
    // this closure pass already found and fixed once in
    // routes/financialWebhooks.ts's parseWebhook() call. Moving this
    // inside the try block closes it here too — proven by
    // routes/__tests__/integrationsWebhooks.test.ts's non-UUID-connectionId
    // test, which hung indefinitely against the pre-fix code.
    const secret = await getSecretIdentifierForSigning(connectionId);
    const signatureValid = secret != null && verifyWebhookSignature({ rawBody, signatureHeader: req.header("x-integration-signature"), secret });

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
    // AE Step 2 closure — Part C (typed-error-handling audit): this
    // previously logged nothing and returned ANY caught Error's own
    // `.message` to the (unauthenticated, provider-facing) caller — safe
    // for the two documented, deliberate IntegrationError throws
    // (NOT_FOUND for an unknown connectionId, VALIDATION for an oversized
    // payload), but processInboundWebhook also has at least one plain
    // `throw new Error(...)` defensive assertion (lib/integrations/
    // webhooks.ts, the "Failed to record inbound integration webhook
    // event" race-condition guard) that isn't an IntegrationError, and any
    // future unanticipated throw in that function would have leaked its
    // raw message here too, to a caller this route doesn't even
    // authenticate. Now: full detail always logged server-side (redacted,
    // like every other structured log line); only a recognised
    // IntegrationError's own deliberately-safe message is echoed back —
    // everything else gets a generic message instead.
    logger.error("integration_webhook_route_failed", { error: err });
    if (err instanceof IntegrationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: "Webhook processing failed." });
  }
});
