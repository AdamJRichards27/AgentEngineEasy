// AE Minimal v1.0 V7 (Owner t457u; Grok clearance 28 Oct 09:14 AEST): the
// Marketing group (Overview, Email, SMS, Social) with Better Marketing
// recommendations inside each channel page. Static sample previews only:
// nothing is sent or published, no provider, no API call. Views are rendered
// as plain function calls and the element tree is walked (no DOM, no network).
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Link } from "wouter";
import {
  MINIMAL_MARKETING_LINKS,
  MINIMAL_MARKETING_SOON,
  buildMinimalSidebar,
  minimalSidebarIsCurrent,
  minimalSidebarLinks,
  type MinimalSidebarItem,
} from "../../minimal/minimalNav";
import { minimalBreadcrumb } from "../minimalUx";
import {
  MARKETING_CHANNELS,
  MARKETING_SAMPLE_NOTICE,
  MARKETING_UNAVAILABLE_NOTICE,
  betterMarketingIdeas,
  marketingAllowed,
  marketingChannelTabs,
  marketingOverviewSample,
  parseMarketingPage,
  selectMarketingView,
  socialSampleAccounts,
} from "../../minimal/marketing/minimalMarketingModel";
import { MinimalMarketingView, type MinimalMarketingViewProps } from "../../minimal/marketing/MinimalMarketingView";

interface El { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (!node || typeof node !== "object") return "";
  const e = node as El;
  if (typeof e.type === "function" && e.type !== Link) return text((e.type as (p: unknown) => unknown)(e.props));
  return text(e.props?.children);
}
function all(node: unknown, pred: (e: El) => boolean): El[] {
  if (Array.isArray(node)) return node.flatMap((c) => all(c, pred));
  if (!node || typeof node !== "object") return [];
  const e = node as El;
  if (typeof e.type === "function" && e.type !== Link) return all((e.type as (p: unknown) => unknown)(e.props), pred);
  return (pred(e) ? [e] : []).concat(all(e.props?.children, pred));
}
const buttons = (tree: unknown) => all(tree, (e) => e.type === "button");
const links = (tree: unknown) => all(tree, (e) => e.type === Link).map((e) => ({ href: String(e.props?.href), text: text(e) }));
const flat = (s: string) => s.replace(/\s+/g, " ");

const GROW_ONLY = ["grow.access"];
const GROW_RUN = ["grow.access", "run.access"];
const off = { marketActivityAvailable: false, momentumAvailable: false };

function grow(entitlements: string[], role = "Agent"): MinimalSidebarItem[] {
  return buildMinimalSidebar({ role, entitlements, ...off }).find((g) => g.key === "grow")!.items;
}
function marketing(items: MinimalSidebarItem[]) {
  return items.find((i) => i.label === "Marketing");
}
function props(over: Partial<MinimalMarketingViewProps> = {}): MinimalMarketingViewProps {
  const calls: string[] = [];
  return {
    page: "overview",
    tab: "recommendations",
    previewId: null,
    on: {
      selectTab: (t) => calls.push(`tab:${t}`),
      preview: (id) => calls.push(`preview:${id}`),
      closePreview: () => calls.push("close"),
    },
    ...over,
  };
}

// ── Sidebar (minimalNav.ts, Marketing entry only) ──────────────────────────
test("V7 nav: with grow.access, Marketing is a link group: Overview, Email, SMS, Social", () => {
  for (const ents of [GROW_ONLY, GROW_RUN]) {
    const m = marketing(grow(ents));
    assert.ok(m && m.kind === "link", "Marketing is a link");
    assert.equal(m.href, "/grow/marketing");
    assert.deepEqual(m.children?.map((c) => [c.kind, c.label, c.kind === "link" ? c.href : ""]), [
      ["link", "Overview", "/grow/marketing/overview"],
      ["link", "Email", "/grow/marketing/email"],
      ["link", "SMS", "/grow/marketing/sms"],
      ["link", "Social", "/grow/marketing/social"],
    ]);
    assert.deepEqual(MINIMAL_MARKETING_LINKS.map((l) => l.label), [...MINIMAL_MARKETING_SOON]);
  }
});

test("V7 nav: Marketing stays last in Grow and no other Grow entry moves or is renamed", () => {
  const labels = grow(GROW_RUN).map((i) => i.label);
  assert.deepEqual(labels, ["Today", "Relationships", "Opportunities", "Appraisals", "Properties", "Marketing"]);
  const ops = buildMinimalSidebar({ role: "Brokerage Administrator", entitlements: GROW_RUN, ...off }).map((g) => [g.key, g.items.map((i) => i.label)]);
  assert.deepEqual(ops.slice(1), [
    ["operations", ["Run home", "Run today", "Exceptions", "Financial", "Start property", "Pit Crew"]],
    ["workspace", ["Communications", "Settings"]],
  ]);
});

