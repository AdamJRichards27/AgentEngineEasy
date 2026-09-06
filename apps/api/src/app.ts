import express from "express";
import cors from "cors";
import helmet from "helmet";
import { apiRouter } from "./routes/index.js";
import { loadSession } from "./middlewares/auth.js";
import { requestId } from "./middlewares/requestId.js";
import { httpMetrics } from "./middlewares/httpMetrics.js";
import { globalRateLimiter } from "./middlewares/rateLimit.js";
import { corsOriginCallback } from "./lib/cors.js";
import { globalErrorHandler } from "./middlewares/errorHandler.js";
import { mountStaticWebIfPresent } from "./lib/staticWeb.js";

export function createApp() {
  const app = express();

  // Standard security response headers (CSP, X-Frame-Options, HSTS,
  // X-Content-Type-Options, etc.) on every response — mounted first, ahead
  // of everything else. Every /api/* route below remains a pure JSON API;
  // in production only (see lib/staticWeb.ts, Critical Blocker
  // Remediation Phase 9), this app additionally serves the built web SPA
  // as static files, which is exactly the shape helmet's default
  // Content-Security-Policy is designed for (script-src/style-src 'self',
  // no inline/eval) — the built Vite output loads its JS/CSS via same-origin
  // <script src>/<link href> tags with no inline scripts, so the defaults
  // need no hand-tuning here; verified in
  // docs/gate-evidence/PHASE9_DEPLOYMENT_READINESS_AUDIT.md.
  app.use(helmet());

  // Generates a per-request correlation id and echoes it back as
  // X-Correlation-Id on every response — including ones later rejected by
  // CORS, rate limiting, or an oversized body below — so any request can
  // be tied to server logs for support correlation. See
  // middlewares/requestId.ts. Mounted right after helmet, ahead of
  // anything that can short-circuit a request.
  app.use(requestId);

  // Step 2 hardening: records http_requests_total / http_request_duration_ms
  // for every response (see middlewares/httpMetrics.ts) — mounted
  // immediately after requestId, ahead of anything that can reject a
  // request, for the same reason requestId itself is mounted this early.
  app.use(httpMetrics);

  // credentials: true + an explicit allowlist (no longer a blanket
  // origin: true reflection of any requesting Origin) is required for the
  // browser to send/accept the session cookie (lib/session.ts) — the
  // frontend always calls with `credentials: "include"` (lib/api.ts). See
  // lib/cors.ts for the allowlist itself (CORS_ALLOWED_ORIGINS env var;
  // fails closed at boot in production — see assertCorsConfigured() in
  // index.ts).
  app.use(cors({ origin: corsOriginCallback, credentials: true }));

  // Generous global throttle (300 req/min/IP in real environments) — see
  // middlewares/rateLimit.ts for the thresholds and its test-environment
  // carve-out. A stricter limiter is applied separately to /auth (see
  // routes/index.ts).
  app.use(globalRateLimiter);

  // Captures the exact raw bytes of every request body onto req.rawBody
  // alongside normal JSON parsing — webhook signature verification (Phase
  // 4's AML webhook, and future e-sign/payment webhooks) needs the exact
  // bytes the provider signed, not a re-serialised copy of the parsed body.
  // Explicit 1mb limit (Express's implicit default is 100kb) — generous
  // for this API's JSON payloads while still bounding how much of an
  // oversized body gets buffered; file uploads go through routes/import.ts's
  // own multer limit (multipart/form-data), not this JSON body parser.
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as import("express").Request).rawBody = Buffer.from(buf);
      },
    }),
  );
  // Populates req.authedUser from the session cookie ahead of every route
  // (see middlewares/auth.ts) — requireAuth then just checks it's present.
  app.use(loadSession);
  app.use("/api", apiRouter);

  // Critical Blocker Remediation, Phase 9 — explicit JSON 404 for any
  // /api/* path apiRouter didn't match, mounted immediately after it and
  // before static-web serving below. Without this, an unmatched API path
  // would fall through past this app-level middleware stack to Express's
  // own default (HTML) 404 — inconsistent for a JSON API — or, worse,
  // could be picked up by the SPA fallback below and answered 200 with
  // index.html. This guarantees every /api/* request is fully resolved
  // (matched route, or this JSON 404) before static-web serving is ever
  // reached, regardless of mount order elsewhere.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  // Critical Blocker Remediation, Phase 9 — production-mode deployment
  // readiness (closes gate blocker B4). No-op outside production, and
  // no-op in production if no built web app is present — see
  // lib/staticWeb.ts for the full design rationale.
  mountStaticWebIfPresent(app);

  // AE Step 2 closure — Part C: safety-net error handler, mounted last per
  // Express's own requirement (an error-handling middleware is only ever
  // invoked for requests that reach this point via next(err) or a
  // synchronous throw earlier in the chain). See middlewares/errorHandler.ts
  // for what this closes and why it's scoped the way it is.
  app.use(globalErrorHandler);
  return app;
}
