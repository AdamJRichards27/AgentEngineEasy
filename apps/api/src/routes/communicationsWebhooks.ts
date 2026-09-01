// Agent Engine 2.0 — Communications Hub (Priority 8), inbound webhook
// surface (Section 19).
//
// Deliberately unauthenticated (no session cookie — a provider callback
// carries no user session) but signature-verified on every request, and
// tenant-scoped by URL: /communications/webhooks/:brokerageId/:provider.
// brokerageId here is the value THIS APP already validated and handed a
// provider account under — never something read out of the request body —
// which is what makes downstream processing tenant-safe (see
// lib/communications/webhooks.ts's own module comment).
//
// The body shape accepted here is a normalised sandbox/dev contract, not
// any particular real provider's native payload — a real provider
// integration (e.g. Mobile Message) needs its own small parser upstream of
// processInboundWebhook() that maps that provider's actual payload onto
// this same normalised shape; nothing about tenant-safety or idempotency
// changes when that parser is added.

import { Router } from "express";
import { z } from "zod";
import { processInboundWebhook, verifyWebhookSignature } from "../lib/communications/webhooks.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export const communicationsWebhooksRouter = Router();

// Sandbox/dev-only shared secret until a real per-provider credential store
// exists (Section 5: "no direct production provider activation without
// credentials or authorization"). Overridable via env for local testing.
const WEBHOOK_SECRET = process.env.COMMUNICATIONS_WEBHOOK_SECRET ?? "dev-sandbox-communications-webhook-secret";

const inboundWebhookSchema = z
  .object({
    eventId: z.string().min(1),
    eventType: z.enum(["DELIVERY_RECEIPT", "INBOUND_MESSAGE", "BOUNCE", "OPT_OUT"]),
    providerMessageId: z.string().optional(),
    destination: z.string().optional(),
    destinationChannel: z.enum(["EMAIL", "SMS"]).optional(),
  })
  .passthrough();

communicationsWebhooksRouter.post("/communications/webhooks/:brokerageId/:provider", async (req, res) => {
  const brokerageId = Number(req.params.brokerageId);
  const provider = req.params.provider;
  if (!Number.isInteger(brokerageId) || brokerageId <= 0) {
    return void res.status(400).json({ error: "Invalid brokerage id." });
  }

  const signatureHeader = req.header("x-communications-signature");
  const rawBody = req.rawBody;
  if (!rawBody || !verifyWebhookSignature({ rawBody, signatureHeader, secret: WEBHOOK_SECRET })) {
    return void res.status(401).json({ error: "Invalid or missing webhook signature." });
  }

  const parsed = inboundWebhookSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid webhook payload." });

  const result = await processInboundWebhook({
    brokerageId,
    provider,
    providerEventId: parsed.data.eventId,
    eventType: parsed.data.eventType,
    payload: req.body as Record<string, unknown>,
    providerMessageId: parsed.data.providerMessageId ?? null,
    destination: parsed.data.destination ?? null,
    destinationChannel: parsed.data.destinationChannel ?? null,
  });

  res.status(result.status === "FAILED" ? 500 : 200).json(result);
});
