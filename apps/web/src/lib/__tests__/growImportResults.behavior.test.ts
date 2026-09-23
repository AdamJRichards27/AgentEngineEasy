import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

// E-7 — after a completed import the results screen used to offer only
// "Undo this import". These tests render the real Grow import page (React
// and its data hooks replaced with the same in-memory fakes the other Grow
// behaviour tests use) and assert the forward exits, and that Undo is still
// there and still posts the existing rollback route.

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

function linkByLabel(tree: unknown, label: string): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "a" && textContent(element).includes(label))[0];
}

function hrefs(tree: unknown): string[] {
  return findAll(tree, (element) => element.type === "a").map((element) => String(element.props?.href));
}

function createHarness() {
  const state: unknown[] = [];
  let stateCursor = 0;
  return {
    reset() {
      state.length = 0;
    },
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
  name: "e7-import-results-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:e7-react") return "\0e7-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:e7-jsx") return "\0e7-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:e7-query") return "\0e7-query";
    if (source === "wouter" || source === "virtual:e7-wouter") return "\0e7-wouter";
    if (source === "../lib/api") return "\0e7-api";
    return null;
  },
  load(id) {
    if (id === "\0e7-react") {
      return `
        export const useState = (...args) => globalThis.__e7Hooks.useState(...args);
        export const useEffect = (...args) => globalThis.__e7Hooks.useEffect(...args);
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0e7-jsx") {
      return `
        export const Fragment = Symbol.for("e7-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0e7-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries() {} });
        export const useQuery = (options) => {
          const key = JSON.stringify(options.queryKey);
          const table = globalThis.__e7Queries;
          if (table && Object.prototype.hasOwnProperty.call(table, key)) return table[key];
          return { isLoading: true, isError: false, data: undefined, refetch() {} };
        };
        export const useMutation = (options) => ({
          isPending: false,
          isError: false,
          error: null,
          mutate() {
            globalThis.__e7LastMutation = options.mutationFn;
          },
        });
      `;
    }
    if (id === "\0e7-wouter") {
      return `export const Link = (props) => ({ type: "a", props });`;
    }
    if (id === "\0e7-api") {
      return `
        export class ApiError extends Error {
          constructor(status, friendly) {
            super(friendly);
            this.status = status;
            this.friendly = friendly;
          }
        }
        export const apiFetch = (path, init) => {
          globalThis.__e7Fetch = { path, init };
          return Promise.resolve({ importJobId: 42, entries: [] });
        };
        export function apiErrorMessage(error, fallback) {
          if (error instanceof ApiError && typeof error.friendly === "string" && error.friendly.trim()) return error.friendly;
          return fallback;
        }
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
        { find: /^react$/, replacement: "virtual:e7-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:e7-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:e7-query" },
        { find: /^wouter$/, replacement: "virtual:e7-wouter" },
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

function completedJob() {
  return {
    id: 42,
    filename: "contacts.csv",
    sourceFileType: "csv",
    status: "COMPLETED",
    mapping: null,
    totalRows: 1200,
    processedRows: 1200,
    validRows: 1180,
    warningRows: 0,
    rejectedRows: 0,
    duplicateCandidates: 0,
    contactsCreated: 900,
    contactsUpdated: 200,
    propertiesCreated: 10,
    propertiesUpdated: 0,
    relationshipsCreated: 40,
    uploadedAt: "2026-09-23T00:00:00.000Z",
    startedAt: "2026-09-23T00:01:00.000Z",
    completedAt: "2026-09-23T00:02:00.000Z",
    failureReason: null,
  };
}

function readyQuery(data: unknown) {
  return { isLoading: false, isError: false, data, refetch() {} };
}

function installGlobals(job: ReturnType<typeof completedJob>) {
  const hooks = createHarness();
  Object.assign(globalThis, {
    __e7Hooks: hooks,
    __e7Queries: {
      [JSON.stringify(["grow-access"])]: readyQuery({ entitled: true }),
      [JSON.stringify(["import-jobs"])]: readyQuery({ jobs: [job] }),
      [JSON.stringify(["import-job", job.id])]: readyQuery({ job }),
    },
    __e7LastMutation: undefined,
    __e7Fetch: undefined,
  });
  return hooks;
}

function clearGlobals() {
  for (const key of ["__e7Hooks", "__e7Queries", "__e7LastMutation", "__e7Fetch"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

type GrowImportModule = {
  default: () => unknown;
  IMPORT_COMPLETE_NEXT_ACTIONS: ReadonlyArray<{ href: string; label: string; className: string }>;
};

async function openCompletedImport(vite: ViteDevServer, hooks: ReturnType<typeof createHarness>) {
  const page = (await vite.ssrLoadModule("/src/pages/GrowImport.tsx")) as GrowImportModule;
  hooks.beginRender();
  const history = page.default();
  const open = button(history, "Open");
  assert.ok(open, "import history offers Open on the completed job");
  (open.props?.onClick as () => void)();
  hooks.beginRender();
  return { page, results: page.default() };
}

test("E-7: a completed import offers contacts and Grow Today, and still offers Undo", async () => {
  const hooks = installGlobals(completedJob());
  try {
    await withVite(async (vite) => {
      const { page, results } = await openCompletedImport(vite, hooks);

      assert.equal(
        textContent(results).includes("Open the contact list to work what came in"),
        true,
        "the success card tells the agent where to go next",
      );

      const contacts = linkByLabel(results, "See these contacts in Grow");
      assert.ok(contacts, "the success card links to the contact list");
      assert.equal(contacts.props?.href, "/grow?tab=contacts");
      assert.equal(contacts.props?.className, "btn btn-primary btn-small");

      const today = linkByLabel(results, "Go to Grow Today");
      assert.ok(today, "the success card links to Grow Today");
      assert.equal(today.props?.href, "/grow");
      assert.equal(today.props?.className, "btn btn-secondary btn-small");

      assert.deepEqual(
        page.IMPORT_COMPLETE_NEXT_ACTIONS.map((action) => action.href),
        hrefs(results),
        "the rendered exits are the named next actions, with no extra link",
      );
      assert.equal(hrefs(results).some((href) => href.includes("null")), false);

      const undo = button(results, "Undo this import");
      assert.ok(undo, "Undo this import stays on the success screen");
      assert.equal(undo.props?.className, "btn btn-danger");
    });
  } finally {
    clearGlobals();
  }
});

test("E-7: Undo still confirms and posts the existing rollback route", async () => {
  const hooks = installGlobals(completedJob());
  try {
    await withVite(async (vite) => {
      const { page, results } = await openCompletedImport(vite, hooks);
      const undo = button(results, "Undo this import");
      assert.ok(undo);
      (undo.props?.onClick as () => void)();

      hooks.beginRender();
      const confirming = page.default();
      assert.equal(button(confirming, "Undo this import"), undefined, "the first undo control yields to the confirm step");
      const yes = button(confirming, "Yes, undo it");
      const cancel = button(confirming, "Cancel");
      assert.ok(yes, "confirming undo still offers Yes, undo it");
      assert.ok(cancel, "confirming undo still offers Cancel");
      assert.ok(linkByLabel(confirming, "See these contacts in Grow"), "the contacts exit stays while undo is confirming");

      (yes.props?.onClick as () => void)();
      const mutation = (globalThis as { __e7LastMutation?: () => Promise<unknown> }).__e7LastMutation;
      assert.equal(typeof mutation, "function");
      await mutation!();
      assert.deepEqual((globalThis as { __e7Fetch?: { path: string; init: { method: string } } }).__e7Fetch, {
        path: "/import/jobs/42/rollback",
        init: { method: "POST" },
      });
    });
  } finally {
    clearGlobals();
  }
});
