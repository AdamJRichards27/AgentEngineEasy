// Owner t275u: Business Coach and Ask AE are agent-facing. Server-side rule:
//   - role Agent, and not a read-only agent: the Agent must hold run.access, or
//     grow.access plus at least one Grow write key (contacts/relationships/
//     opportunities/activities manage). A seat with only read keys
//     (grow.access + grow.contacts.read ...) is read-only and refused READ_ONLY;
//   - Pit Crew: never;
//   - Brokerage Administrator: only when separately and explicitly authorised —
//     listed by user id in AE_AGENT_AI_ADMIN_USER_IDS (comma-separated, deploy config;
//     empty by default, so no admin inherits access). No schema change.
// The existing entitlement and feature-flag checks still run after this gate.
import type { NextFunction, Request, Response } from "express";
import type { AuthedUser } from "../middlewares/auth.js";
import { explainEntitlementDecision } from "./entitlements/resolver.js";

export const GROW_WRITE_KEYS = ["grow.contacts.manage", "grow.relationships.manage", "grow.opportunities.manage", "grow.activities.manage"] as const;

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
  // t276u: the admin allowlist only lifts the admin role bar. It never overrides another
  // restriction: Pit Crew is refused above, and an allow-listed admin must still pass the
  // same read-only test as an agent (run.access, or grow.access plus a Grow write key).
  if (user.role === "Brokerage Administrator") {
    if (!explicitlyAuthorisedAdmins().has(user.id)) return { allowed: false, reason: "ADMIN_NOT_AUTHORISED" };
  } else if (user.role !== "Agent") return { allowed: false, reason: "ROLE" };
  const has = (k: string) => explainEntitlementDecision(user, k as never).then((d) => d.allowed).catch(() => false);
  if (await has("run.access")) return { allowed: true };
  if (!(await has("grow.access"))) return { allowed: false, reason: "READ_ONLY" };
  const writes = await Promise.all(GROW_WRITE_KEYS.map(has));
  return writes.some(Boolean) ? { allowed: true } : { allowed: false, reason: "READ_ONLY" };
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
