import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { formatGeneratedAt } from "../commandCentre.ts";
import {
  commandCentreCrossLink,
  commandCentreGreeting,
  GROW_TODAY_PATH,
  GROW_TODAY_PURPOSE,
  GROW_TODAY_TITLE,
  growTodayCrossLink,
  growTodayHeading,
  RUN_COMMAND_CENTRE_NAME,
  RUN_COMMAND_CENTRE_PATH,
  RUN_COMMAND_CENTRE_PURPOSE,
  RUN_COMMAND_CENTRE_TITLE,
} from "../todaySurfaces.ts";

// G-3 — Grow Today and the RUN Command Centre used the same "what needs your
// attention" pitch, shared the internal name "Daily Command Centre", and did
// not link to each other. These tests lock the distinct copy, the cross-links,
// and the separate query keys. They do not merge the two reads.

const OLD_GROW_PITCH = "here's what needs your attention today";
const OLD_COMMAND_CENTRE_PITCH = "What needs your attention today, across every property you can see.";
const SHARED_INTERNAL_NAME = "Daily Command Centre";

interface ElementNode {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
}

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!node || typeof node !== "object") return "";
  return textContent((node as ElementNode).props?.children);
}

function findAll(node: unknown, predicate: (element: ElementNode) => boolean): ElementNode[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate));
  if (!node || typeof node !== "object") return [];
  const element = node as ElementNode;
  const own = predicate(element) ? [element] : [];
  return own.concat(findAll(element.props?.children, predicate));
}

function linkByLabel(tree: unknown, label: string): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "a" && textContent(element).includes(label))[0];
}

function pageSource(name: string): string {
  return readFileSync(new URL(`../../pages/${name}`, import.meta.url), "utf8");
}

function growModuleSources(): Array<[string, string]> {
  const dir = new URL("../../grow/", import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => [name, readFileSync(new URL(name, dir), "utf8")]);
}

test("G-3: the shared copy names two screens, two paths, and two purposes", () => {
  assert.equal(GROW_TODAY_PATH, "/grow");
  assert.equal(RUN_COMMAND_CENTRE_PATH, "/today");
  assert.notEqual(GROW_TODAY_PURPOSE, RUN_COMMAND_CENTRE_PURPOSE);
  assert.equal(growTodayHeading("Sam"), "Hi Sam — Grow Today");
  assert.equal(growTodayHeading("  "), GROW_TODAY_TITLE);
  assert.equal(growTodayHeading(undefined), GROW_TODAY_TITLE);
  assert.equal(
    commandCentreGreeting("Sam", "24 Sep, 11:00 am", "Australia/Brisbane"),
    "Hi Sam — Command Centre for property work, as of 24 Sep, 11:00 am (Australia/Brisbane).",
  );
  assert.equal(growTodayCrossLink.href, RUN_COMMAND_CENTRE_PATH);
  assert.equal(growTodayCrossLink.label, RUN_COMMAND_CENTRE_NAME);
  assert.equal(commandCentreCrossLink.href, GROW_TODAY_PATH);
  assert.equal(commandCentreCrossLink.label, GROW_TODAY_TITLE);
  assert.notEqual(growTodayCrossLink.distinction, commandCentreCrossLink.distinction);
  for (const sentence of [
    GROW_TODAY_PURPOSE,
    RUN_COMMAND_CENTRE_PURPOSE,
    growTodayCrossLink.distinction,
    commandCentreCrossLink.distinction,
    growTodayHeading("Sam"),
    commandCentreGreeting("Sam", "24 Sep, 11:00 am", "Australia/Brisbane"),
  ]) {
    assert.equal(sentence.includes(SHARED_INTERNAL_NAME), false, sentence);
    assert.equal(sentence.includes(OLD_GROW_PITCH), false, sentence);
    assert.equal(sentence.includes(OLD_COMMAND_CENTRE_PITCH), false, sentence);
  }
  assert.equal(GROW_TODAY_PURPOSE.includes(RUN_COMMAND_CENTRE_PURPOSE), false);
  assert.equal(RUN_COMMAND_CENTRE_PURPOSE.includes(GROW_TODAY_PURPOSE), false);
});

