import { createHmac, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import { isInsecureCookieExplicitlyAllowed } from "./env.js";

// Minimal session mechanism for staging/prototype use (ARCHITECTURE.md §7,
// §10 Phase 1-8 closing note: "the real Clerk auth integration is the
// documented future scope). This is deliberately NOT a general-purpose auth
// system - it's an HMAC-signed cookie carrying a user id, enough to make
// every requireAuth-gated route actually usable end-to-end on staging while
// real Clerk integration is scheduled. No passwords, no third-party
// identity provider: POST /auth/dev-login finds-or-creates a user by email
// and signs them in directly (see routes/auth.ts) - and that route is only
// reachable when an operator has explicitly enabled it (see lib/env.ts).
//
// Foundation Remediation, Stage 1.2/1.3: the insecure hardcoded fallback
// secret that used to live here has been removed. A missing or weak
// SESSION_SECRET now makes secret() throw, and index.ts calls
// assertSessionSecretConfigured() during boot so the process refuses to
// start rather than quietly signing tokens no one can trust across a
// restart or a redeploy.

const COOKIE_NAME = "aee_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days - staging convenience, not a security-critical session
const MIN_SECRET_LENGTH = 32;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < MIN_SECRET_LENGTH) {
    throw new Error(
      "SESSION_SECRET is not configured, or is shorter than " +
        MIN_SECRET_LENGTH +
        " characters. Refusing to sign or verify sessions: a weak or " +
        "absent secret means every session cookie could be forged. Set " +
        "SESSION_SECRET to a random value of at least " +
        MIN_SECRET_LENGTH +
        " characters (for example: `openssl rand -base64 48`) before " +
        "starting the API.",
    );
  }
  return s;
}

/**
 * Call once during process boot (see index.ts). Throws - and is meant to
 * crash startup - if SESSION_SECRET is missing or too weak, so the failure
 * happens loudly at deploy time instead of silently at request time.
 */
export function assertSessionSecretConfigured(): void {
  secret();
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

// Foundation Remediation - server-side session revocation: `epoch` mirrors
// the signed-in user's `sessionEpoch` column (packages/db/src/schema/
// users.ts) as of sign-time. This token is otherwise stateless (no
// server-side session store - see the module comment above), so embedding
// the epoch is what lets a per-user "revoke everything issued before now"
// (logout - see routes/auth.ts's POST /logout) actually take effect against
// a token that is still cryptographically valid and unexpired. The epoch
// itself is just an integer counter, never a secret, so it rides in the
// payload unencrypted like uid/iat.
export function createSessionToken(userId: number, epoch = 0): string {
  const payload = base64url(JSON.stringify({ uid: userId, iat: Date.now(), epoch }));
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined | null): { uid: number; epoch: number; iat: number } | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  // Constant-time comparison - signature is attacker-influenced input.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof decoded?.uid !== "number" || typeof decoded?.iat !== "number") return null;
    // Foundation Remediation, Stage 1.5: reject sessions older than
    // MAX_AGE_SECONDS server-side too, not just via the cookie's own
    // Max-Age. A leaked or replayed token must expire even if it's
    // presented outside the browser's own cookie-expiry enforcement.
    const ageSeconds = (Date.now() - decoded.iat) / 1000;
    if (!Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > MAX_AGE_SECONDS) return null;
    // A token signed before this field existed simply carries no epoch,
    // which is indistinguishable from - and correctly treated the same as
    // - epoch 0, the column's own default. The actual revocation check
    // (does this match the user's CURRENT epoch?) happens in
    // middlewares/auth.ts's loadSession, which already re-reads the user
    // row from the DB on every request; this function only decodes and
    // shape-validates what the token itself claims.
    const epoch = typeof decoded?.epoch === "number" ? decoded.epoch : 0;
    // iat stays on the verified result so Platform Owner sessions can apply
    // a shorter absolute lifetime without changing this 30-day cap.
    return { uid: decoded.uid, epoch, iat: decoded.iat };
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  return parseCookies(cookieHeader)[COOKIE_NAME];
}

export function setSessionCookie(res: Response, userId: number, epoch = 0): void {
  const token = createSessionToken(userId, epoch);
  const secureAttr = isInsecureCookieExplicitlyAllowed() ? "" : "; Secure";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${secureAttr}`,
  );
}

export function clearSessionCookie(res: Response): void {
  const secureAttr = isInsecureCookieExplicitlyAllowed() ? "" : "; Secure";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttr}`);
}
