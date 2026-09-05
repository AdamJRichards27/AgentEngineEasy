// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage E.
//
// Inbound mandate-payment-provider webhook HTTP surface — the route Stage
// D's lib/financial/paymentWebhooks.ts (processMandatePaymentWebhook) was
// always meant to sit behind. Deliberately unauthenticated (no session
// cookie — a provider callback carries no user session), mirroring
// routes/communicationsWebhooks.ts exactly, but signature verification
// happens inside processMandatePaymentWebhook itself (it already calls
// mandatePaymentProvider.verifyWebhookSignature) rather than a second time
// here, since — unlike the communications webhook, which is tenant-scoped
// by URL — the mandate provider has no per-brokerage credential in this
// build (Section 31: no real bank-debit vendor is procured), so there is
// no brokerageId to validate a signature against at the route layer.
//
// Not mounted behind financialRouter's requireRole(...BROKERAGE_ADMIN_ROLES)
// gate — a provider webhook has no session, so it cannot carry that role.

import { Router } from "express";
import { incrementCounter, observeHistogram, logger } from "@aee/events";
import { processMandatePaymentWebhook } from "../lib/financial/paymentWebhooks.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export const financialWebhooksRouter = Router();

// AE Step 2 closure — Part B: same bounded outcome vocabulary and
// receipt/accepted/terminal-outcome/duration funnel as
// routes/communicationsWebhooks.ts — see that file's own comment for the
// cardinality/PII rationale, identical here. processMandatePaymentWebhook
// verifies the signature BEFORE inserting/mutating anything (Section 31),
// so a rejected outcome below is confirmed never to have written a row —
// see routes/__tests__/financialWebhooks.test.ts.
//
// mandatePaymentProvider.parseWebhook(payload) can throw on a malformed
// body (it is not itself defensive against garbage input) — previously
// nothing here caught that, so a malformed delivery would reject this
// route's returned promise with no response ever sent, hanging the
// request indefinitely (Express 4 does not catch an async handler's
// rejection). Wrapping the call classifies that case as schema_rejected,
// matching how routes/communicationsWebhooks.ts already treats a
// zod-rejected payload, and actually sends a response.
financialWebhooksRouter.post("/financial/webhooks/mandate-payments", async (req, res) => {
  const startedAt = Date.now();
  incrementCounter("financial_webhook_total", { outcome: "received" });
  const finish = (outcome: "invalid_signature" | "schema_rejected" | "replay_rejected" | "success" | "failure") => {
    incrementCounter("financial_webhook_total", { outcome });
    observeHistogram("financial_webhook_duration_ms", Date.now() - startedAt, { outcome });
  };

  const signature = req.header("x-mandate-payment-signature") ?? "";
  const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

  incrementCounter("financial_webhook_total", { outcome: "accepted" });

  let result;
  try {
    result = await processMandatePaymentWebhook(rawBody, signature, req.body);
  } catch (err) {
    logger.error("financial_webhook_malformed_payload_rejected", { error: err });
    finish("schema_rejected");
    res.status(400).json({ processed: false, reason: "malformed_payload" });
    return;
  }

  if (!result.processed) {
    const outcome = result.reason === "invalid_signature" ? "invalid_signature" : result.reason === "duplicate_delivery" ? "replay_rejected" : "failure";
    finish(outcome);
    const status = result.reason === "invalid_signature" ? 401 : result.reason === "payment_request_not_found" ? 404 : 200;
    res.status(status).json(result);
    return;
  }
  finish("success");
  res.status(200).json(result);
});
