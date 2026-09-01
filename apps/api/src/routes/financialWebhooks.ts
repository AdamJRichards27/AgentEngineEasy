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

financialWebhooksRouter.post("/financial/webhooks/mandate-payments", async (req, res) => {
  const signature = req.header("x-mandate-payment-signature") ?? "";
  const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
  const result = await processMandatePaymentWebhook(rawBody, signature, req.body);

  if (!result.processed) {
    const status = result.reason === "invalid_signature" ? 401 : result.reason === "payment_request_not_found" ? 404 : 200;
    res.status(status).json(result);
    return;
  }
  res.status(200).json(result);
});
