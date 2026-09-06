import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import { logger } from "@aee/events";
import { isProductionEnvironment } from "./env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Critical Blocker Remediation, Phase 9 — production-mode deployment
 * readiness.
 *
 * Closes gate blocker B4 ("no code anywhere serves the built web frontend
 * in any mode" — docs/OPERATIONAL_READINESS_GATE_REPORT.md §5). The
 * frontend's own fetch layer (apps/web/src/lib/api.ts) calls
 * `fetch(\`/api${path}\`, ...)` with a path-relative URL, which only
 * resolves to this API when the built frontend and this API are served
 * from the SAME origin. B4's own text framed the choice ("API-served
 * static vs. separate host") as an architecture decision this report does
 * not make unilaterally — this module makes that decision explicitly:
 * API-served static, because the frontend already assumes same-origin
 * (no configurable API base URL exists anywhere in apps/web) and adding
 * one would be a broader frontend change than closing the gap on the API
 * side. This is closing an existing, gate-blocking readiness gap, not
 * adding a speculative feature.
 *
 * Deliberately conservative:
 *  - Only ever activates when NODE_ENV=production (isProductionEnvironment()).
 *    Local/dev workflows are entirely unaffected: Vite's own dev server
 *    continues to serve the frontend with hot reload, proxying /api to
 *    this API (see apps/web/vite.config.ts) exactly as before.
 *  - Only activates if a built web app is actually present at boot,
 *    checked once (not per request) — an API-only production deployment
 *    (see docs/REPLIT_PILOT_DEPLOYMENT_RUNBOOK.md's two-deployment
 *    option) boots and behaves exactly as before: a pure JSON API, no
 *    static-file behaviour at all.
 *  - Never intercepts a request whose path starts with /api. By the time
 *    this is mounted (see app.ts), every /api/* request has already been
 *    resolved by apiRouter or the explicit JSON 404 handler mounted
 *    immediately after it — this module's own catch-all route additionally
 *    excludes any /api/* path by regex, as defence in depth against a
 *    future reordering.
 */
export function mountStaticWebIfPresent(app: Express): void {
  if (!isProductionEnvironment()) return;

  const distDir = process.env.WEB_DIST_DIR ? path.resolve(process.env.WEB_DIST_DIR) : path.resolve(__dirname, "../../web/dist");
  const indexHtmlPath = path.join(distDir, "index.html");

  if (!fs.existsSync(indexHtmlPath)) {
    logger.info("static_web_not_present", { distDir });
    return;
  }

  logger.info("static_web_mounted", { distDir });

  // Serve hashed build assets (JS/CSS/images) directly; index:false so a
  // bare "/" request falls through to the SPA-fallback route below rather
  // than this middleware serving index.html itself (kept as one single,
  // clearly-commented route for both "/" and every client-side route).
  app.use(express.static(distDir, { index: false }));

  // SPA fallback: any GET that isn't /api/* and didn't match a real static
  // file (JS/CSS/images all get matched and returned above) is a
  // client-side route (see apps/web/src/App.tsx's wouter <Switch>) —
  // serve index.html and let the client-side router take it from there.
  app.get(/^\/(?!api(\/|$)).*/, (_req, res) => {
    res.sendFile(indexHtmlPath);
  });
}
