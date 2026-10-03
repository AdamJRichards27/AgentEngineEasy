// D3 — picking an address suggestion posts suburb, state and postcode with
// the place id. Manual entry still posts only the typed line.

import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

interface ElementNode {
  type?: unknown;
  props?: Record<string, unknown> & {
    children?: unknown;
    onChange?: (event: { target: { value: string } }) => void;
    onClick?: () => void;
    placeholder?: string;
    disabled?: boolean;
  };
}

interface EffectSlot {
  fn: () => unknown;
  deps: unknown[];
  cleanup?: () => void;
  run: boolean;
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

function createHarness() {
  const state: unknown[] = [];
  let stateCursor = 0;
  const effects: EffectSlot[] = [];
  let effectCursor = 0;
  const refs: Array<{ current: unknown }> = [];
  let refCursor = 0;
  return {
    beginRender() {
      stateCursor = 0;
      effectCursor = 0;
      refCursor = 0;
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
    useRef(initial: unknown) {
      const index = refCursor++;
      if (!refs[index]) refs[index] = { current: initial };
      return refs[index];
    },
    useEffect(fn: () => unknown, deps: unknown[]) {
      const index = effectCursor++;
      const prev = effects[index];
      const changed = !prev || prev.deps.length !== deps.length || deps.some((dep, i) => !Object.is(dep, prev.deps[i]));
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

type Call = { path: string; options?: { method?: string; body?: string } };

const mocks: Plugin = {
  name: "d3-start-property-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:d3sp-react") return "\0d3sp-react";
    if (source === "react/jsx-runtime" || source === "react/jsx-dev-runtime" || source === "virtual:d3sp-jsx") return "\0d3sp-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:d3sp-query") return "\0d3sp-query";
    if (source === "wouter" || source === "virtual:d3sp-wouter") return "\0d3sp-wouter";
    if (source === "../lib/api") return "\0d3sp-api";
    return null;
  },
  load(id) {
    if (id === "\0d3sp-react") {
      return `
        export const useState = (...args) => globalThis.__d3spHooks.useState(...args);
        export const useEffect = (...args) => globalThis.__d3spHooks.useEffect(...args);
        export const useRef = (...args) => globalThis.__d3spHooks.useRef(...args);
      `;
    }
    if (id === "\0d3sp-jsx") {
      return `
        export const Fragment = Symbol.for("d3sp-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0d3sp-query") {
      return `
        export const useMutation = (options) => ({
          isPending: false,
          isError: false,
          error: null,
          mutate(input) {
            globalThis.__d3spPending.push(
              Promise.resolve()
                .then(() => options.mutationFn(input))
                .then(
                  (result) => { options.onSuccess?.(result); },
                  () => {},
                ),
            );
          },
        });
      `;
    }
    if (id === "\0d3sp-wouter") {
      return `export const useLocation = () => ["/", () => {}];`;
    }
    if (id === "\0d3sp-api") {
      return `
        export const apiFetch = (path, options) => globalThis.__d3spApiFetch(path, options);
        export function apiErrorMessage(_error, fallback) { return fallback; }
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
        { find: /^react$/, replacement: "virtual:d3sp-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:d3sp-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:d3sp-query" },
        { find: /^wouter$/, replacement: "virtual:d3sp-wouter" },
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

let hadDocument = false;
let previousDocument: unknown;

function install(fetchImpl: (path: string, options?: { method?: string; body?: string }) => Promise<unknown>) {
  const hooks = createHarness();
  const calls: Call[] = [];
  const pending: Promise<unknown>[] = [];
  hadDocument = "document" in globalThis;
  previousDocument = (globalThis as { document?: unknown }).document;
  Object.assign(globalThis, {
    __d3spHooks: hooks,
    __d3spPending: pending,
    __d3spApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, options });
      const result = fetchImpl(path, options);
      pending.push(result);
      return result;
    },
    document: {
      addEventListener() {},
      removeEventListener() {},
    },
  });
  return { hooks, calls, pending };
}

function clearGlobals() {
  for (const key of ["__d3spHooks", "__d3spPending", "__d3spApiFetch"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
  if (hadDocument) (globalThis as { document?: unknown }).document = previousDocument;
  else delete (globalThis as { document?: unknown }).document;
}

type Page = () => unknown;

function render(hooks: ReturnType<typeof createHarness>, Page: Page) {
  hooks.beginRender();
  return Page();
}

function input(tree: unknown, placeholder: string): ElementNode {
  const box = findAll(tree, (element) => element.type === "input" && element.props?.placeholder === placeholder)[0];
  assert.ok(box, `missing input ${placeholder}`);
  return box;
}

function button(tree: unknown, label: string): ElementNode {
  const found = findAll(tree, (element) => element.type === "button" && textContent(element).trim() === label)[0];
  assert.ok(found, `missing button ${label}`);
  return found;
}

test("choosing a suggestion posts suburb, state and postcode", async (t) => {
  const { hooks, calls, pending } = install(async (path, options) => {
    if (path.startsWith("/properties/address-search")) {
      return {
        candidates: [
          {
            placeId: "place-hamilton",
            formattedAddress: "300 Racecourse Road, Hamilton QLD, Australia",
            suburb: "Hamilton",
            state: "QLD",
            postcode: "4007",
          },
        ],
      };
    }
    assert.equal(options?.method, "POST");
    return { property: { id: 10895 } };
  });
  try {
    await withVite(async (vite) => {
      const { default: StartProperty } = (await vite.ssrLoadModule("/src/pages/StartProperty.tsx")) as { default: Page };
      t.mock.timers.enable({ apis: ["setTimeout"] });

      render(hooks, StartProperty);
      hooks.flushEffects();

      input(render(hooks, StartProperty), "Search an address…").props!.onChange!({
        target: { value: "300 Racecourse Road Hamilton" },
      });
      render(hooks, StartProperty);
      hooks.flushEffects();
      t.mock.timers.tick(300);
      await Promise.all(pending);

      const suggestions = render(hooks, StartProperty);
      assert.match(textContent(suggestions), /300 Racecourse Road, Hamilton QLD, Australia/);
      const option = findAll(suggestions, (element) => element.props?.onClick !== undefined && textContent(element).includes("Hamilton"))[0];
      assert.ok(option, "the suggestion is clickable");
      option.props!.onClick!();
      await Promise.all(pending);

      const created = calls.find((call) => call.options?.method === "POST");
      assert.ok(created, "choosing a suggestion creates the property");
      assert.equal(created.path, "/properties");
      assert.deepEqual(JSON.parse(created.options!.body!), {
        formattedAddress: "300 Racecourse Road, Hamilton QLD, Australia",
        placeId: "place-hamilton",
        suburb: "Hamilton",
        state: "QLD",
        postcode: "4007",
      });

      const sellerStep = render(hooks, StartProperty);
      assert.match(textContent(sellerStep), /Who is selling the property/);
    });
  } finally {
    t.mock.timers.reset();
    clearGlobals();
  }
});

test("a suggestion without components posts the address and place id only", async (t) => {
  const { hooks, calls, pending } = install(async (path) => {
    if (path.startsWith("/properties/address-search")) {
      return {
        candidates: [{ placeId: "mock-street", formattedAddress: "12 Harbour Street", suburb: "  ", state: "", postcode: "" }],
      };
    }
    return { property: { id: 7 } };
  });
  try {
    await withVite(async (vite) => {
      const { default: StartProperty } = (await vite.ssrLoadModule("/src/pages/StartProperty.tsx")) as { default: Page };
      t.mock.timers.enable({ apis: ["setTimeout"] });
      render(hooks, StartProperty);
      hooks.flushEffects();
      input(render(hooks, StartProperty), "Search an address…").props!.onChange!({ target: { value: "12 Harbour Street" } });
      render(hooks, StartProperty);
      hooks.flushEffects();
      t.mock.timers.tick(300);
      await Promise.all(pending);
      const suggestions = render(hooks, StartProperty);
      const option = findAll(suggestions, (element) => textContent(element).includes("12 Harbour Street") && element.props?.onClick !== undefined)[0];
      assert.ok(option);
      option.props!.onClick!();
      await Promise.all(pending);
      const created = calls.find((call) => call.options?.method === "POST");
      assert.ok(created);
      assert.deepEqual(JSON.parse(created.options!.body!), {
        formattedAddress: "12 Harbour Street",
        placeId: "mock-street",
      });
    });
  } finally {
    t.mock.timers.reset();
    clearGlobals();
  }
});

test("manual entry still posts the typed address and no place id", async () => {
  const { hooks, calls, pending } = install(async () => ({ property: { id: 8 } }));
  try {
    await withVite(async (vite) => {
      const { default: StartProperty } = (await vite.ssrLoadModule("/src/pages/StartProperty.tsx")) as { default: Page };
      const first = render(hooks, StartProperty);
      button(first, "Not this address? Create New Address").props!.onClick!();
      const manual = render(hooks, StartProperty);
      input(manual, "Enter address manually…").props!.onChange!({ target: { value: "8 Manual Street" } });
      const ready = render(hooks, StartProperty);
      const create = button(ready, "Create Property");
      assert.equal(create.props?.disabled, false);
      create.props!.onClick!();
      await Promise.all(pending);
      const created = calls.find((call) => call.options?.method === "POST");
      assert.ok(created);
      assert.deepEqual(JSON.parse(created.options!.body!), {
        formattedAddress: "8 Manual Street",
        isManualAddress: true,
      });
    });
  } finally {
    clearGlobals();
  }
});
