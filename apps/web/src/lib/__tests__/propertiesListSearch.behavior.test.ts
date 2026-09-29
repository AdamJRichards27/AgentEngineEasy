// UAT-S1 — the property list search box. Typing waits ~300ms, then the
// request carries q and the rendered list is whatever that response
// contains. No matches show "No properties match". An empty box keeps the
// existing "No properties yet" empty state.

import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

interface ElementNode {
  type?: unknown;
  props?: Record<string, unknown> & {
    children?: unknown;
    onChange?: (event: { target: { value: string } }) => void;
    placeholder?: string;
    href?: string;
  };
}

interface ListedProperty {
  id: number;
  formattedAddress: string;
  workflowStage: string;
}

const ALL: ListedProperty[] = [
  { id: 1, formattedAddress: "12 Main Street", workflowStage: "Appraisal" },
  { id: 2, formattedAddress: "99 Other Road", workflowStage: "Listed" },
];

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

function searchBox(tree: unknown): ElementNode {
  const box = findAll(tree, (element) => element.type === "input" && element.props?.placeholder === "Address, suburb, or postcode")[0];
  assert.ok(box, "the property list has a search box");
  return box;
}

function addresses(tree: unknown): string[] {
  return findAll(tree, (element) => element.type === "a" && typeof element.props?.href === "string" && element.props.href.startsWith("/properties/"))
    .map((element) => textContent(element).replace(/\s+/g, " ").trim());
}

interface EffectSlot {
  fn: () => unknown;
  deps: unknown[];
  cleanup?: () => void;
  run: boolean;
}

interface QuerySlot {
  status: "pending" | "success" | "error";
  data?: { properties: ListedProperty[] };
  error: unknown;
}

