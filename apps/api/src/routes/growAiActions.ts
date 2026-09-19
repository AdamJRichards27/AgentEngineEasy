import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { listAwaitingApprovalForUser } from "../lib/ai/actionRequests.js";

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

    // Stage F4.0: only the caller's OWN requests (never a colleague's), and
    // expired proposals are transitioned to EXPIRED (audited) and excluded.
    const requests = await listAwaitingApprovalForUser(
      CREATE_GROW_COMMITMENT_ACTION_KEY,
      authedUser.brokerageId,
      authedUser.id,
    );

    // Every field returned here is either the request's own governance
    // metadata (id, status, timestamps) or a field already defined and
    // validated by CREATE_GROW_COMMITMENT's own zod input schema
    // (actions/registry.ts) — never a tamper hash, an authority/risk
    // internal, or anything cross-tenant (see AiStructuredResponse's
    // proposedCommitment field in lib/ai/types.ts for the same exclusion
    // list applied a second time here).
    res.json({
      proposals: requests.map((r) => ({
        id: r.id,
        actionKey: r.actionKey,
        humanReadableSummary: r.humanReadableSummary,
        input: r.inputPayload,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      })),
    });
  },
);
