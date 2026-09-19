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

// ---------------------------------------------------------------------
// AE GROW Pilot Readiness WP6a (D10) — retryable vs permanently-rejected.
//
// Every FAILED result used to be answered 500, which tells a real provider
// "this was our fault, send it again". For a permanently-unprocessable event
// — an unknown providerCallId, or a lifecycle transition that is invalid for
// the call session's current (often already-terminal) state — that is never
// true: the same payload will fail identically forever, so the provider
// retries on its full backoff schedule until it gives up, and the receipt row
// is re-touched on every attempt for nothing.
//
// The classification is done here, at the route level, rather than in
// lib/telephony/webhooks.ts, because this is an HTTP-transport concern (what
// status code makes THIS provider stop) and not a domain one — the lib layer
// already records the correct FAILED receipt and the reason for it either
// way, and this route reads that existing reason rather than introducing a
// second source of truth.
//
// lib/telephony/webhooks.ts produces a FAILED result in exactly three ways:
//   * the "no matching call session" branch, with its own fixed detail;
//   * a caught CallSessionTransitionError / GrowCallSessionValidationError,
//     whose own message is passed through as the detail;
//   * any other caught error, for which the detail is replaced by the single
//     generic RETRYABLE_FAILURE_DETAIL string below.
// So the generic string is the one and only marker of "something transient
// went wrong" (a database failure, a lock timeout, an unexpected fault); every
// other detail is, by construction, a typed permanent domain rejection. That
// is why the check below is written as "is it the generic string?" rather than
// as a list of permanent reasons: CallSessionTransitionError's message varies
// with the states involved, so there is no finite list of permanent strings to
// enumerate, while there is exactly one transient one.
//
// That makes this constant the single point of coupling to
// lib/telephony/webhooks.ts (a file this work package does not own), so it is
// pinned by a test that drives a real transient database failure end to end
// and asserts the response is still 500 — if that string ever drifts, the test
// fails rather than transient failures being quietly acknowledged as
// permanent. An absent detail is treated as retryable so a result shape
// without one keeps today's 500-and-retry behaviour.
// ---------------------------------------------------------------------

/** Must match the generic fallback detail in lib/telephony/webhooks.ts's catch block. */
export const RETRYABLE_FAILURE_DETAIL = "Unable to process telephony webhook. Please retry.";

/**
 * 422, not 500: the request was well-formed and correctly signed, and we
 * understood it — it simply cannot ever be applied. Providers stop retrying
 * on a 4xx; the body carries `retryable: false` explicitly so an operator
 * reading a delivery log does not have to infer intent from the status code.
 */
export const NON_RETRYABLE_STATUS = 422;

export function isRetryableWebhookFailure(detail: string | undefined): boolean {
  return detail === undefined || detail === RETRYABLE_FAILURE_DETAIL;
}

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

  try {
    const result = await processInboundTelephonyWebhook({
      provider: SANDBOX_TELEPHONY_PROVIDER,
      providerEventId: parsed.data.eventId,
      eventType: parsed.data.eventType,
      providerCallId: parsed.data.providerCallId,
      payload: req.body as Record<string, unknown>,
    });

    if (result.status !== "FAILED") {
      res.status(200).json(result);
      return;
    }
    // The receipt has already been recorded FAILED by
    // processInboundTelephonyWebhook in both branches — only the status code
    // (and therefore whether the provider will send this event again)
    // differs.
    if (isRetryableWebhookFailure(result.detail)) {
      res.status(500).json(result);
      return;
    }
    res.status(NON_RETRYABLE_STATUS).json({ ...result, retryable: false });
  } catch {
    // Express 4 does not handle rejected async handlers. Include receipt
    // SELECT/INSERT and failure-bookkeeping errors in this boundary; never
    // expose database diagnostics or acknowledge an uncommitted delivery.
    res.status(500).json({ status: "FAILED", detail: "Unable to process telephony webhook. Please retry." });
  }
});
