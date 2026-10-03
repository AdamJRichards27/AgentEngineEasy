// G-UAT-7 — Getting started on Grow Today. The checklist renders from
// firstRun, hides when every step is done, hides an action the caller
// cannot take, and sits with the empty state. Collapse is component state:
// it does not call the API or write storage.

import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

interface ElementNode {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown; onClick?: () => void; id?: string; href?: string };
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

function button(tree: unknown, label: string): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "button" && textContent(element).trim() === label)[0];
}

function step(tree: unknown, id: string): ElementNode | undefined {
  return findAll(tree, (element) => element.props?.id === `grow-first-run-${id}`)[0];
}

function statusOf(tree: unknown, id: string): string {
  const row = step(tree, id);
  assert.ok(row, `missing step ${id}`);
  const status = findAll(row, (element) => String(element.props?.className ?? "").includes("grow-first-run-status"))[0];
  assert.ok(status, `missing status for ${id}`);
  return textContent(status).trim();
}

type Call = { path: string; options?: { method?: string } };

function createHarness() {
  const state: unknown[] = [];
  let stateCursor = 0;
  return {
    beginRender() {
      stateCursor = 0;
    },
    useState(initial: unknown) {
      const index = stateCursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [
        state[index],
        (next: unknown) => {
          state[index] = typeof next === "function" ? (next as (current: unknown) => unknown)(state[index]) : next;
        },
      ];
    },
  };
}

