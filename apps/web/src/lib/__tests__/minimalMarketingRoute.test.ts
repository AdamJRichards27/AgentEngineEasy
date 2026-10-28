// V7 Marketing route (Grok clearance 28 Oct 10:00 AEST): App.tsx /grow/marketing/:page?
// renders the Marketing page in the Minimal shell for grow.access users, redirects to
// /grow outside the Minimal shell or without access, and sends unknown pages to Overview.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { marketingRouteOutcome, selectMarketingView } from "../../minimal/marketing/minimalMarketingModel";

const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
const routesSrc = app.slice(app.indexOf("function AuthenticatedRoutes"));
const ROUTE_PATHS = [...routesSrc.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);

// wouter (non-nested Route in a Switch): exact match, ":name" = one segment,
// ":name?" = optional segment, first match wins.
function toRegex(pattern: string): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = pattern
    .split("/")
    .filter(Boolean)
    .map((seg) => (/^:[A-Za-z]+\?$/.test(seg) ? "(?:/[^/]+)?" : /^:[A-Za-z]+$/.test(seg) ? "/[^/]+" : `/${esc(seg)}`))
    .join("");
  return new RegExp(`^${body}/?$`, "i");
}
const firstMatch = (path: string) => ROUTE_PATHS.find((p) => toRegex(p).test(path));

test("route: /grow/marketing/:page? is declared once, before /grow", () => {
  assert.equal(ROUTE_PATHS.filter((p) => p === "/grow/marketing/:page?").length, 1);
  assert.ok(ROUTE_PATHS.indexOf("/grow/marketing/:page?") < ROUTE_PATHS.indexOf("/grow"));
});

test("route: first match sends every Marketing URL to the Marketing route and nothing else moves", () => {
  for (const url of ["/grow/marketing", "/grow/marketing/", "/grow/marketing/overview", "/grow/marketing/email", "/grow/marketing/sms", "/grow/marketing/social", "/grow/marketing/campaigns"]) {
    assert.equal(firstMatch(url), "/grow/marketing/:page?", url);
  }
  assert.notEqual(firstMatch("/grow/marketing/email/extra"), "/grow/marketing/:page?");
  const unchanged: Record<string, string> = {
    "/grow": "/grow",
    "/grow/market-activity": "/grow/market-activity",
    "/grow/momentum": "/grow/momentum",
    "/grow/opportunities": "/grow/opportunities",
    "/grow/contacts/3": "/grow/contacts/:id",
  };
  for (const [url, route] of Object.entries(unchanged)) assert.equal(firstMatch(url), route, url);
});

test("route: lazy page, Minimal shell only, classic redirects to /grow", () => {
  assert.match(app, /const MinimalMarketing = lazy\(\(\) => import\("\.\/minimal\/marketing\/MinimalMarketing"\)\);/);
  assert.match(app, /import \{ selectMarketingView \} from "\.\/minimal\/marketing\/minimalMarketingModel";/);
  assert.match(
    app,
    /<Route path="\/grow\/marketing\/:page\?">\s*\{selectMarketingView\(minimalShell\) === "minimal" \? <MinimalMarketing \/> : <Redirect to="\/grow" replace \/>\}\s*<\/Route>/,
  );
  assert.equal(selectMarketingView(true), "minimal");
  assert.equal(selectMarketingView(false), "classic");
});

test("route: in the Minimal shell, grow.access renders; no access or unknown page redirects", () => {
  const grow = ["grow.access"];
  assert.deepEqual(marketingRouteOutcome(grow, false, undefined), { kind: "render", page: "overview" });
  assert.deepEqual(marketingRouteOutcome(grow, false, "overview"), { kind: "render", page: "overview" });
  for (const p of ["email", "sms", "social"] as const) assert.deepEqual(marketingRouteOutcome(grow, false, p), { kind: "render", page: p });
  assert.deepEqual(marketingRouteOutcome(grow, false, "campaigns"), { kind: "redirect", to: "/grow/marketing" });
  assert.deepEqual(marketingRouteOutcome(grow, false, "EMAIL"), { kind: "redirect", to: "/grow/marketing" });
  for (const ents of [[], ["run.access"], ["grow.campaigns.use"]]) {
    assert.deepEqual(marketingRouteOutcome(ents, false, "email"), { kind: "redirect", to: "/grow" }, JSON.stringify(ents));
  }
  // Fails closed while entitlements load: nothing rendered, no redirect yet.
  assert.deepEqual(marketingRouteOutcome([], true, "email"), { kind: "loading" });
  assert.deepEqual(marketingRouteOutcome(grow, true, "email"), { kind: "loading" });
});

test("route: the container uses marketingRouteOutcome for every branch", () => {
  const src = readFileSync(new URL("../../minimal/marketing/MinimalMarketing.tsx", import.meta.url), "utf8");
  assert.match(src, /marketingRouteOutcome\(entitlements, isLoading, params\.page\)/);
  assert.match(src, /outcome\.kind === "loading"/);
  assert.match(src, /<Redirect to=\{outcome\.to\} replace \/>/);
});
