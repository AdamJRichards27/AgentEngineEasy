import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, amlVerifications, serviceOrders, properties } from "@aee/db";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import { initiateAmlIfNeeded, processAmlWebhook, retryAmlVerification, resolveAmlException } from "../lib/aml.js";
import { refreshReadyToListSteps } from "../lib/workflowSteps.js";
import { logAudit } from "../lib/audit.js";

// Manual/direct AML request path — Ready to List (routes/properties.ts)
// covers the common case automatically, but a Brokerage Administrator or
// Pit Crew member may need to (re-)trigger a check for a party outside that
// flow, and non-Seller parties (Buyer, Solicitor, PowerOfAttorney, Other)
// have no automatic trigger at all — Ready to List is deliberately a
// Seller-only workflow concept, so this is their only path to a check
// (Property Timeline prerequisite: the buyer/other-party AML action on the
// Property Workspace calls this same route). Both paths funnel through
// lib/aml.ts's initiateAmlIfNeeded(), so neither can double-order (Build
// Brief critical idempotency requirement), and tenant/linkage validation
// lives in that one shared function too (see assertPartyOnPropertyInBrokerage
// in lib/aml.ts) so this route no longer needs its own existence checks.
//
// Phase 4 (ARCHITECTURE.md §10) adds: a real HttpAMLProvider adapter
// (packages/integrations/aml), webhook processing (below, POST /webhook),
// exception handling (retry / resolve-exception), and ServiceOrder billing
// records created alongside each verification (see lib/aml.ts). Actually
// charging a stored payment method for those ServiceOrders is Phase 6.
export const amlRouter = Router();

const requestSchema = z.object({
  propertyId: z.number(),
  partyId: z.number(),
  verificationType: z.string().default("Individual"),
});

amlRouter.post("/request", requireAuth, async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;

  try {
    const { verification, created } = await initiateAmlIfNeeded({
      propertyId: parsed.data.propertyId,
      partyId: parsed.data.partyId,
      verificationType: parsed.data.verificationType,
      userId: user.id,
      brokerageId: user.brokerageId,
    });

    await refreshReadyToListSteps(parsed.data.propertyId).catch((err) =>
      console.error("refreshReadyToListSteps failed", err),
    );

    res.status(created ? 201 : 200).json({ verification, created });
  } catch (err) {
    // initiateAmlIfNeeded throws "not found" uniformly for a missing
    // property/party AND for a cross-tenant or unlinked one — a caller
    // outside the brokerage can never distinguish "doesn't exist" from
    // "exists but isn't yours" from this response.
    res.status(404).json({ error: (err as Error).message });
  }
});

amlRouter.get("/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const user = req.authedUser!;
  // Joined onto properties and filtered by the caller's brokerageId in the
  // same query — a propertyId from another brokerage returns no rows here,
  // never another tenant's AML verification records.
  const rows = await db
    .select({ verification: amlVerifications })
    .from(amlVerifications)
    .innerJoin(properties, eq(amlVerifications.propertyId, properties.id))
    .where(and(eq(amlVerifications.propertyId, propertyId), eq(properties.brokerageId, user.brokerageId)));
  res.json({ verifications: rows.map((r) => r.verification) });
});

// Provider webhook — reports the outcome of a verification requested via
// requestVerification(). Deliberately NOT behind requireAuth: the caller is
// the AML provider's server, not a logged-in AgentEngineEasy user, so
// authenticity is established by the HMAC signature instead (see
// lib/aml.ts processAmlWebhook / HttpAMLProvider.verifyWebhookSignature).
// Uses req.rawBody (captured in app.ts) rather than JSON.stringify(req.body)
// so the signature check runs against the exact bytes the provider signed.
amlRouter.post("/webhook", async (req, res) => {
  const signature = String(req.header("x-aml-signature") ?? req.header("x-webhook-signature") ?? "");
  const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

  const result = await processAmlWebhook(rawBody, signature, req.body);

  if (result.reason === "invalid_signature") {
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }
  if (result.reason === "verification_not_found") {
    // 200, not 404/400 — an unrecognised verification is usually the
    // provider retrying a webhook for a check this environment never made
    // (e.g. staging vs prod credentials), not a client error to retry into
    // a loop.
    res.status(200).json({ received: true, processed: false, reason: result.reason });
    return;
  }

  res.status(200).json({ received: true, processed: result.processed, reason: result.reason });
});

const resolveExceptionSchema = z.object({ notes: z.string().trim().min(1, "notes are required to resolve an AML exception") });

// Exception resolution (Phase 4) — restricted to Brokerage Administrators:
// this records a compliance decision, not a routine agent action. Requires
// non-empty notes so it can never be a silent one-click bypass of a failed
// or flagged identity check.
amlRouter.post("/:verificationId/resolve-exception", requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const verificationId = Number(req.params.verificationId);
  const parsed = resolveExceptionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;

  try {
    const verification = await resolveAmlException({
      verificationId,
      userId: user.id,
      notes: parsed.data.notes,
      brokerageId: user.brokerageId,
    });
    await logAudit({
      userId: user.id,
      action: "aml_exception_resolved",
      recordType: "aml_verification",
      recordId: String(verificationId),
      propertyId: verification.propertyId,
      updatedValue: parsed.data.notes,
    });
    res.json({ verification });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Retry — re-runs a Failed or still-open Review Required check against the
// same AmlVerification row (see lib/aml.ts retryAmlVerification). Any
// authenticated user can retry; unlike resolve-exception this doesn't
// override an outcome, it just asks the provider again.
amlRouter.post("/:verificationId/retry", requireAuth, async (req, res) => {
  const verificationId = Number(req.params.verificationId);
  const user = req.authedUser!;

  try {
    const verification = await retryAmlVerification(verificationId, user.brokerageId);
    await logAudit({
      userId: user.id,
      action: "aml_verification_retried",
      recordType: "aml_verification",
      recordId: String(verificationId),
      propertyId: verification.propertyId,
    });
    res.json({ verification });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Cost/billing visibility for a property's AML checks (Section 11) — the
// ServiceOrder rows created by initiateAmlIfNeeded, read-only here; actual
// charging is Phase 6.
amlRouter.get("/service-orders/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const user = req.authedUser!;
  // Same brokerage-scoped join as GET /by-property above — serviceOrders
  // carries no brokerageId of its own, and this is billing data, so a
  // cross-tenant propertyId must return nothing rather than another
  // tenant's cost/price records.
  const rows = await db
    .select({ serviceOrder: serviceOrders })
    .from(serviceOrders)
    .innerJoin(properties, eq(serviceOrders.propertyId, properties.id))
    .where(and(eq(serviceOrders.propertyId, propertyId), eq(properties.brokerageId, user.brokerageId)));
  res.json({ serviceOrders: rows.map((r) => r.serviceOrder) });
});