const virtualMocks: Plugin = {
  name: "guat7-first-run-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:guat7-react") return "\0guat7-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:guat7-jsx") return "\0guat7-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:guat7-query") return "\0guat7-query";
    if (source === "wouter" || source === "virtual:guat7-wouter") return "\0guat7-wouter";
    if (source === "../lib/api") return "\0guat7-api";
    if (source === "../lib/session") return "\0guat7-session";
    if (
      source === "../components/AskAgentEngine" ||
      source === "../components/CommunicationsSection" ||
      source === "../components/PropertyIntelligencePanel" ||
      source === "../components/GrowContactTranscriptPanel" ||
      source === "../components/GrowContactConsentPanel" ||
      source === "../components/GrowPendingCommitmentProposals" ||
      source === "../components/ErrorBoundary"
    ) {
      return "\0guat7-components";
    }
    return null;
  },
  load(id) {
    if (id === "\0guat7-react") {
      return `
        export const useState = (...args) => globalThis.__guat7Hooks.useState(...args);
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0guat7-jsx") {
      return `
        export const Fragment = Symbol.for("guat7-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0guat7-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries() {} });
        export const useQuery = () => globalThis.__guat7Query;
        export const useMutation = () => ({ isPending: false, isError: false, error: null, mutate() {} });
      `;
    }
    if (id === "\0guat7-wouter") {
      return `export const Link = (props) => ({ type: "a", props }); export const useSearch = () => "";`;
    }
    if (id === "\0guat7-api") {
      return `
        export class ApiError extends Error {}
        export const apiFetch = (path, options) => {
          globalThis.__guat7Calls.push({ path, options });
          return Promise.resolve({});
        };
        export function apiErrorMessage(error, fallback) { return fallback; }
      `;
    }
    if (id === "\0guat7-session") {
      return `
        export const useSession = () => ({ user: { id: 1, firstName: "Sam", role: "Agent" } });
        export const useEntitlements = () => ({
          isLoading: false,
          hasEntitlement: (key) => globalThis.__guat7Entitlements.includes(key),
        });
      `;
    }
    if (id === "\0guat7-components") {
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
        { find: /^react$/, replacement: "virtual:guat7-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:guat7-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:guat7-query" },
        { find: /^wouter$/, replacement: "virtual:guat7-wouter" },
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

const ALL_FALSE = {
  contact: false,
  propertyLink: false,
  activity: false,
  commitment: false,
  opportunity: false,
  appraisal: false,
};

const ALL_TRUE = {
  contact: true,
  propertyLink: true,
  activity: true,
  commitment: true,
  opportunity: true,
  appraisal: true,
};

const ALL_KEYS = [
  "grow.access",
  "grow.contacts.manage",
  "grow.relationships.manage",
  "grow.properties.link",
  "grow.activities.manage",
  "grow.opportunities.manage",
  "grow.import.execute",
];

function today(overrides: { hasAnyGrowData?: boolean; firstRun?: Record<string, boolean> | null }) {
  const data: Record<string, unknown> = {
    generatedAt: "2026-09-30T00:00:00.000Z",
    hasAnyGrowData: overrides.hasAnyGrowData ?? false,
    counts: { priorityActions: 0, followUpsDue: 0, openOpportunities: 0, contactsNeedingAttention: 0 },
    priorityActions: [],
    signalSummary: { surfaced: 0, emergingSurfaced: 0, emergingWithheld: 0, withheldDoNotContact: 0 },
  };
  if (overrides.firstRun !== null) data.firstRun = overrides.firstRun ?? ALL_FALSE;
  return { isLoading: false, isError: false, refetch() {}, data };
}

function install(entitlements: string[], query: ReturnType<typeof today>) {
  const hooks = createHarness();
  const calls: Call[] = [];
  const storageWrites: string[] = [];
  Object.assign(globalThis, {
    __guat7Hooks: hooks,
    __guat7Entitlements: entitlements,
    __guat7Query: query,
    __guat7Calls: calls,
    localStorage: {
      getItem: () => null,
      setItem: (key: string) => storageWrites.push(`local:${key}`),
      removeItem: (key: string) => storageWrites.push(`local-remove:${key}`),
    },
    sessionStorage: {
      getItem: () => null,
      setItem: (key: string) => storageWrites.push(`session:${key}`),
      removeItem: (key: string) => storageWrites.push(`session-remove:${key}`),
    },
  });
  return { hooks, calls, storageWrites };
}

function clearGlobals() {
  for (const key of ["__guat7Hooks", "__guat7Entitlements", "__guat7Query", "__guat7Calls"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

test("G-UAT-7: the checklist shows done and not-done, and each action opens the existing surface", async () => {
  const opened: string[] = [];
  const { hooks } = install(ALL_KEYS, today({
    hasAnyGrowData: true,
    firstRun: { ...ALL_FALSE, contact: true, activity: true, appraisal: true },
  }));
  try {
    await withVite(async (vite) => {
      const { GrowToday } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowToday: (props: Record<string, unknown>) => unknown;
      };
      hooks.beginRender();
      const tree = GrowToday({
        onAskAE: () => {},
        onViewContact: () => {},
        onEmailContact: () => {},
        onSmsContact: () => {},
        onOpenSection: (section: string) => opened.push(section),
      });

      assert.equal(textContent(tree).includes("Getting started"), true);
      assert.equal(textContent(tree).includes("3 of 6 done"), true);
      assert.equal(statusOf(tree, "contact"), "Done");
      assert.equal(statusOf(tree, "propertyLink"), "Not done");
      assert.equal(statusOf(tree, "activity"), "Done");
      assert.equal(statusOf(tree, "commitment"), "Not done");
      assert.equal(statusOf(tree, "opportunity"), "Not done");
      assert.equal(statusOf(tree, "appraisal"), "Done");

      assert.equal(button(step(tree, "contact"), "New contact"), undefined, "a finished step does not keep its action");
      assert.ok(button(step(tree, "propertyLink"), "Link property"));
      assert.equal(button(step(tree, "activity"), "Add note"), undefined);
      assert.ok(button(step(tree, "commitment"), "Add commitment"));
      assert.ok(button(step(tree, "opportunity"), "New opportunity"));
      assert.equal(button(step(tree, "appraisal"), "Start appraisal"), undefined);
      assert.equal(textContent(tree).includes("Not available"), false);

      const importLink = findAll(step(tree, "contact") ?? null, (element) => element.type === "a" && element.props?.href === "/grow/import")[0];
      assert.equal(importLink, undefined, "import is an alternate for an unfinished contact step");

      (button(tree, "Link property")!.props!.onClick as () => void)();
      (button(tree, "Add commitment")!.props!.onClick as () => void)();
      (button(tree, "New opportunity")!.props!.onClick as () => void)();
      assert.deepEqual(opened, ["contacts", "contacts", "opportunities"]);
    });
  } finally {
    clearGlobals();
  }
});

test("G-UAT-7: the checklist is hidden when every step is done", async () => {
  const { hooks } = install(ALL_KEYS, today({ hasAnyGrowData: true, firstRun: ALL_TRUE }));
  try {
    await withVite(async (vite) => {
      const { GrowToday } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowToday: (props: Record<string, unknown>) => unknown;
      };
      hooks.beginRender();
      const tree = GrowToday({
        onAskAE: () => {},
        onViewContact: () => {},
        onEmailContact: () => {},
        onSmsContact: () => {},
        onOpenSection: () => {},
      });
      assert.equal(textContent(tree).includes("Getting started"), false);
      assert.equal(textContent(tree).includes("You're all caught up"), true);
      assert.equal(button(tree, "New contact"), undefined);
    });
  } finally {
    clearGlobals();
  }
});

test("G-UAT-7: a step the user cannot act on says not available and has no button", async () => {
  const { hooks } = install(
    ["grow.contacts.manage", "grow.activities.manage"],
    today({ hasAnyGrowData: true, firstRun: ALL_FALSE }),
  );
  try {
    await withVite(async (vite) => {
      const { GrowToday } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowToday: (props: Record<string, unknown>) => unknown;
      };
      hooks.beginRender();
      const tree = GrowToday({
        onAskAE: () => {},
        onViewContact: () => {},
        onEmailContact: () => {},
        onSmsContact: () => {},
        onOpenSection: () => {},
      });

      assert.ok(button(step(tree, "contact"), "New contact"));
      assert.ok(button(step(tree, "activity"), "Add note"));
      assert.ok(button(step(tree, "commitment"), "Add commitment"));
      assert.equal(button(tree, "Link property"), undefined);
      assert.equal(button(tree, "New opportunity"), undefined);
      assert.equal(button(tree, "Start appraisal"), undefined);
      assert.equal(textContent(step(tree, "propertyLink")).includes("Not available"), true);
      assert.equal(textContent(step(tree, "opportunity")).includes("Not available"), true);
      assert.equal(textContent(step(tree, "appraisal")).includes("Not available"), true);
      assert.equal(
        findAll(tree, (element) => element.type === "a" && element.props?.href === "/grow/import").length,
        0,
        "without grow.import.execute the checklist does not offer import, and Today with data has no empty-state link",
      );
    });
  } finally {
    clearGlobals();
  }
});

test("G-UAT-7: the checklist sits with the empty state, and import is offered only with its key", async () => {
  const { hooks } = install(ALL_KEYS, today({ hasAnyGrowData: false, firstRun: ALL_FALSE }));
  try {
    await withVite(async (vite) => {
      const { GrowToday } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowToday: (props: Record<string, unknown>) => unknown;
      };
      hooks.beginRender();
      const tree = GrowToday({
        onAskAE: () => {},
        onViewContact: () => {},
        onEmailContact: () => {},
        onSmsContact: () => {},
        onOpenSection: () => {},
      });
      assert.equal(textContent(tree).includes("Let's find your next opportunity"), true);
      assert.equal(textContent(tree).includes("Getting started"), true);
      assert.match(textContent(step(tree, "activity")), /choose Add note on the row/);
      assert.equal(textContent(step(tree, "activity")).includes("Open a contact, then choose Add note"), false);
      const importLinks = findAll(tree, (element) => element.type === "a" && element.props?.href === "/grow/import");
      assert.equal(importLinks.length, 2, "the existing empty-state import link stays, and the contact step adds its own");
      assert.ok(importLinks.some((link) => textContent(link).includes("Import contacts & properties")));
      assert.ok(importLinks.some((link) => textContent(link).trim() === "Import contacts"));
    });
  } finally {
    clearGlobals();
  }
});

test("G-UAT-7: hiding the checklist is component state and makes no persistence call", async () => {
  const { hooks, calls, storageWrites } = install(ALL_KEYS, today({ hasAnyGrowData: false, firstRun: { ...ALL_FALSE, contact: false } }));
  try {
    await withVite(async (vite) => {
      const { GrowToday } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowToday: (props: Record<string, unknown>) => unknown;
      };
      const props = {
        onAskAE: () => {},
        onViewContact: () => {},
        onEmailContact: () => {},
        onSmsContact: () => {},
        onOpenSection: () => {},
      };
      const render = () => {
        hooks.beginRender();
        return GrowToday(props);
      };

      const open = render();
      assert.equal(textContent(open).includes("Add a contact"), true);
      (button(open, "Hide checklist")!.props!.onClick as () => void)();
      (button(open, "New contact")!.props!.onClick as () => void)();

      const hidden = render();
      assert.equal(textContent(hidden).includes("Getting started"), true);
      assert.equal(textContent(hidden).includes("Add a contact"), false);
      assert.ok(button(hidden, "Show checklist"));
      (button(hidden, "Show checklist")!.props!.onClick as () => void)();

      const shown = render();
      assert.equal(textContent(shown).includes("Add a contact"), true);
      assert.deepEqual(calls, []);
      assert.deepEqual(storageWrites, []);
    });
  } finally {
    clearGlobals();
  }
});

test("G-UAT-7: a Today payload without firstRun does not render a checklist", async () => {
  const { hooks } = install(["grow.contacts.manage"], today({ hasAnyGrowData: false, firstRun: null }));
  try {
    await withVite(async (vite) => {
      const { GrowToday } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowToday: (props: Record<string, unknown>) => unknown;
      };
      hooks.beginRender();
      const tree = GrowToday({
        onAskAE: () => {},
        onViewContact: () => {},
        onEmailContact: () => {},
        onSmsContact: () => {},
        onOpenSection: () => {},
      });
      assert.equal(textContent(tree).includes("Let's find your next opportunity"), true);
      assert.equal(textContent(tree).includes("Getting started"), false);
    });
  } finally {
    clearGlobals();
  }
});
