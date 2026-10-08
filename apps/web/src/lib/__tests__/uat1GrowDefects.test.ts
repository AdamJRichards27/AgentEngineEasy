// UAT Round 1 web defects: sign-out leaves the signed-in screen (D1),
// Grow tables widen the page (D4), phone tap targets (D7), the
// checklist's Add note hint (D8), Active Properties saying "You"
// for every owner (D9), and stat tiles widening a 320px page (D10).
// D5 is locked in the contact and link-property behavior tests.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { logoutAndClearSession, reloadPageRestoredFromCache } from "../session";
import { responsibilityLabel } from "../commandCentre";
import { growFirstRunSteps } from "../growFirstRun";
import type { GrowTodayFirstRun } from "../growToday";

const webSrc = new URL("../../", import.meta.url);

function sourceFiles(dir: URL): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const next = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      found.push(...sourceFiles(next));
    } else if (entry.name.endsWith(".tsx")) {
      found.push(readFileSync(next, "utf8"));
    }
  }
  return found;
}

test("D1: logout clears the mounted session observer and replaces history with /login", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } },
  });
  const user = {
    id: 1,
    email: "agent-a@example.test",
    firstName: "Agent",
    lastName: "A",
    role: "Agent",
    brokerageId: 1,
    brokerageName: "UAT Round 1",
  };
  queryClient.setQueryData(["session"], { user, entitlements: ["grow.access"] });
  queryClient.setQueryData(["grow-contacts", ""], { contacts: [{ id: 9, displayName: "Sam" }] });
  queryClient.setQueryData(["grow-relationships"], { relationships: [{ id: 3 }] });
  queryClient.setQueryData(["grow-today"], { firstRun: { contact: true } });

  const observer = new QueryObserver<
    { user: typeof user | null; entitlements: string[] } | null,
    Error,
    typeof user | null
  >(queryClient, {
    queryKey: ["session"],
    queryFn: async () => {
      throw new Error("session must not refetch during logout");
    },
    select: (data) => data?.user ?? null,
    retry: false,
    staleTime: 30_000,
  });
  let seen = observer.getCurrentResult();
  const unsubscribe = observer.subscribe((result) => {
    seen = result;
  });

  assert.equal(seen.data?.firstName, "Agent");

  const calls: Array<{ url: string; method?: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const navigations: Array<{ to: string; replace?: boolean }> = [];
  try {
    await logoutAndClearSession(queryClient, (to, options) => {
      navigations.push({ to, replace: options?.replace });
    });
  } finally {
    globalThis.fetch = originalFetch;
    unsubscribe();
  }

  assert.deepEqual(calls, [{ url: "/api/auth/logout", method: "POST" }]);
  assert.deepEqual(navigations, [{ to: "/login", replace: true }]);
  assert.equal(seen.data, null, "the mounted session observer drops the previous user");
  assert.equal(seen.error, null);
  assert.equal(queryClient.getQueryData(["session"]), null);
  assert.equal(queryClient.getQueryData(["grow-contacts", ""]), undefined);
  assert.equal(queryClient.getQueryData(["grow-relationships"]), undefined);
  assert.equal(queryClient.getQueryData(["grow-today"]), undefined);
});