function createHarness() {
  const state: unknown[] = [];
  let stateCursor = 0;
  const effects: EffectSlot[] = [];
  let effectCursor = 0;
  return {
    beginRender() {
      stateCursor = 0;
      effectCursor = 0;
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
    useEffect(fn: () => unknown, deps: unknown[]) {
      const index = effectCursor++;
      const prev = effects[index];
      const changed =
        !prev || prev.deps.length !== deps.length || deps.some((dep, i) => !Object.is(dep, prev.deps[i]));
      if (!prev) {
        effects[index] = { fn, deps, run: true };
        return;
      }
      if (changed) {
        effects[index] = { fn, deps, cleanup: prev.cleanup, run: true };
        return;
      }
      prev.run = false;
    },
    flushEffects() {
      for (const effect of effects) {
        if (!effect?.run) continue;
        effect.cleanup?.();
        const cleanup = effect.fn();
        effect.cleanup = typeof cleanup === "function" ? cleanup : undefined;
        effect.run = false;
      }
    },
  };
}

const mocks: Plugin = {
  name: "uats1-property-list-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:uats1-react") return "\0uats1-react";
    if (source === "react/jsx-runtime" || source === "react/jsx-dev-runtime" || source === "virtual:uats1-jsx") return "\0uats1-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:uats1-query") return "\0uats1-query";
    if (source === "wouter" || source === "virtual:uats1-wouter") return "\0uats1-wouter";
    if (source === "../lib/api") return "\0uats1-api";
    return null;
  },
  load(id) {
    if (id === "\0uats1-react") {
      return `
        export const useState = (...args) => globalThis.__uats1Hooks.useState(...args);
        export const useEffect = (...args) => globalThis.__uats1Hooks.useEffect(...args);
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0uats1-jsx") {
      return `
        export const Fragment = Symbol.for("uats1-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0uats1-query") {
      return `
        export const useQuery = ({ queryKey, queryFn }) => {
          const key = JSON.stringify(queryKey);
          const cache = globalThis.__uats1Queries;
          let slot = cache.get(key);
          if (!slot) {
            slot = { status: "pending", error: null };
            cache.set(key, slot);
            globalThis.__uats1Pending.push(
              Promise.resolve()
                .then(() => queryFn())
                .then(
                  (data) => { slot.status = "success"; slot.data = data; },
                  (error) => { slot.status = "error"; slot.error = error; },
                ),
            );
          }
          return {
            data: slot.data,
            isLoading: slot.status === "pending",
            isError: slot.status === "error",
            error: slot.error,
          };
        };
      `;
    }
    if (id === "\0uats1-wouter") {
      return `export const Link = (props) => ({ type: "a", props });`;
    }
    if (id === "\0uats1-api") {
      return `
        export const apiFetch = (path) => globalThis.__uats1ApiFetch(path);
        export function apiErrorMessage(error, fallback) {
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
        { find: /^react$/, replacement: "virtual:uats1-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:uats1-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:uats1-query" },
        { find: /^wouter$/, replacement: "virtual:uats1-wouter" },
      ],
    },
    plugins: [mocks],
  });
  try {
    return await run(vite);
  } finally {
    await vite.close();
  }
}

function install(propertiesFor: (q: string) => ListedProperty[]) {
  const hooks = createHarness();
  const calls: string[] = [];
  const pending: Promise<unknown>[] = [];
  const queries = new Map<string, QuerySlot>();
  Object.assign(globalThis, {
    __uats1Hooks: hooks,
    __uats1Pending: pending,
    __uats1Queries: queries,
    __uats1ApiFetch: (path: string) => {
      calls.push(path);
      const q = new URL(path, "http://localhost").searchParams.get("q")?.trim() ?? "";
      return Promise.resolve({ properties: propertiesFor(q) });
    },
  });
  return { hooks, calls, pending };
}

function clearGlobals() {
  for (const key of ["__uats1Hooks", "__uats1Pending", "__uats1Queries", "__uats1ApiFetch"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

type Page = () => unknown;

function render(hooks: ReturnType<typeof createHarness>, Page: Page) {
  hooks.beginRender();
  return Page();
}

async function settle(hooks: ReturnType<typeof createHarness>, Page: Page, pending: Promise<unknown>[]) {
  const tree = render(hooks, Page);
  hooks.flushEffects();
  await Promise.all(pending);
  return render(hooks, Page);
}

test("typing filters the property list after the debounce, and no matches say so", async (t) => {
  const { hooks, calls, pending } = install((q) => {
    if (!q) return ALL;
    const needle = q.toLowerCase();
    return ALL.filter((property) => property.formattedAddress.toLowerCase().includes(needle));
  });
  try {
    await withVite(async (vite) => {
      const { default: PropertiesList } = (await vite.ssrLoadModule("/src/pages/PropertiesList.tsx")) as { default: Page };
      t.mock.timers.enable({ apis: ["setTimeout"] });

      const loaded = await settle(hooks, PropertiesList, pending);
      assert.deepEqual(addresses(loaded), ["12 Main Street Appraisal", "99 Other Road Listed"]);
      assert.equal(textContent(loaded).includes("No properties match"), false);
      assert.equal(textContent(loaded).includes("No properties yet"), false);
      assert.deepEqual(calls, ["/properties"]);

      searchBox(loaded).props!.onChange!({ target: { value: "main" } });
      const typed = render(hooks, PropertiesList);
      hooks.flushEffects();
      t.mock.timers.tick(299);
      const waiting = render(hooks, PropertiesList);
      assert.deepEqual(addresses(waiting), ["12 Main Street Appraisal", "99 Other Road Listed"]);
      assert.deepEqual(calls, ["/properties"]);
      assert.equal(searchBox(typed).props?.value, "main");

      t.mock.timers.tick(1);
      const fetching = render(hooks, PropertiesList);
      assert.match(textContent(fetching), /Loading/);
      await Promise.all(pending);
      const filtered = render(hooks, PropertiesList);
      assert.deepEqual(calls, ["/properties", "/properties?q=main"]);
      assert.deepEqual(addresses(filtered), ["12 Main Street Appraisal"]);
      assert.equal(textContent(filtered).includes("No properties match"), false);

      searchBox(filtered).props!.onChange!({ target: { value: "zzz" } });
      render(hooks, PropertiesList);
      hooks.flushEffects();
      t.mock.timers.tick(300);
      render(hooks, PropertiesList);
      await Promise.all(pending);
      const none = render(hooks, PropertiesList);
      assert.deepEqual(calls, ["/properties", "/properties?q=main", "/properties?q=zzz"]);
      assert.deepEqual(addresses(none), []);
      assert.match(textContent(none), /No properties match/);
      assert.equal(textContent(none).includes("No properties yet"), false);
      assert.equal(textContent(none).includes("+ Start Property"), false);
    });
  } finally {
    t.mock.timers.reset();
    clearGlobals();
  }
});

test("an empty search keeps the existing empty state", async (t) => {
  const { hooks, calls, pending } = install(() => []);
  try {
    await withVite(async (vite) => {
      const { default: PropertiesList } = (await vite.ssrLoadModule("/src/pages/PropertiesList.tsx")) as { default: Page };
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const loaded = await settle(hooks, PropertiesList, pending);
      assert.deepEqual(calls, ["/properties"]);
      assert.match(textContent(loaded), /No properties yet/);
      assert.match(textContent(loaded), /\+ Start Property/);
      assert.equal(textContent(loaded).includes("No properties match"), false);
      const start = findAll(loaded, (element) => element.type === "a" && element.props?.href === "/properties/start")[0];
      assert.ok(start, "the existing empty state still links to Start Property");
    });
  } finally {
    t.mock.timers.reset();
    clearGlobals();
  }
});
