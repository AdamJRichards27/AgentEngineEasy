// AE GROW Pilot Readiness WP8 — D-web-3: the Vite dev server's /api proxy
// target is configurable.
//
// vite.config.ts used to hard-code http://localhost:8080, so a dev/QA web
// server could not be pointed at a second API instance without editing the
// file — and because the proxy still "worked", a smoke run against what
// everyone believed was the second API silently hit the first one instead.
//
// Dev-server only: a production build serves static assets and talks to
// whatever origin actually hosts /api, so nothing below runs in the shipped
// bundle. It lives in src/lib (rather than inline in vite.config.ts) purely so
// the resolution rules can be unit tested with the same `tsx --test` runner as
// every other lib/ module.

export const DEFAULT_API_PROXY_TARGET = "http://localhost:8080";

// Checked in order; the first one actually set wins. VITE_-prefixed first so
// the same name works in a .env file that Vite already loads, with the bare
// name kept as a convenience for a one-off `API_PROXY_TARGET=… pnpm dev`.
export const API_PROXY_TARGET_ENV_VARS = ["VITE_API_PROXY_TARGET", "API_PROXY_TARGET"] as const;

// A malformed value throws rather than quietly falling back to the default:
// silently proxying to the wrong API is the exact failure this fix exists to
// remove, so a typo must stop the dev server with a readable message instead
// of producing another invalid smoke run.
export function resolveApiProxyTarget(env: Record<string, string | undefined> = {}): string {
  for (const name of API_PROXY_TARGET_ENV_VARS) {
    const raw = env[name]?.trim();
    // Unset or blank is "not configured", so the next name (then the default)
    // gets its turn — an empty string in a .env file must not be an error.
    if (!raw) continue;
    if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(raw)) {
      throw new Error(
        `${name} must be an http(s) URL such as ${DEFAULT_API_PROXY_TARGET} — received ${JSON.stringify(raw)}.`,
      );
    }
    // Trailing slashes are dropped: http-proxy appends the matched path, so
    // "http://host:8080/" would proxy /api/x to //api/x.
    return raw.replace(/\/+$/, "");
  }
  return DEFAULT_API_PROXY_TARGET;
}
