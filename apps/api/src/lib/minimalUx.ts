import type { Response } from "express";
import { isInsecureCookieExplicitlyAllowed } from "./env.js";

// AE Minimal A shell gate. Same boolean parser as lib/ai/featureFlags.ts:
// only the exact word "true" (any case) turns the flag on. Unset, blank,
// "1", and "yes" stay off. The flag is necessary but not sufficient — the
// allowlist must name the user as well. Neither value is a database column
// and neither grants brokerage data access.

export const MINIMAL_UX_FLAG_ENV = "AE_MINIMAL_UX_ENABLED";
export const MINIMAL_UX_ALLOWLIST_ENV = "AE_MINIMAL_UX_ALLOWLIST";
export const MINIMAL_UX_VIEW_COOKIE = "aee_ux_view";

export type MinimalUxVariant = "classic" | "minimal";

export interface MinimalUxAllowlist {
  emails: ReadonlySet<string>;
  userIds: ReadonlySet<number>;
}

export interface MinimalUxDecision {
  /** Operator flag. Never copied into the session payload. */
  flagEnabled: boolean;
  /** This user is named. Never copied into the session payload on its own. */
  allowlisted: boolean;
  /** Flag on and this user is named. Safe to send to the signed-in client. */
  eligible: boolean;
  /** Shell to render. Classic unless the user is eligible and has not chosen classic. */
  variant: MinimalUxVariant;
}

export interface MinimalUxClientPayload {
  eligible: boolean;
  variant: MinimalUxVariant;
}

type EnvSource = Record<string, string | undefined>;

function envBool(env: EnvSource, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  return raw.toLowerCase() === "true";
}

export function isMinimalUxFlagEnabled(env: EnvSource = process.env): boolean {
  return envBool(env, MINIMAL_UX_FLAG_ENV, false);
}

/**
 * Comma-separated emails and numeric user ids. Emails are matched
 * case-insensitively. Anything that is neither an email nor a positive
 * integer is ignored, so a typo cannot widen the gate. An empty value
 * allowlists nobody.
 */
export function parseMinimalUxAllowlist(raw: string | undefined): MinimalUxAllowlist {
  const emails = new Set<string>();
  const userIds = new Set<number>();
  if (typeof raw !== "string") return { emails, userIds };
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token.length === 0) continue;
    if (token.includes("@")) {
      emails.add(token.toLowerCase());
      continue;
    }
    if (/^[1-9]\d*$/.test(token)) {
      const id = Number(token);
      if (Number.isSafeInteger(id)) userIds.add(id);
    }
  }
  return { emails, userIds };
}

export function isMinimalUxAllowlisted(
  user: { id: number; email: string },
  allowlist: MinimalUxAllowlist,
): boolean {
  if (allowlist.userIds.has(user.id)) return true;
  const email = user.email.trim().toLowerCase();
  return email.length > 0 && allowlist.emails.has(email);
}

/** Cookie value is `${userId}.classic` or `${userId}.minimal`. A mismatch is ignored. */
export function parseMinimalUxViewCookie(raw: string | undefined, userId: number): MinimalUxVariant | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const match = /^([1-9]\d*)\.(classic|minimal)$/.exec(raw);
  if (!match) return null;
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id !== userId) return null;
  return match[2] === "minimal" ? "minimal" : "classic";
}

export function formatMinimalUxViewCookie(userId: number, variant: MinimalUxVariant): string {
  return `${userId}.${variant}`;
}

export function resolveMinimalUx(input: {
  userId: number;
  email: string;
  viewCookie?: string | undefined;
  env?: EnvSource;
}): MinimalUxDecision {
  const env = input.env ?? process.env;
  const flagEnabled = isMinimalUxFlagEnabled(env);
  const allowlist = parseMinimalUxAllowlist(env[MINIMAL_UX_ALLOWLIST_ENV]);
  const allowlisted = isMinimalUxAllowlisted({ id: input.userId, email: input.email }, allowlist);
  const eligible = flagEnabled && allowlisted;
  const preference = parseMinimalUxViewCookie(input.viewCookie, input.userId);
  const variant: MinimalUxVariant = eligible && preference !== "classic" ? "minimal" : "classic";
  return { flagEnabled, allowlisted, eligible, variant };
}

export function minimalUxClientPayload(decision: MinimalUxDecision): MinimalUxClientPayload {
  return { eligible: decision.eligible, variant: decision.variant };
}

const UX_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function minimalUxViewSetCookie(userId: number, variant: MinimalUxVariant): string {
  const secureAttr = isInsecureCookieExplicitlyAllowed() ? "" : "; Secure";
  const value = encodeURIComponent(formatMinimalUxViewCookie(userId, variant));
  return `${MINIMAL_UX_VIEW_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${UX_COOKIE_MAX_AGE_SECONDS}${secureAttr}`;
}

export function applyMinimalUxViewCookie(res: Response, userId: number, variant: MinimalUxVariant): void {
  res.append("Set-Cookie", minimalUxViewSetCookie(userId, variant));
}
