// Agent Engine 2.0 — Step 2: Security & Observability Hardening.
//
// Guards GET /api/internal/metrics (routes/metrics.ts). Metrics are not
// tenant data, but they DO leak operational shape (request volume,
// integration failure rates, which providers are configured) that has no
// business being reachable by an unauthenticated caller on the public
// internet — same fail-closed posture as SESSION_SECRET (lib/session.ts)
// and CORS_ALLOWED_ORIGINS (lib/cors.ts): assertMetricsAuthConfigured() is
// called at boot (index.ts) and refuses to start in production if
// METRICS_TOKEN is unset, rather than quietly exposing the endpoint to
// anyone or quietly locking everyone out in a way nobody decided on
// purpose. Outside production, an unset METRICS_TOKEN leaves the endpoint
// open — this is what the existing test suite and local dev rely on,
// mirroring lib/cors.ts's own non-production fallback.

import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { isProductionEnvironment } from "./env.js";

function configuredToken(): string | undefined {
  const raw = process.env.METRICS_TOKEN;
  return raw && raw.length > 0 ? raw : undefined;
}

/** Call once during process boot, alongside assertSessionSecretConfigured() and assertCorsConfigured(). */
export function assertMetricsAuthConfigured(): void {
  if (isProductionEnvironment() && !configuredToken()) {
    throw new Error(
      "METRICS_TOKEN is not configured. Refusing to start in production: " +
        "GET /api/internal/metrics would otherwise be reachable by anyone " +
        "who can route to this API. Set METRICS_TOKEN to a random value " +
        "(for example: `openssl rand -base64 32`) and configure your " +
        "metrics scraper to send it as `Authorization: Bearer <token>`.",
    );
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Mounted directly on the metrics route (not globally — this is the one endpoint with a bearer-token scheme instead of the cookie session every other route uses). */
export function requireMetricsAuth(req: Request, res: Response, next: NextFunction): void {
  const token = configuredToken();
  if (!token) {
    // Only reachable outside production (assertMetricsAuthConfigured
    // above refuses to boot production without a token) — dev/test
    // convenience, not a silent bypass in a deployed environment.
    next();
    return;
  }
  const header = req.header("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!provided || !constantTimeEquals(provided, token)) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Missing or invalid metrics token." });
    return;
  }
  next();
}
