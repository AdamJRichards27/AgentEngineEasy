import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import type { ApiError as ApiErrorType } from "../api.ts";

// PC-C (P-01): the real Pit Crew page function, with React and React Query
// replaced the same way pitCrewResponsibility.behavior.test.ts does. Proves:
// - initial loading is announced (role=status, aria-busy);
// - a first-load error is role=alert with Try again (refetches the
//   workspace query only);
// - a failed background refresh keeps the workspace mounted with a
//   "Couldn't refresh" notice and Try again;
// - a half-filled inline form keeps its values across a failed poll and
//   the recovery poll.
// Pit Crew feature flags are not involved: the responsibility probe is off.

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

function byRole(tree: unknown, role: string): ElementNode[] {
  return findAll(tree, (element) => element.props?.role === role);
}

function buttonExact(tree: unknown, label: string): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "button" && textContent(element).trim() === label)[0];
}

function tabButton(tree: unknown, label: string): ElementNode | undefined {
  return findAll(
    tree,
    (element) =>
      element.type === "button" &&
      String(element.props?.className ?? "").includes("pc-tab") &&
      textContent(element).includes(label),
  )[0];
}

function inputByPlaceholder(tree: unknown, prefix: string): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "input" && String(element.props?.placeholder ?? "").startsWith(prefix))[0];
}

function click(element: ElementNode | undefined): void {
  const onClick = element?.props?.onClick;
  if (typeof onClick !== "function") throw new Error(`missing click handler for ${textContent(element)}`);
  onClick();
}

