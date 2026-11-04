// Owner t275u: Business Coach and Ask AE are agent-facing. Server-side rule:
//   - role Agent, and not a read-only agent (an Agent holding neither run.access
//     nor grow.access — e.g. a grow.contacts.read-only seat);
//   - Pit Crew: never;
//   - Brokerage Administrator: only when separately and explicitly authorised —
//     listed by user id in AE_AGENT_AI_ADMIN_USER_IDS (comma-separated, deploy config;
//     empty by default, so no admin inherits access). No schema change.
// The existing entitlement and feature-flag checks still run after this gate.
import type { NextFunction, Request, Response } from "express";
import type { AuthedUser } from "../middlewares/auth.js";
import { explainEntitlementDecision } from "./entitlements/resolver.js";

export const AGENT_AI_REFUSAL_CODE = "AGENT_AI_AGENT_ONLY";

function explicitlyAuthorisedAdmins(): Set<number> {
  return new Set(
    String(process.env.AE_AGENT_AI_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}

export type AgentAiDecision = { allowed: true } | { allowed: false; reason: "PIT_CREW" | "ADMIN_NOT_AUTHORISED" | "READ_ONLY" | "ROLE" };

export async function agentAiAccess(user: AuthedUser): Promise<AgentAiDecision> {
  if (user.role === "Pit Crew") return { allowed: false, reason: "PIT_CREW" };
  if (user.role === "Brokerage Administrator") {
    return explicitlyAuthorisedAdmins().has(user.id) ? { allowed: true } : { allowed: false, reason: "ADMIN_NOT_AUTHORISED" };
  }
  if (user.role !== "Agent") return { allowed: false, reason: "ROLE" };
  const [run, grow] = await Promise.all(
    (["run.access", "grow.access"] as const).map((k) => explainEntitlementDecision(user, k).then((d) => d.allowed).catch(() => false)),
  );
  return run || grow ? { allowed: true } : { allowed: false, reason: "READ_ONLY" };
}

export function requireAgentAi() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.authedUser;
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const d = await agentAiAccess(user);
    if (!d.allowed) {
      res.status(403).json({ error: "Ask AE and the Business Coach are available to agents only.", code: AGENT_AI_REFUSAL_CODE, reason: d.reason });
      return;
    }
    next();
  };
}
