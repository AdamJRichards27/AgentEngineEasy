import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

// G-4 — import history used to branch only on isLoading and
// `jobs.data?.jobs.length === 0`. A failed GET /import/jobs left `data`
// undefined, so both branches were false and the card rendered nothing under
// its heading. Product #56 already routes that card through
// GrowDataRegionStatus. This test renders the real import page and locks the
// three honest outcomes: error with Try again, empty, and the history table.

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

function button(tree: unknown, label: string): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "button" && textContent(element).includes(label))[0];
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
    useEffect() {},
  };
}

const virtualMocks: Plugin = {
  name: "g4-import-history-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:g4-react") return "\0g4-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:g4-jsx") return "\0g4-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:g4-query") return "\0g4-query";
    if (source === "wouter" || source === "virtual:g4-wouter") return "\0g4-wouter";
    if (source === "../lib/api") return "\0g4-api";
    return null;
  },
  load(id) {
    if (id === "\0g4-react") {
      return `
        export const useState = (...args) => globalThis.__g4Hooks.useState(...args);
        export const useEffect = (...args) => globalThis.__g4Hooks.useEffect(...args);
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0g4-jsx") {
      return `
        export const Fragment = Symbol.for("g4-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0g4-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries() {} });
        export const useQuery = (options) => {
          const key = JSON.stringify(options.queryKey);
          const table = globalThis.__g4Queries;
          if (table && Object.prototype.hasOwnProperty.call(table, key)) return table[key];
          return { isLoading: true, isError: false, data: undefined, refetch() {} };
        };
        export const useMutation = () => ({
          isPending: false,
          isError: false,
          error: null,
          mutate() {},
        });
      `;
    }
    if (id === "\0g4-wouter") {
      return `export const Link = (props) => ({ type: "a", props });`;
    }
    if (id === "\0g4-api") {
      return `
        export class ApiError extends Error {
          constructor(status, friendly) {
            super(friendly);
            this.status = status;
            this.friendly = friendly;
          }
        }
        export const apiFetch = () => Promise.resolve({});
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
        { find: /^react$/, replacement: "virtual:g4-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:g4-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:g4-query" },
        { find: /^wouter$/, replacement: "virtual:g4-wouter" },
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

const ACCESS_KEY = JSON.stringify(["grow-access"]);
const JOBS_KEY = JSON.stringify(["import-jobs"]);

function query(overrides: Record<string, unknown>) {
  return {
    isLoading: false,
    isError: false,
    data: undefined,
    error: undefined,
    refetch() {},
    ...overrides,
  };
}

function installGlobals(jobs: Record<string, unknown>) {
  const hooks = createHarness();
  Object.assign(globalThis, {
    __g4Hooks: hooks,
    __g4Queries: {
      [ACCESS_KEY]: query({ data: { entitled: true } }),
      [JOBS_KEY]: jobs,
    },
  });
  return hooks;
}

function clearGlobals() {
  for (const key of ["__g4Hooks", "__g4Queries"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

type GrowImportModule = { default: () => unknown };

async function renderHistory(vite: ViteDevServer, hooks: ReturnType<typeof createHarness>) {
  const page = (await vite.ssrLoadModule("/src/pages/GrowImport.tsx")) as GrowImportModule;
  hooks.beginRender();
  return page.default();
}

const HISTORY_ERROR = "Couldn't load your import history.";
const HISTORY_EMPTY = "No imports yet.";

test("G-4: a failed import-history fetch shows an error and Try again, not a blank card", async () => {
  let refetches = 0;
  const hooks = installGlobals(
    query({
      isError: true,
      error: {
        friendly: "The import list is unavailable right now.",
        correlationId: "3f9c2a1b-7d4e-4c2a",
      },
      refetch() {
        refetches += 1;
      },
    }),
  );
  try {
    await withVite(async (vite) => {
      const failed = await renderHistory(vite, hooks);
      const text = textContent(failed);
      assert.equal(findAll(failed, (element) => element.props?.role === "alert").length, 1, "the failure is announced");
      assert.match(text, /The import list is unavailable right now/);
      assert.match(text, /Reference: 3f9c2a1b/);
      assert.doesNotMatch(text, new RegExp(HISTORY_EMPTY), "a failure never reads as an empty history");
      assert.equal(findAll(failed, (element) => element.type === "table").length, 0, "a failed fetch does not render the history table");
      assert.match(text, /Start a new import/, "the upload card stays while history fails");
      const retry = button(failed, "Try again");
      assert.ok(retry, "import history offers Try again");
      (retry.props!.onClick as () => void)();
      assert.equal(refetches, 1, "Try again refetches the jobs query");

      const jobs = (globalThis as { __g4Queries: Record<string, unknown> }).__g4Queries;
      jobs[JOBS_KEY] = query({
        isError: true,
        error: new Error("socket hang up"),
      });
      const bare = await renderHistory(vite, hooks);
      const bareText = textContent(bare);
      assert.match(bareText, new RegExp(HISTORY_ERROR), "a non-API failure uses the history fallback");
      assert.doesNotMatch(bareText, /undefined/);
      assert.doesNotMatch(bareText, /socket hang up/);
      assert.ok(button(bare, "Try again"), "the fallback still offers Try again");
    });
  } finally {
    clearGlobals();
  }
});

test("G-4: import history shows empty, loading, or the table, and never a silent blank", async () => {
  const hooks = installGlobals(query({ data: { jobs: [] } }));
  try {
    await withVite(async (vite) => {
      const empty = await renderHistory(vite, hooks);
      const emptyText = textContent(empty);
      assert.match(emptyText, new RegExp(HISTORY_EMPTY));
      assert.equal(button(empty, "Try again"), undefined, "an empty history is not a failure");
      assert.equal(findAll(empty, (element) => element.props?.role === "alert").length, 0);
      assert.equal(findAll(empty, (element) => element.type === "table").length, 0);

      const jobs = (globalThis as { __g4Queries: Record<string, unknown> }).__g4Queries;
      jobs[JOBS_KEY] = query({ isLoading: true });
      const loading = await renderHistory(vite, hooks);
      const loadingText = textContent(loading);
      assert.match(loadingText, /Import history/);
      assert.match(loadingText, /Loading/);
      assert.doesNotMatch(loadingText, new RegExp(HISTORY_EMPTY));
      assert.doesNotMatch(loadingText, new RegExp(HISTORY_ERROR));
      assert.equal(button(loading, "Try again"), undefined);

      jobs[JOBS_KEY] = query({
        data: {
          jobs: [
            {
              id: 7,
              filename: "contacts.csv",
              status: "COMPLETED",
              totalRows: 12,
              uploadedAt: "2026-09-23T00:00:00.000Z",
            },
          ],
        },
      });
      const ready = await renderHistory(vite, hooks);
      const readyText = textContent(ready);
      assert.match(readyText, /contacts\.csv/);
      assert.match(readyText, /Completed/);
      assert.ok(button(ready, "Open"), "a ready history still offers Open");
      assert.doesNotMatch(readyText, new RegExp(HISTORY_EMPTY));
      assert.doesNotMatch(readyText, new RegExp(HISTORY_ERROR));
      assert.equal(button(ready, "Try again"), undefined);
      assert.equal(findAll(ready, (element) => element.type === "table").length, 1);
    });
  } finally {
    clearGlobals();
  }
});