test("D1: logout still leaves for the sign-in page when the logout request fails", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  queryClient.setQueryData(["session"], {
    user: { id: 2, firstName: "Agent", lastName: "B", email: "b@example.test", role: "Agent", brokerageId: 1, brokerageName: null },
    entitlements: [],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("network down");
  }) as typeof fetch;
  const navigations: Array<{ to: string; replace?: boolean }> = [];
  try {
    await logoutAndClearSession(queryClient, (to, options) => {
      navigations.push({ to, replace: options?.replace });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(navigations, [{ to: "/login", replace: true }]);
  assert.equal(queryClient.getQueryData(["session"]), null);
});

test("D1: a back-forward cache restore reloads so the stale signed-in screen cannot stick", () => {
  const reloads: number[] = [];
  reloadPageRestoredFromCache({ persisted: false }, () => reloads.push(1));
  assert.deepEqual(reloads, []);
  reloadPageRestoredFromCache({ persisted: true }, () => reloads.push(1));
  assert.deepEqual(reloads, [1]);
});

test("D1 and D8: the sign-in gate replaces history, and the staging strip is on every route", () => {
  const app = readFileSync(new URL("App.tsx", webSrc), "utf8");
  const bannerAt = app.indexOf('className="staging-banner"');
  const switchAt = app.indexOf("<Switch>");
  assert.ok(bannerAt >= 0 && switchAt > bannerAt, "the staging strip renders outside the signed-in shell");
  assert.equal(app.split('className="staging-banner"').length - 1, 1);
  assert.match(app, /<Redirect to="\/login" replace \/>/);
});

test("D4: every grow-table sits in a scroll container that cannot widen the page", () => {
  const css = readFileSync(new URL("styles.css", webSrc), "utf8");
  assert.match(css, /\.grow-table-scroll\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.grow-table-scroll\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /\.app-shell\s*\{[^}]*min-width:\s*0/s);

  const tables: string[] = [];
  for (const source of sourceFiles(webSrc)) {
    const matches = source.match(/<table className="grow-table">/g);
    if (matches) tables.push(...matches);
    const stripped = source.replace(/<GrowTableScroll(?:\s[^>]*)?>\s*<table className="grow-table">/g, "");
    assert.equal(stripped.includes('<table className="grow-table">'), false, "a grow-table is missing GrowTableScroll");
  }
  assert.ok(tables.length >= 5, "expected the Grow tables to still be present");
});

function phoneBlocks(css: string): Array<{ index: number; rules: string }> {
  return [...css.matchAll(/@media \(max-width: 899px\) \{([\s\S]*?)\n\}/g)].map((match) => ({
    index: match.index ?? -1,
    rules: match[1],
  }));
}

test("D7: phone widths give nav, Sign out, and small buttons a 44px target without changing desktop", () => {
  const css = readFileSync(new URL("styles.css", webSrc), "utf8");
  const phones = phoneBlocks(css);
  const nav = phones.find((block) => block.rules.includes(".app-sidebar-link") && block.rules.includes(".app-sidebar-signout"));
  assert.ok(nav, "phone tap-target media query is missing");
  assert.match(nav.rules, /min-height:\s*44px/);
  assert.match(nav.rules, /min-width:\s*44px/);

  // .btn-small { min-height: 32px } is one class. The first phone block used
  // the same specificity and came first, so the 32px rule won. The 44px
  // override has to be more specific (.btn.btn-small) and later in the file.
  const baseSmall = css.match(/\.btn-small\s*\{[^}]*\}/);
  assert.ok(baseSmall);
  assert.match(baseSmall[0], /min-height:\s*32px/);
  assert.equal(/min-height:\s*44px/.test(baseSmall[0]), false);
  const baseAt = css.indexOf(baseSmall[0]);
  const controls = phones.filter((block) => /\.btn\.btn-small[^{]*\{[^}]*min-height:\s*44px/.test(block.rules));
  assert.equal(controls.length, 1);
  assert.ok(controls[0].index > baseAt, "44px small-button rule must come after the 32px rule");
  assert.match(controls[0].rules, /\.btn\.btn-small[^{]*\{[^}]*min-width:\s*44px/);
  const afterControls = css.slice(controls[0].index + controls[0].rules.length);
  assert.equal(/\.btn-small[^{]*\{[^}]*min-height:\s*32px/.test(afterControls), false);

  assert.match(controls[0].rules, /\.pc-tab[^{]*\{[^}]*min-height:\s*44px/);
  assert.match(controls[0].rules, /\.grow-contact-roles button\.pill[^{]*\{[^}]*min-height:\s*44px/);
  assert.equal(/(^|[}\n])\s*\.pill[^{]*\{[^}]*min-height:\s*44px/.test(controls[0].rules), false);

  const linkRules = controls[0].rules.match(/a:not\(\.btn\):not\(\.app-sidebar-link\):not\(\.stat-tile\)(?:::after)?[^{]*\{[^}]*\}/g);
  assert.ok(linkRules && linkRules.length >= 2, "inline links need a hit area that is separate from the text");
  assert.ok(linkRules.some((rule) => /::after/.test(rule) && /height:\s*44px/.test(rule)));
  for (const rule of linkRules) {
    assert.equal(/\b(font-size|color|text-decoration|font-weight|padding)\s*:/.test(rule), false);
  }

  const desktop = css.match(/@media \(min-width: 900px\) \{([\s\S]*?)\n\}/);
  assert.ok(desktop);
  assert.equal(desktop[1].includes("44px"), false);
});

test("D10: stat tiles shrink to the page and long labels can break", () => {
  const css = readFileSync(new URL("styles.css", webSrc), "utf8");
  assert.match(css, /\.stat-tiles\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.stat-tiles\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.stat-tile\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.stat-tile-label\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.stat-tile-label\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.stat-tile-value\s*\{[^}]*flex-shrink:\s*0/);
  const wide = [...css.matchAll(/@media \(min-width: 640px\) \{([\s\S]*?)\n\}/g)].map((match) => match[1]);
  assert.ok(wide.some((rules) => /\.stat-tiles\s*\{[^}]*repeat\(4,\s*minmax\(0,\s*1fr\)\)/.test(rules)));
  assert.equal(css.includes("repeat(2, 1fr)"), false);
  assert.equal(css.includes("repeat(4, 1fr)"), false);
});

test("D8: the Add note checklist step points at the opportunity row", () => {
  const flags: GrowTodayFirstRun = {
    contact: false,
    propertyLink: false,
    activity: false,
    commitment: false,
    opportunity: false,
    appraisal: false,
  };
  const activity = growFirstRunSteps(flags, () => true).find((step) => step.id === "activity");
  assert.ok(activity);
  assert.equal(activity.section, "opportunities");
  assert.match(activity.hint, /Add note on the row/);
  assert.equal(activity.hint.includes("Open a contact"), false);
  assert.equal(activity.actionLabel, "Add note");
});

test("D9: Active Properties says You only when the viewer is the responsible agent", () => {
  const agentA = { responsibleAgentId: 10, responsibleAgentName: "Agent A" };
  const agentB = { responsibleAgentId: 11, responsibleAgentName: "Agent B" };
  const adminId = 99;

  assert.equal(responsibilityLabel("AGENT", agentA.responsibleAgentId, agentA), "You");
  assert.equal(responsibilityLabel("AGENT", adminId, agentA), "Agent A");
  assert.equal(responsibilityLabel("AGENT", adminId, agentB), "Agent B");
  assert.equal(responsibilityLabel("AGENT", agentB.responsibleAgentId, agentA), "Agent A");
  assert.equal(
    responsibilityLabel("AGENT", adminId, { responsibleAgentId: 12, responsibleAgentName: "  " }),
    "Agent",
  );
  assert.equal(responsibilityLabel("PIT_CREW", adminId, agentA), "Pit Crew");
  assert.equal(responsibilityLabel("SHARED", agentA.responsibleAgentId, agentA), "Shared");

  const page = readFileSync(new URL("pages/CommandCentre.tsx", webSrc), "utf8");
  assert.match(page, /viewerId=\{data\.agent\.id\}/);
  assert.match(page, /responsibilityLabel\(p\.responsibility, viewerId, p\)/);
});