function change(element: ElementNode | undefined, value: string): void {
  const onChange = element?.props?.onChange;
  if (typeof onChange !== "function") throw new Error("missing change handler");
  onChange({ target: { value } });
}

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
  name: "pit-crew-refresh-resilience-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:pc-react") return "\0pc-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:pc-jsx") return "\0pc-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:pc-query") return "\0pc-query";
    if (source === "wouter" || source === "virtual:pc-wouter") return "\0pc-wouter";
    if (source === "../lib/session") return "\0pc-session";
    return null;
  },
  load(id) {
    if (id === "\0pc-react") {
      return `
        export const useState = (...args) => globalThis.__pcHooks.useState(...args);
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0pc-jsx") {
      return `
        export const Fragment = Symbol.for("pc-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0pc-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries() {} });
        export const useQuery = (options) => {
          const key = JSON.stringify(options.queryKey);
          const table = globalThis.__pcQueries || {};
          const base = Object.prototype.hasOwnProperty.call(table, key)
            ? table[key]
            : { isLoading: false, isError: false, data: undefined, error: null };
          return {
            isFetching: false,
            ...base,
            refetch: () => { globalThis.__pcRefetched.push(options.queryKey); return Promise.resolve(base); },
          };
        };
        export const useMutation = () => ({ isPending: false, variables: undefined, mutate() {} });
      `;
    }
    if (id === "\0pc-wouter") {
      return `export const Link = (props) => ({ type: "a", props });`;
    }
    if (id === "\0pc-session") {
      return `export const useSession = () => ({ user: globalThis.__pcUser });`;
    }
    return null;
  },
};

let vite: ViteDevServer;
let Page: () => unknown;
// The page's `instanceof ApiError` check sees the class from Vite's module
// graph, so tests must construct errors from that same module instance.
let ApiError: new (status: number, friendly: string) => ApiErrorType;

before(async () => {
  vite = await createServer({
    root: new URL("../../..", import.meta.url).pathname,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: true },
    resolve: {
      alias: [
        { find: /^react$/, replacement: "virtual:pc-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:pc-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:pc-query" },
        { find: /^wouter$/, replacement: "virtual:pc-wouter" },
      ],
    },
    plugins: [virtualMocks],
  });
  const mod = (await vite.ssrLoadModule("/src/pages/PitCrewCommandCentre.tsx")) as { default: () => unknown };
  Page = mod.default;
  ApiError = ((await vite.ssrLoadModule("/src/lib/api.ts")) as { ApiError: typeof ApiError }).ApiError;
});

after(async () => {
  await vite?.close();
});

const WORKSPACE_KEY = JSON.stringify(["pit-crew-workspace"]);
const PROBE_KEY = JSON.stringify(["pit-crew-responsibility-actions"]);

function claimedItem() {
  return {
    sourceType: "EXCEPTION",
    sourceRecordId: "22222222-2222-4222-8222-222222222222",
    propertyId: 15,
    propertyAddress: "15 Example St",
    brokerageId: 1,
    title: "UNIQUE_CLAIMED_TITLE",
    description: "The contract date is missing.",
    category: "CONTRACT_CONDITIONS",
    severity: "ATTENTION",
    exceptionStatus: "OPEN",
    ownerType: "PIT_CREW",
    ownerUserId: null,
    ownerName: null,
    dueAt: null,
    overdue: false,
    recommendedAction: "Confirm the date.",
    deepLink: "/properties/15",
    detectedAt: "2026-10-01T00:00:00.000Z",
    pcStatus: "CLAIMED",
    assignedToUserId: 9,
    assignedToName: "Pat Crew",
    claimedAt: "2026-10-01T00:00:00.000Z",
    waitingOnParty: null,
    waitingOnNote: null,
    waitingOnSince: null,
    waitingOnExpectedAt: null,
    handoffFromUserId: null,
    handoffToUserId: null,
    handoffNote: null,
    handoffAt: null,
    completedAt: null,
    version: 3,
  };
}

function workspace() {
  return {
    generatedAt: "2026-10-19T12:15:00.000Z",
    summary: { unassignedCount: 0, myWorkCount: 1, teamWorkCount: 1, waitingOnCount: 0, overdueCount: 0, completedTodayCount: 0 },
    myWork: [claimedItem()],
    unassignedWork: [],
    teamWork: [claimedItem()],
    launchCoordination: [],
    transactionCoordination: [],
    waitingOn: [],
    completedToday: [],
    handedBack: [],
    escalated: [],
    team: [{ userId: 9, firstName: "Pat", lastName: "Crew", activeItemCount: 1 }],
  };
}

type QueryState = { isLoading: boolean; isError: boolean; data: unknown; error: unknown; isFetching?: boolean };

function install(workspaceState: QueryState) {
  const hooks = createHarness();
  const refetched: unknown[] = [];
  const table: Record<string, QueryState> = {
    [WORKSPACE_KEY]: workspaceState,
    [PROBE_KEY]: { isLoading: false, isError: false, data: false, error: null },
  };
  Object.assign(globalThis, { __pcHooks: hooks, __pcQueries: table, __pcRefetched: refetched, __pcUser: { id: 9, role: "Pit Crew" } });
  return {
    refetched,
    setWorkspace(next: QueryState) {
      table[WORKSPACE_KEY] = next;
    },
    render() {
      hooks.beginRender();
      return Page();
    },
  };
}

function clearGlobals() {
  for (const key of ["__pcHooks", "__pcQueries", "__pcRefetched", "__pcUser"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

test("initial loading is announced with role=status and aria-busy", () => {
  const view = install({ isLoading: true, isError: false, data: undefined, error: null, isFetching: true });
  try {
    const tree = view.render();
    const status = byRole(tree, "status");
    assert.equal(status.length, 1);
    assert.equal(textContent(status[0]).trim(), "Loading Pit Crew workspace…");
    const busy = findAll(tree, (element) => element.props?.["aria-busy"] === true);
    assert.equal(busy.length, 1);
    assert.equal(byRole(tree, "alert").length, 0);
  } finally {
    clearGlobals();
  }
});

test("a first-load error is role=alert with friendly text and Try again that refetches only the workspace", () => {
  const view = install({ isLoading: false, isError: true, data: undefined, error: new ApiError(503, "UNIQUE_FRIENDLY_503") });
  try {
    const tree = view.render();
    const alerts = byRole(tree, "alert");
    assert.equal(alerts.length, 1);
    assert.match(textContent(alerts[0]), /UNIQUE_FRIENDLY_503/);
    click(buttonExact(tree, "Try again"));
    assert.deepEqual(view.refetched, [["pit-crew-workspace"]]);
  } finally {
    clearGlobals();
  }
});

test("a first-load non-ApiError shows the fallback, never the raw message or 'undefined'", () => {
  const view = install({ isLoading: false, isError: true, data: undefined, error: new TypeError("Failed to fetch RAW_TECHNICAL") });
  try {
    const tree = view.render();
    const alerts = byRole(tree, "alert");
    assert.equal(alerts.length, 1);
    const text = textContent(alerts[0]);
    assert.match(text, /Couldn't load the Pit Crew workspace\./);
    assert.equal(text.includes("RAW_TECHNICAL"), false);
    assert.equal(text.includes("undefined"), false);
    assert.ok(buttonExact(tree, "Try again"));
  } finally {
    clearGlobals();
  }
});

test("a failed background refresh keeps the workspace on screen with a Couldn't refresh notice and Try again", () => {
  const data = workspace();
  const view = install({ isLoading: false, isError: false, data, error: null });
  try {
    let tree = view.render();
    assert.equal(textContent(tree).includes("Couldn't refresh"), false);

    view.setWorkspace({ isLoading: false, isError: true, data, error: new ApiError(502, "Bad gateway") });
    tree = view.render();
    assert.ok(tabButton(tree, "My Work"), "the tab bar stays mounted");
    assert.match(textContent(tree), /Operations Overview/);
    assert.equal(byRole(tree, "alert").length, 0, "a stale refresh is not a full-page alert");
    const notices = byRole(tree, "status").filter((element) => textContent(element).includes("Couldn't refresh"));
    assert.equal(notices.length, 1);
    assert.match(textContent(notices[0]), /^Couldn't refresh\. Showing the workspace as of .+\./);
    click(buttonExact(tree, "Try again"));
    assert.deepEqual(view.refetched, [["pit-crew-workspace"]], "Try again does not refetch the responsibility probe");

    view.setWorkspace({ isLoading: false, isError: false, data, error: null });
    tree = view.render();
    assert.equal(textContent(tree).includes("Couldn't refresh"), false, "a successful refetch clears the notice");
  } finally {
    clearGlobals();
  }
});

test("a half-filled Waiting on form keeps its values across a failed poll and the recovery poll", () => {
  const data = workspace();
  const view = install({ isLoading: false, isError: false, data, error: null });
  try {
    let tree = view.render();
    click(tabButton(tree, "My Work"));
    tree = view.render();
    click(buttonExact(tree, "Waiting on…"));
    tree = view.render();
    change(inputByPlaceholder(tree, "Waiting on whom?"), "Seller's solicitor");
    tree = view.render();
    change(inputByPlaceholder(tree, "Note (optional)"), "UNIQUE_HALF_TYPED_NOTE");
    tree = view.render();

    view.setWorkspace({ isLoading: false, isError: true, data, error: new ApiError(502, "Bad gateway") });
    tree = view.render();
    assert.equal(inputByPlaceholder(tree, "Waiting on whom?")?.props?.value, "Seller's solicitor");
    assert.equal(inputByPlaceholder(tree, "Note (optional)")?.props?.value, "UNIQUE_HALF_TYPED_NOTE");
    assert.match(textContent(tree), /UNIQUE_CLAIMED_TITLE/);

    view.setWorkspace({ isLoading: false, isError: false, data, error: null });
    tree = view.render();
    assert.equal(inputByPlaceholder(tree, "Waiting on whom?")?.props?.value, "Seller's solicitor");
    assert.equal(inputByPlaceholder(tree, "Note (optional)")?.props?.value, "UNIQUE_HALF_TYPED_NOTE");
  } finally {
    clearGlobals();
  }
});
