import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolveApiProxyTarget } from "./src/lib/devProxy";

// AE GROW Pilot Readiness WP8 — the dev-server /api proxy target is read from
// VITE_API_PROXY_TARGET (or API_PROXY_TARGET), defaulting to the
// http://localhost:8080 it was previously hard-coded to, so a dev/QA web
// server can be pointed at a second API instance without editing this file:
//
//   VITE_API_PROXY_TARGET=http://localhost:8081 pnpm --filter @aee/web dev
//
// A malformed value throws here rather than quietly falling back — a proxy
// silently pointing at the wrong API is what invalidated part of a smoke run.
// See src/lib/devProxy.ts (and its tests) for the exact rules. Dev server
// only: a production build serves static assets and talks to whichever origin
// actually hosts /api, so this has no effect on `vite build` output.
const apiProxyTarget = resolveApiProxyTarget(process.env);

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Replit (and similar cloud IDEs) serve the dev server through a proxy
    // on a dynamic, per-project *.replit.dev hostname. Vite's default host
    // check rejects any Host header it doesn't recognize ("Blocked
    // request"), so we allow all hosts here — this dev server is not
    // exposed as a production build, only as a local/sandboxed preview.
    allowedHosts: true,
    proxy: {
      "/api": apiProxyTarget,
    },
  },
});
