import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import {
  PropertyIntelligenceAccessError,
  PropertyIntelligenceTransitionError,
  getPropertyIntelligenceSummary,
  getContactPropertyIntelligenceSummary,
  listMatchesForProperty,
  confirmMatch,
  rejectMatch,
  listSignalsForProperty,
  reviewSignal,
  dismissSignal,
  promoteSignal,
  recalculateSignalsForProperty,
} from "../lib/propertyIntelligence/service.js";

/**
 * AE GROW Priority 5 Remediation — the Property Intelligence API the
 * merged Priority 5 report described but never actually shipped (see
 * docs/AE_GROW_PRIORITY_5_APPLICATION_LAYER_REMEDIATION.md). Follows the
 * exact conventions established by routes/growAppraisals.ts: requireAuth
 * on every route, requireEntitlement("grow.propertyIntelligence.read") for
 * every GET, requireEntitlement("grow.propertyIntelligence.manage") for
 * every state-changing POST, tenant re-scoping inside the service layer
 * itself (never trusted from req params alone), and a shared typed-error
 * mapper mirroring handleGrowAppraisalError.
 */
export const propertyIntelligenceRouter = Router();

const requireRead = requireEntitlement("grow.propertyIntelligence.read");
const requireManage = requireEntitlement("grow.propertyIntelligence.manage");

function handlePropertyIntelligenceError(err: unknown, res: import("express").Response): void {
  if (err instanceof PropertyIntelligenceAccessError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof PropertyIntelligenceTransitionError) {
    res.status(409).json({ error: err.message });
    return;
  }
  res.status(400).json({ error: (err as Error).message });
}

/* ---------------------------------------------------------------------
 * Reads.
 * -----------------------------------------------------------------*/

propertyIntelligenceRouter.get("/property/:propertyId", requireAuth, requireRead, async (req, res) => {
  const user = req.authedUser!;
  const propertyId = Number(req.params.propertyId);
  try {
    const summary = await getPropertyIntelligenceSummary(propertyId, user.brokerageId);
    res.json(summary);
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

propertyIntelligenceRouter.get("/contact/:partyId", requireAuth, requireRead, async (req, res) => {
  const user = req.authedUser!;
  const partyId = Number(req.params.partyId);
  try {
    const entries = await getContactPropertyIntelligenceSummary(partyId, user.brokerageId);
    res.json({ properties: entries });
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

const matchQuerySchema = z.object({ status: z.enum(["PendingReview", "Confirmed", "Rejected"]).optional() });

propertyIntelligenceRouter.get("/property/:propertyId/matches", requireAuth, requireRead, async (req, res) => {
  const user = req.authedUser!;
  const propertyId = Number(req.params.propertyId);
  const parsed = matchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const matches = await listMatchesForProperty(propertyId, user.brokerageId, parsed.data.status);
    res.json({ matches });
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

const signalQuerySchema = z.object({ status: z.enum(["Active", "Reviewed", "Dismissed", "Expired", "Superseded"]).optional() });

propertyIntelligenceRouter.get("/property/:propertyId/signals", requireAuth, requireRead, async (req, res) => {
  const user = req.authedUser!;
  const propertyId = Number(req.params.propertyId);
  const parsed = signalQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const signals = await listSignalsForProperty(propertyId, user.brokerageId, parsed.data.status);
    res.json({ signals });
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Match review — requires grow.propertyIntelligence.manage.
 * -----------------------------------------------------------------*/

propertyIntelligenceRouter.post("/matches/:identifierId/confirm", requireAuth, requireManage, async (req, res) => {
  const user = req.authedUser!;
  const identifierId = Number(req.params.identifierId);
  try {
    const match = await confirmMatch({ identifierId, brokerageId: user.brokerageId, userId: user.id });
    res.json({ match });
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

const rejectMatchSchema = z.object({ rejectedReason: z.string().nullable().optional() });

propertyIntelligenceRouter.post("/matches/:identifierId/reject", requireAuth, requireManage, async (req, res) => {
  const user = req.authedUser!;
  const identifierId = Number(req.params.identifierId);
  const parsed = rejectMatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const match = await rejectMatch({ identifierId, brokerageId: user.brokerageId, userId: user.id, rejectedReason: parsed.data.rejectedReason });
    res.json({ match });
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Signal review/dismiss/promote — requires grow.propertyIntelligence.manage.
 * -----------------------------------------------------------------*/

propertyIntelligenceRouter.post("/signals/:signalId/review", requireAuth, requireManage, async (req, res) => {
  const user = req.authedUser!;
  const signalId = Number(req.params.signalId);
  try {
    const signal = await reviewSignal({ signalId, brokerageId: user.brokerageId, userId: user.id });
    res.json({ signal });
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

const dismissSignalSchema = z.object({ dismissedReason: z.string().min(1) });

propertyIntelligenceRouter.post("/signals/:signalId/dismiss", requireAuth, requireManage, async (req, res) => {
  const user = req.authedUser!;
  const signalId = Number(req.params.signalId);
  const parsed = dismissSignalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const signal = await dismissSignal({ signalId, brokerageId: user.brokerageId, userId: user.id, dismissedReason: parsed.data.dismissedReason });
    res.json({ signal });
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

propertyIntelligenceRouter.post("/signals/:signalId/promote", requireAuth, requireManage, async (req, res) => {
  const user = req.authedUser!;
  const signalId = Number(req.params.signalId);
  try {
    const result = await promoteSignal({ signalId, brokerageId: user.brokerageId, userId: user.id });
    res.json(result);
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Recalculation — safe to call repeatedly (idempotent, mock-only, no
 * external provider call of its own). Requires manage, matching every
 * other state-changing route above.
 * -----------------------------------------------------------------*/

propertyIntelligenceRouter.post("/property/:propertyId/recalculate", requireAuth, requireManage, async (req, res) => {
  const user = req.authedUser!;
  const propertyId = Number(req.params.propertyId);
  try {
    const signals = await recalculateSignalsForProperty(propertyId, user.brokerageId);
    res.json({ signals });
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});