test("G-3: the two pages no longer sell one Daily Command Centre", () => {
  const growToday = readFileSync(new URL("../../grow/GrowToday.tsx", import.meta.url), "utf8");
  const surfaces: Array<[string, string]> = [
    ["Grow.tsx", pageSource("Grow.tsx")],
    ["CommandCentre.tsx", pageSource("CommandCentre.tsx")],
    ...growModuleSources(),
  ];
  for (const [name, source] of surfaces) {
    assert.equal(source.includes(SHARED_INTERNAL_NAME), false, name);
    assert.equal(source.includes(OLD_GROW_PITCH), false, name);
    assert.equal(source.includes(OLD_COMMAND_CENTRE_PITCH), false, name);
    assert.equal(source.includes("here's what needs your attention"), false, name);
    if (name !== "CommandCentre.tsx") {
      assert.equal(source.includes('queryKey: ["command-centre"]'), false, name);
    }
  }
  assert.match(growToday, /growTodayCrossLink/);
  assert.match(pageSource("CommandCentre.tsx"), /commandCentreCrossLink/);
  assert.match(growToday, /queryKey: \["grow-today"\]/);
  assert.match(pageSource("CommandCentre.tsx"), /queryKey: \["command-centre"\]/);
  assert.equal(pageSource("CommandCentre.tsx").includes('queryKey: ["grow-today"]'), false);
});

