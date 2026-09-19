// AE GROW Priority 6 Stage F4.1 — Governed call follow-ups.
//
// Two routes under /grow/calls, deliberately in their own router so the F3
// surface (routes/growCalls.ts) never imports F4 code:
//
//   GET  /:callSessionId/transcription/:transcriptionId/followups
//        -> approved COMMITMENT/FOLLOWUP items + existing proposal state
//   POST /:callSessionId/transcription/:transcriptionId/followups/propose
//        body { items: [{ itemType, itemId, dueAt }] } (strict)
//        -> Stage D CREATE_GROW_COMMITMENT proposals awaiting human approval
//
// Nothing here approves or executes anything: approval/execution stays on
// the existing governed /ai/actions/requests/:id/{approve,execute} routes.
// The client can never supply description, partyId, brokerageId, actorType,
// or any authority field — the strict schema rejects every extra key.
import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import {
  GrowCallFollowupError,
  listCallFollowupCandidates,
  proposeCallFollowups,
  proposeCallFollowupsBodySchema,
} from "../lib/growCallFollowups.js";

export const growCallFollowupsRouter = Router();

function parseIdParam(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Same mapping as F3's transcriptionReviewErrorStatus: a same-brokerage
// non-owner is ACCESS_DENIED (403); cross-tenant/unknown ids are 404.
function followupErrorStatus(error: GrowCallFollowupError): number {
  if (error.code === "INVALID_INPUT") return 400;
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "ACCESS_DENIED" || error.code === "ENTITLEMENT_REQUIRED" || error.code === "POLICY_DENIED") return 403;
  if (error.code === "AUDIT_FAILURE" || error.code === "AUDIT_INCOMPLETE") return 503;
  return 409; // WRONG_STATE, CONSENT_WITHDRAWN
}

const gates = [
  requireAuth,
  requireEntitlement("grow.calling.transcription"),
  requireEntitlement("grow.activities.manage"),
];

growCallFollowupsRouter.get("/:callSessionId/transcription/:transcriptionId/followups", ...gates, async (req, res) => {
  const callSessionId = parseIdParam(req.params.callSessionId);
  const transcriptionId = parseIdParam(req.params.transcriptionId);
  if (callSessionId === null || transcriptionId === null) {
    res.status(400).json({ error: "Invalid call session or transcription id.", code: "INVALID_INPUT" });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const result = await listCallFollowupCandidates({
      brokerageId: authedUser.brokerageId,
      callSessionId,
      transcriptionId,
      actor: { userId: authedUser.id, role: authedUser.role, brokerageId: authedUser.brokerageId },
    });
    res.json(result);
  } catch (error) {
    if (error instanceof GrowCallFollowupError) {
      res.status(followupErrorStatus(error)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});

growCallFollowupsRouter.post("/:callSessionId/transcription/:transcriptionId/followups/propose", ...gates, async (req, res) => {
  const callSessionId = parseIdParam(req.params.callSessionId);
  const transcriptionId = parseIdParam(req.params.transcriptionId);
  if (callSessionId === null || transcriptionId === null) {
    res.status(400).json({ error: "Invalid call session or transcription id.", code: "INVALID_INPUT" });
    return;
  }
  const parsed = proposeCallFollowupsBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Body must be { items: [{ itemType, itemId, dueAt }] } with 1-20 COMMITMENT/FOLLOWUP items; no other fields are accepted.",
      code: "INVALID_INPUT",
    });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const result = await proposeCallFollowups({
      brokerageId: authedUser.brokerageId,
      callSessionId,
      transcriptionId,
      actor: { userId: authedUser.id, role: authedUser.role, brokerageId: authedUser.brokerageId },
      body: parsed.data,
    });
    res.status(result.proposals.some((proposal) => proposal.status === "PROPOSED") ? 201 : 200).json(result);
  } catch (error) {
    if (error instanceof GrowCallFollowupError) {
      res.status(followupErrorStatus(error)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});
