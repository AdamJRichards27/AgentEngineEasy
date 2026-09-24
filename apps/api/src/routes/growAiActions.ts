import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { listAwaitingApprovalForUser } from "../lib/ai/actionRequests.js";
import { callReviewProvenanceForRequests } from "../lib/growCallReviewLinks.js";

// AE GROW Priority 6 Stage D — AI-Proposed, Human-Approved Follow-Up
// Actions.
//
// This router adds exactly one route: a scoped read of the authenticated
// user's own pending CREATE_GROW_COMMITMENT proposals, so the Grow UI has
// something to list before a human opens one to review/approve/reject.
// Every other governance verb — propose, get one by id, approve, reject,
// execute — is already served, unmodified, by the existing generic
// aiActionsRouter (routes/ai-actions.ts); this file does not duplicate or
// wrap any of them. Deliberately NOT a generic "list every action
// request" endpoint (Stage D specification's own prohibition on exposing
// a generic, un-allowlisted action surface) — it is hardcoded to one
// actionKey and scoped to the caller's own user + brokerage.
export const growAiActionsRouter = Router();

const CREATE_GROW_COMMITMENT_ACTION_KEY = "CREATE_GROW_COMMITMENT";

growAiActionsRouter.get(
  "/pending-commitments",
  requireAuth,
  requireEntitlement("grow.activities.manage"),
  async (req, res) => {
    const authedUser = req.authedUser;
    if (authedUser === undefined) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    // Stage F4.1: optional ?partyId=<int> narrows the SAME caller-own,
    // brokerage-scoped, non-expired list to one contact (e.g. Contact 360).
    // It can only ever remove rows, never widen the scope.
    let partyId: number | null = null;
    if (req.query.partyId !== undefined) {
      const raw = req.query.partyId;
      partyId = typeof raw === "string" && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(partyId)) {
        res.status(400).json({ error: "partyId must be a positive integer." });
        return;
      }
    }

    // Stage F4.0: only the caller's OWN requests (never a colleague's), and
    // expired proposals are transitioned to EXPIRED (audited) and excluded.
    const allRequests = await listAwaitingApprovalForUser(
      CREATE_GROW_COMMITMENT_ACTION_KEY,
      authedUser.brokerageId,
      authedUser.id,
    );
    const requests = partyId === null
      ? allRequests
      : allRequests.filter((r) => (r.inputPayload as { partyId?: unknown } | null)?.partyId === partyId);

    // Every field returned here is either the request's own governance
    // metadata (id, status, timestamps) or a field already defined and
    // validated by CREATE_GROW_COMMITMENT's own zod input schema
    // (actions/registry.ts) — never a tamper hash, an authority/risk
    // internal, or anything cross-tenant (see AiStructuredResponse's
    // proposedCommitment field in lib/ai/types.ts for the same exclusion
    // list applied a second time here).
    // E-8: call-review provenance is the grow_call_review_links row.
    // A proposal with only the historical resourceId string has none.
    const provenance = await callReviewProvenanceForRequests(
      authedUser.brokerageId,
      requests.map((r) => r.id),
    );
    res.json({
      proposals: requests.map((r) => ({
        id: r.id,
        actionKey: r.actionKey,
        humanReadableSummary: r.humanReadableSummary,
        input: r.inputPayload,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
        provenance: provenance.get(r.id) ?? null,
      })),
    });
  },
);
