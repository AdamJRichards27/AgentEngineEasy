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
import { incrementCounter, observeHistogram } from "@aee/events";
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

// AE Step 2 closure — Part B: every inbound request is tracked through the
// SAME bounded outcome vocabulary the metrics catalogue declares
// (packages/events/src/metrics.ts's WEBHOOK_ROUTER_OUTCOMES) — never a
// providerEventId/brokerageId/destination label, so this can never become
// a cardinality or PII leak no matter how many tenants/providers send
// webhooks here. "received" and "accepted" are funnel counters; exactly
// one terminal outcome (invalid_signature/schema_rejected/replay_rejected/
// success/failure) is recorded per request, alongside its duration.
communicationsWebhooksRouter.post("/communications/webhooks/:brokerageId/:provider", async (req, res) => {
  const startedAt = Date.now();
  incrementCounter("communications_webhook_total", { outcome: "received" });
  const finish = (outcome: "invalid_signature" | "schema_rejected" | "replay_rejected" | "success" | "failure") => {
    incrementCounter("communications_webhook_total", { outcome });
    observeHistogram("communications_webhook_duration_ms", Date.now() - startedAt, { outcome });
  };

  const brokerageId = Number(req.params.brokerageId);
  const provider = req.params.provider;
  if (!Number.isInteger(brokerageId) || brokerageId <= 0) {
    finish("schema_rejected");
    return void res.status(400).json({ error: "Invalid brokerage id." });
  }

  const signatureHeader = req.header("x-communications-signature");
  const rawBody = req.rawBody;
  if (!rawBody || !verifyWebhookSignature({ rawBody, signatureHeader, secret: WEBHOOK_SECRET })) {
    finish("invalid_signature");
    return void res.status(401).json({ error: "Invalid or missing webhook signature." });
  }

  const parsed = inboundWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    finish("schema_rejected");
    return void res.status(400).json({ error: "Invalid webhook payload." });
  }

  incrementCounter("communications_webhook_total", { outcome: "accepted" });

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

  finish(result.status === "PROCESSED" ? "success" : result.status === "DUPLICATE" ? "replay_rejected" : "failure");
  res.status(result.status === "FAILED" ? 500 : 200).json(result);
});
