// AE GROW Priority 6 Stage F1 — Call Foundation, inbound webhook surface.
//
// Deliberately unauthenticated (no session cookie — a provider callback
// carries no user session) but signature-verified on every request,
// mirroring routes/communicationsWebhooks.ts's own fail-closed
// enable+secret pattern and reusing lib/communications/webhooks.ts's
// verifyWebhookSignature/isWebhookTimestampFresh directly (§15) rather
// than re-implementing HMAC verification.
//
// F1 implements this ONLY for the sandbox provider — there is no real
// telephony provider to call back into this route in F1 at all (§10,
// §11). The provider is fixed to "sandbox" server-side, never taken from
// the URL or the request body, since no other provider exists yet.
//
// Tenant safety: brokerageId is NEVER read from this payload — the
// affected call session (and therefore its brokerageId) is resolved
// entirely from providerCallId, which is already globally unique (see
// sandboxProvider.ts). See lib/telephony/webhooks.ts's own header comment
// for the full reasoning on why this deliberately differs from
// communicationsWebhooksRouter's URL-embedded-brokerageId convention.

import { Router } from "express";
import { z } from "zod";
import { verifyWebhookSignature, isWebhookTimestampFresh } from "../lib/communications/webhooks.js";
import { processInboundTelephonyWebhook } from "../lib/telephony/webhooks.js";

export const growCallsWebhooksRouter = Router();

const SANDBOX_TELEPHONY_PROVIDER = "sandbox";

/** Fail closed: unavailable unless an operator has explicitly enabled it and supplied a secret out of band. */
export function growCallsWebhookIngressConfigured(
  env: NodeJS.ProcessEnv = process.env,
): env is NodeJS.ProcessEnv & { GROW_CALLS_WEBHOOK_SECRET: string } {
  return (
    env.GROW_CALLS_WEBHOOK_INGRESS_ENABLED === "true" &&
    typeof env.GROW_CALLS_WEBHOOK_SECRET === "string" &&
    env.GROW_CALLS_WEBHOOK_SECRET.trim().length > 0
  );
}

const sandboxWebhookSchema = z
  .object({
    eventId: z.string().min(1),
    eventType: z.enum(["call.ringing", "call.connected", "call.completed", "call.failed"]),
    providerCallId: z.string().min(1),
  })
  .passthrough();

growCallsWebhooksRouter.post("/grow/calls/webhooks/sandbox", async (req, res) => {
  if (!growCallsWebhookIngressConfigured(process.env)) {
    res.status(404).json({ error: "Webhook ingress is disabled." });
    return;
  }
  const webhookSecret = process.env.GROW_CALLS_WEBHOOK_SECRET;

  const signatureHeader = req.header("x-grow-calls-signature");
  const timestamp = req.header("x-grow-calls-timestamp");
  const rawBody = req.rawBody;
  if (!rawBody || !isWebhookTimestampFresh(timestamp) || !verifyWebhookSignature({ rawBody, timestamp, signatureHeader, secret: webhookSecret })) {
    res.status(401).json({ error: "Invalid or missing webhook signature." });
    return;
  }

  const parsed = sandboxWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid webhook payload." });
    return;
  }

  const result = await processInboundTelephonyWebhook({
    provider: SANDBOX_TELEPHONY_PROVIDER,
    providerEventId: parsed.data.eventId,
    eventType: parsed.data.eventType,
    providerCallId: parsed.data.providerCallId,
    payload: req.body as Record<string, unknown>,
  });

  res.status(result.status === "FAILED" ? 500 : 200).json(result);
});