test("V7 nav: without grow.access, Marketing stays a non-clickable Coming Soon placeholder", () => {
  for (const ents of [[], ["run.access"]]) {
    const m = marketing(grow(ents));
    assert.ok(m && m.kind === "soon");
    assert.deepEqual(m.children?.map((c) => [c.kind, c.label]), MINIMAL_MARKETING_SOON.map((l) => ["soon", l]));
    const hrefs = minimalSidebarLinks(buildMinimalSidebar({ role: "Agent", entitlements: ents, ...off })).map((l) => l.href);
    assert.equal(hrefs.some((h) => h.startsWith("/grow/marketing")), false);
  }
});

test("V7 nav: flat links, breadcrumb and current state for the Marketing pages", () => {
  const groups = buildMinimalSidebar({ role: "Agent", entitlements: GROW_ONLY, ...off });
  const flatLinks = minimalSidebarLinks(groups);
  const hrefs = flatLinks.map((l) => l.href);
  for (const h of ["/grow/marketing", "/grow/marketing/overview", "/grow/marketing/email", "/grow/marketing/sms", "/grow/marketing/social"]) {
    assert.equal(hrefs.filter((x) => x === h).length, 1, `${h} once`);
  }
  assert.deepEqual(minimalBreadcrumb("/grow/marketing/email", flatLinks), { section: "Grow", page: "Email" });
  assert.deepEqual(minimalBreadcrumb("/grow/marketing", flatLinks), { section: "Grow", page: "Marketing" });
  assert.equal(minimalSidebarIsCurrent("/grow/marketing/sms", "", "/grow/marketing/sms"), true);
  assert.equal(minimalSidebarIsCurrent("/grow/marketing/sms", "", "/grow/marketing/email"), false);
  assert.equal(minimalSidebarIsCurrent("/grow/marketing", "", "/grow"), false, "Today is not current on Marketing");
});

// ── Model ──────────────────────────────────────────────────────────────────
test("V7 model: page parsing, Minimal-only view, grow.access gate", () => {
  assert.equal(parseMarketingPage(undefined), "overview");
  assert.equal(parseMarketingPage("overview"), "overview");
  assert.equal(parseMarketingPage("email"), "email");
  assert.equal(parseMarketingPage("sms"), "sms");
  assert.equal(parseMarketingPage("social"), "social");
  assert.equal(parseMarketingPage("campaigns"), null);
  assert.equal(parseMarketingPage("EMAIL"), null);
  assert.equal(selectMarketingView(true), "minimal");
  assert.equal(selectMarketingView(false), "classic");
  assert.equal(marketingAllowed(["grow.access"]), true);
  assert.equal(marketingAllowed(["run.access"]), false);
  assert.equal(marketingAllowed(null), false);
  assert.deepEqual(MARKETING_CHANNELS, ["email", "sms", "social"]);
});

test("V7 model: Better Marketing ideas are sample-only for every channel", () => {
  for (const c of MARKETING_CHANNELS) {
    const ideas = betterMarketingIdeas(c);
    assert.ok(ideas.length >= 3, `${c} has ideas`);
    assert.equal(new Set(ideas.map((i) => i.id)).size, ideas.length, "ids unique");
    for (const i of ideas) {
      assert.equal(i.sample, true);
      assert.ok(i.title && i.summary && i.body);
    }
  }
  assert.ok(marketingOverviewSample().stats.every((s) => s.sample === true));
  assert.ok(socialSampleAccounts().every((a) => a.status === "Not connected"));
  assert.deepEqual(marketingChannelTabs("email").map((t) => [t.key, t.available]), [
    ["recommendations", true], ["create", false], ["templates", false], ["campaigns", false], ["performance", false],
  ]);
});

// ── Views ──────────────────────────────────────────────────────────────────
for (const page of ["overview", "email", "sms", "social"] as const) {
  test(`V7 view ${page}: sample notice, one h1, and every action that would send or publish is disabled`, () => {
    const tree = MinimalMarketingView(props({ page }));
    const t = flat(text(tree));
    assert.ok(t.includes(MARKETING_SAMPLE_NOTICE), "sample notice shown");
    assert.equal(all(tree, (e) => e.type === "h1").length, 1);
    const primary = buttons(tree).filter((b) => b.props?.["data-marketing-action"] === "primary");
    assert.equal(primary.length, 1, "one primary action");
    assert.equal(primary[0].props?.disabled, true, "primary action disabled");
    assert.equal(primary[0].props?.onClick, undefined, "primary action has no handler");
    assert.ok(t.includes(MARKETING_UNAVAILABLE_NOTICE), "unavailable reason shown");
    // No button anywhere sends, schedules or publishes.
    for (const b of buttons(tree)) {
      const label = flat(text(b)).trim();
      if (/send|publish|schedule|post now/i.test(label)) assert.equal(b.props?.disabled, true, label);
    }
  });
}

