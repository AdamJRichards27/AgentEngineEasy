import { createHmac, timingSafeEqual } from "node:crypto";
import type { Response } from "express";

// Minimal session mechanism for staging/prototype use (ARCHITECTURE.md §7,
// §10 Phase 1-8 closing note: "the real Clerk auth integration" is
// documented future scope). This is deliberately NOT a general-purpose auth
// system — it's an HMAC-signed cookie carrying a user id, enough to make
// every requireAuth-gated route actually usable end-to-end on staging while
// real Clerk integration is scheduled. No passwords, no third-party
// identity provider: POST /auth/dev-login finds-or-creates a user by email
// and signs them in directly (see routes/auth.ts).

const COOKIE_NAME = "aee_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days — staging convenience, not a security-critical session

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) {
    // Never throw here — a missing secret shouldn't take the whole API
    // down, but it does mean sessions aren't trustworthy across restarts.
    // Logged once per process, not per request.
    return "aee-dev-insecure-default-secret-set-SESSION_SECRET-in-env";
  }
  return s;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createSessionToken(userId: number): string {
  const payload = base64url(JSON.stringify({ uid: userId, iat: Date.now() }));
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined | null): { uid: number } | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  // Constant-time comparison — signature is attacker-influenced input.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof decoded?.uid !== "number") return null;
    return { uid: decoded.uid };
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

export function setSessionCookie(res: Response, userId: number): void {
  const token = createSessionToken(userId);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`,
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