const virtualMocks: Plugin = {
  name: "g3-today-surface-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:g3-react") return "\0g3-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:g3-jsx") return "\0g3-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:g3-query") return "\0g3-query";
    if (source === "wouter" || source === "virtual:g3-wouter") return "\0g3-wouter";
    if (source === "../lib/api" || source === "../../lib/api") return "\0g3-api";
    if (source === "../lib/session") return "\0g3-session";
    if (
      source === "../components/AskAgentEngine" ||
      source === "../components/CommunicationsSection" ||
      source === "../components/PropertyIntelligencePanel" ||
      source === "../components/GrowContactTranscriptPanel" ||
      source === "../components/GrowPendingCommitmentProposals" ||
      source === "../components/ErrorBoundary"
    ) {
      return "\0g3-components";
    }
    return null;
  },
  load(id) {
    if (id === "\0g3-react") {
      return `
        export const useState = (initial) => [typeof initial === "function" ? initial() : initial, () => {}];
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0g3-jsx") {
      return `
        export const Fragment = Symbol.for("g3-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0g3-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries() {} });
        export const useQuery = (options) => {
          const key = JSON.stringify(options.queryKey);
          globalThis.__g3QueryKeys.push(key);
          const table = globalThis.__g3Queries;
          if (table && Object.prototype.hasOwnProperty.call(table, key)) return table[key];
          return { isLoading: true, isError: false, data: undefined, refetch() {} };
        };
        export const useMutation = () => ({ isPending: false, isError: false, error: null, mutate() {} });
      `;
    }
    if (id === "\0g3-wouter") {
      return `export const Link = (props) => ({ type: "a", props }); export const useSearch = () => "";`;
    }
    if (id === "\0g3-api") {
      return `
        export class ApiError extends Error {}
        export const apiFetch = () => Promise.resolve({});
        export function apiErrorMessage(error, fallback) {
          if (error instanceof ApiError && typeof error.friendly === "string" && error.friendly.trim()) return error.friendly;
          return fallback;
        }
      `;
    }
    if (id === "\0g3-session") {
      return `
        export const useSession = () => globalThis.__g3Session;
        export const useEntitlements = () => ({
          isLoading: false,
          hasEntitlement: (key) => globalThis.__g3Entitlements.includes(key),
        });
      `;
    }
    if (id === "\0g3-components") {
      return `
        export const AskAgentEngine = () => null;
        export const ContactCommunicationsSection = () => null;
        export const PropertyIntelligencePanel = () => null;
        export const GrowContactTranscriptPanel = () => null;
        export const GrowPendingCommitmentProposals = () => null;
        export const ErrorBoundary = (props) => props.children;
      `;
    }
    return null;
  },
};

async function withVite<T>(run: (vite: ViteDevServer) => Promise<T>): Promise<T> {
  const vite = await createServer({
    root: new URL("../../..", import.meta.url).pathname,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: true },
    resolve: {
      alias: [
        { find: /^react$/, replacement: "virtual:g3-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:g3-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:g3-query" },
        { find: /^wouter$/, replacement: "virtual:g3-wouter" },
      ],
    },
    plugins: [virtualMocks],
  });
  try {
    return await run(vite);
  } finally {
    await vite.close();
  }
}

function installGlobals(queries: Record<string, unknown>, session: { user: { firstName: string } | null }) {
  Object.assign(globalThis, {
    __g3QueryKeys: [] as string[],
    __g3Queries: queries,
    __g3Session: session,
    __g3Entitlements: [] as string[],
  });
}

function clearGlobals() {
  for (const key of ["__g3QueryKeys", "__g3Queries", "__g3Session", "__g3Entitlements"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

function queryKeys(): string[] {
  return (globalThis as { __g3QueryKeys: string[] }).__g3QueryKeys;
}

const GENERATED_AT = "2026-09-24T01:00:00.000Z";

function growQuery(state: "ready" | "loading" | "error") {
  if (state === "loading") return { isLoading: true, isError: false, data: undefined, refetch() {} };
  if (state === "error") {
    return { isLoading: false, isError: true, error: new Error("down"), data: undefined, refetch() {} };
  }
  return {
    isLoading: false,
    isError: false,
    refetch() {},
    data: {
      generatedAt: GENERATED_AT,
      hasAnyGrowData: true,
      counts: { priorityActions: 0, followUpsDue: 0, openOpportunities: 0, contactsNeedingAttention: 0 },
      priorityActions: [],
      signalSummary: { surfaced: 0, emergingSurfaced: 0, emergingWithheld: 0, withheldDoNotContact: 0 },
    },
  };
}

function commandCentreQuery(state: "ready" | "loading") {
  if (state === "loading") return { isLoading: true, isError: false, data: undefined, refetch() {} };
  const empty: unknown[] = [];
  return {
    isLoading: false,
    isError: false,
    refetch() {},
    data: {
      generatedAt: GENERATED_AT,
      timeZone: "Australia/Brisbane",
      timeZoneSource: "brokerage",
      agent: { id: 1, firstName: "Sam", role: "Agent" },
      summary: { critical: 0, attention: 0, dueToday: 0, overdue: 0, waitingOn: 0, comingUp: 0, pcActive: 0 },
      now: empty,
      today: empty,
      overdue: empty,
      waitingOn: empty,
      comingUp: empty,
      activeProperties: empty,
      pitCrew: empty,
      completedToday: empty,
    },
  };
}

function growProps() {
  return {
    onAskAE: () => {},
    onViewContact: () => {},
    onEmailContact: () => {},
    onSmsContact: () => {},
  };
}

function assertNoSharedPitch(text: string) {
  assert.equal(text.includes(SHARED_INTERNAL_NAME), false);
  assert.equal(text.includes(OLD_GROW_PITCH), false);
  assert.equal(text.includes(OLD_COMMAND_CENTRE_PITCH), false);
  assert.equal(text.includes("here's what needs your attention"), false);
}

test("G-3: Grow Today names itself and links to the Command Centre without reading it", async () => {
  installGlobals({ '["grow-today"]': growQuery("ready") }, { user: { firstName: "Sam" } });
  try {
    await withVite(async (vite) => {
      const { GrowToday } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowToday: (props: Record<string, unknown>) => unknown;
      };
      const tree = GrowToday(growProps());
      const text = textContent(tree);

      assert.match(text, /Hi Sam — Grow Today/);
      assert.match(text, new RegExp(GROW_TODAY_PURPOSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(text.includes(RUN_COMMAND_CENTRE_PURPOSE), false);
      assert.match(text, /Property delivery is a different screen\./);
      assert.equal(text.includes("Relationship follow-up is a different screen."), false);
      assert.match(text, /You're all caught up/);
      assertNoSharedPitch(text);

      const link = linkByLabel(tree, "Command Centre");
      assert.ok(link, "Grow Today links to the Command Centre");
      assert.equal(link.props?.href, "/today");
      assert.deepEqual(queryKeys(), ['["grow-today"]']);
    });
  } finally {
    clearGlobals();
  }
});

test("G-3: a Grow Today load or failure still offers the Command Centre, with no entitlement gate on the link", async () => {
  installGlobals(
    {
      '["grow-today"]': growQuery("loading"),
    },
    { user: null },
  );
  try {
    await withVite(async (vite) => {
      const { GrowToday } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowToday: (props: Record<string, unknown>) => unknown;
      };
      const loading = GrowToday(growProps());
      const loadingText = textContent(loading);
      assert.match(loadingText, /Grow Today/);
      assert.equal(loadingText.includes("Hi Sam"), false);
      assert.match(loadingText, /Loading today's priorities/);
      assert.equal(linkByLabel(loading, "Command Centre")?.props?.href, "/today");
      assert.equal((globalThis as { __g3Entitlements: string[] }).__g3Entitlements.length, 0);

      (globalThis as { __g3Queries: Record<string, unknown> }).__g3Queries['["grow-today"]'] = growQuery("error");
      (globalThis as { __g3QueryKeys: string[] }).__g3QueryKeys = [];
      const failed = GrowToday(growProps());
      const failedText = textContent(failed);
      assert.match(failedText, /Couldn't load Today\./);
      assert.equal(linkByLabel(failed, "Command Centre")?.props?.href, "/today");
      assert.match(failedText, new RegExp(GROW_TODAY_PURPOSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.deepEqual(queryKeys(), ['["grow-today"]']);
      assertNoSharedPitch(failedText);
    });
  } finally {
    clearGlobals();
  }
});

test("G-3: Command Centre names property work and links to Grow Today without reading it", async () => {
  installGlobals({ '["command-centre"]': commandCentreQuery("ready") }, { user: null });
  try {
    await withVite(async (vite) => {
      const page = (await vite.ssrLoadModule("/src/pages/CommandCentre.tsx")) as {
        default: () => unknown;
      };
      const tree = page.default();
      const text = textContent(tree);
      const greeting = commandCentreGreeting("Sam", formatGeneratedAt(GENERATED_AT), "Australia/Brisbane");

      assert.match(text, /^RUN/);
      assert.ok(findAll(tree, (element) => element.type === "h1" && textContent(element) === RUN_COMMAND_CENTRE_TITLE)[0]);
      assert.match(text, new RegExp(RUN_COMMAND_CENTRE_PURPOSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(text.includes(GROW_TODAY_PURPOSE), false);
      assert.match(text, new RegExp(greeting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(text, /Relationship follow-up is a different screen\./);
      assert.equal(text.includes("Property delivery is a different screen."), false);
      assert.match(text, /Nothing urgent right now\./);
      assert.equal(text.includes("Priority Actions"), false);
      assert.equal(text.includes("Agent Engine 2.0"), false);
      assertNoSharedPitch(text);

      const link = linkByLabel(tree, "Grow Today");
      assert.ok(link, "Command Centre links to Grow Today");
      assert.equal(link.props?.href, "/grow");
      assert.deepEqual(queryKeys(), ['["command-centre"]']);
    });
  } finally {
    clearGlobals();
  }
});

test("G-3: Command Centre still explains itself and links to Grow Today before its data arrives", async () => {
  installGlobals({ '["command-centre"]': commandCentreQuery("loading") }, { user: null });
  try {
    await withVite(async (vite) => {
      const page = (await vite.ssrLoadModule("/src/pages/CommandCentre.tsx")) as {
        default: () => unknown;
      };
      const tree = page.default();
      const text = textContent(tree);
      assert.match(text, /Loading\.\.\./);
      assert.match(text, new RegExp(RUN_COMMAND_CENTRE_PURPOSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(text.includes("Command Centre for property work"), false);
      assert.equal(linkByLabel(tree, "Grow Today")?.props?.href, "/grow");
      assert.deepEqual(queryKeys(), ['["command-centre"]']);
      assertNoSharedPitch(text);
    });
  } finally {
    clearGlobals();
  }
});