test("V7 view overview: sample figures are labelled, channel cards link to the three channel pages", () => {
  const tree = MinimalMarketingView(props({ page: "overview" }));
  const t = flat(text(tree));
  assert.match(t, /One thoughtful plan\. Every channel\./);
  for (const s of marketingOverviewSample().stats) assert.ok(t.includes(s.label));
  assert.match(t, /Sample/);
  const hrefs = links(tree).map((l) => l.href);
  for (const h of ["/grow/marketing/email", "/grow/marketing/sms", "/grow/marketing/social"]) assert.ok(hrefs.includes(h), h);
});

for (const page of ["email", "sms", "social"] as const) {
  test(`V7 view ${page}: Better Marketing recommendations sit inside the channel page, marked as sample`, () => {
    const tree = MinimalMarketingView(props({ page }));
    const t = flat(text(tree));
    assert.match(t, /Better Marketing/);
    assert.match(t, /Sample ideas/);
    for (const i of betterMarketingIdeas(page)) assert.ok(t.includes(i.title), i.title);
    const previews = buttons(tree).filter((b) => b.props?.["data-marketing-preview"]);
    assert.equal(previews.length, betterMarketingIdeas(page).length);
  });

  test(`V7 view ${page}: preview opens locally and says nothing was sent`, () => {
    const calls: string[] = [];
    const p = props({ page, on: { selectTab: () => {}, preview: (id) => calls.push(id), closePreview: () => calls.push("close") } });
    const tree = MinimalMarketingView(p);
    const first = buttons(tree).find((b) => b.props?.["data-marketing-preview"])!;
    (first.props!.onClick as () => void)();
    const id = betterMarketingIdeas(page)[0].id;
    assert.deepEqual(calls, [id]);
    const open = MinimalMarketingView({ ...p, previewId: id });
    const t = flat(text(open));
    assert.ok(t.includes(betterMarketingIdeas(page)[0].body));
    assert.match(t, /Preview only\. Nothing has been sent/);
  });

  test(`V7 view ${page}: tabs other than Recommendations show the unavailable state`, () => {
    for (const tab of marketingChannelTabs(page)) {
      const tree = MinimalMarketingView(props({ page, tab: tab.key }));
      const t = flat(text(tree));
      if (tab.available) assert.match(t, /Better Marketing/);
      else {
        assert.doesNotMatch(t, /Better Marketing/);
        assert.ok(t.includes(MARKETING_UNAVAILABLE_NOTICE));
      }
      const tabButtons = all(tree, (e) => e.props?.role === "tab");
      assert.equal(tabButtons.length, marketingChannelTabs(page).length);
      assert.equal(tabButtons.filter((b) => b.props?.["aria-selected"] === true).length, 1);
    }
  });
}

test("V7 view social: accounts are shown as not connected, never as connected", () => {
  const t = flat(text(MinimalMarketingView(props({ page: "social" }))));
  assert.match(t, /Not connected/);
  assert.doesNotMatch(t, /\bConnected\b(?! accounts)/);
});

// ── Source guards ──────────────────────────────────────────────────────────
const MARKETING_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../minimal/marketing");

test("V7 source: marketing files make no network call and hold no send or publish handler", () => {
  const files = readdirSync(MARKETING_DIR).filter((f) => /\.(ts|tsx)$/.test(f));
  assert.ok(files.length >= 3);
  for (const f of files) {
    const src = readFileSync(path.join(MARKETING_DIR, f), "utf8");
    for (const bad of [/apiFetch/, /\bfetch\(/, /useMutation/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /assertMessageMayLeave/, /\/send\b/]) {
      assert.doesNotMatch(src, bad, `${f} ${bad}`);
    }
  }
});

test("V7 source: the container gates on grow.access and redirects unknown pages", () => {
  const src = readFileSync(path.join(MARKETING_DIR, "MinimalMarketing.tsx"), "utf8");
  // Branches are decided by marketingRouteOutcome (grow.access, unknown page); see minimalMarketingRoute.test.ts.
  assert.match(src, /marketingRouteOutcome\(/);
  assert.match(src, /<Redirect to=\{outcome\.to\} replace \/>/);
});
