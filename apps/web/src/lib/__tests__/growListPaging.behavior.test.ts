import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

// The list window has to keep every loaded row in the accessibility tree's
// count, render only a window of them, and move that window from the keyboard.
// Same in-memory React harness as the other Grow behaviour tests.

interface ElementNode {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
  key?: unknown;
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

const virtualMocks: Plugin = {
  name: "grow-list-paging-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "react/jsx-dev-runtime" || source === "react/jsx-runtime") return "\0react";
    if (source === "../lib/api") return "\0api";
    return null;
  },
  load(id) {
    if (id === "\0react") {
      return `
        export const Fragment = Symbol.for("grow-list-fragment");
        export const useState = (initial) => globalThis.__growListHooks.useState(initial);
        export const useRef = (initial) => ({ current: initial });
        export const useEffect = () => {};
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0api") {
      return `export function apiErrorMessage(error, fallback) { return fallback; }`;
    }
    return null;
  },
};

function createHarness() {
  const state: unknown[] = [];
  let cursor = 0;
  return {
    beginRender() {
      cursor = 0;
    },
    useState(initial: unknown) {
      const index = cursor++;
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

async function loadList() {
  const vite = await createServer({
    root: new URL("../../..", import.meta.url).pathname,
    configFile: false,
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: true },
    plugins: [virtualMocks],
  });
  const page = (await vite.ssrLoadModule("/src/components/GrowVirtualList.tsx")) as {
    GrowVirtualTable: (props: Record<string, unknown>) => unknown;
    useGrowCursorPages: (options: Record<string, unknown>) => {
      items: unknown[];
      total: number | undefined;
      hasMore: boolean;
      loadMore: () => void;
    };
  };
  return { vite, page };
}

test("a long list renders a window, announces Showing N of M, and scrolls from the keyboard", async () => {
  const hooks = createHarness();
  (globalThis as { __growListHooks?: unknown }).__growListHooks = hooks;
  const { vite, page } = await loadList();
  try {
    const items = Array.from({ length: 40 }, (_, index) => ({ id: index + 1, name: `Row ${index + 1}` }));
    hooks.beginRender();
    const tree = page.GrowVirtualTable({
      label: "Contacts",
      singular: "contact",
      plural: "contacts",
      colSpan: 2,
      items,
      total: 120,
      getKey: (item: { id: number }) => item.id,
      renderCells: (item: { name: string }) => item.name,
      hasMore: true,
      loadingMore: false,
      moreError: null,
      onLoadMore: () => {},
      estimate: 84,
      head: "Name",
    });
    assert.match(textContent(tree), /Showing 40 of 120 contacts/);
    const status = findAll(tree, (element) => element.props?.role === "status");
    assert.equal(status.length, 1);
    const rendered = findAll(tree, (element) => element.type === "tr" && element.props?.["aria-hidden"] !== true);
    assert.ok(rendered.length > 0, "the first rows are rendered");
    assert.ok(rendered.length < items.length, "rows outside the window are not rendered");
    assert.match(textContent(tree), /Row 1/);
    assert.doesNotMatch(textContent(tree), /Row 40/);

    const region = findAll(tree, (element) => element.props?.role === "region")[0];
    assert.equal(region?.props?.tabIndex, 0);
    assert.equal(region?.props?.["aria-label"], "Contacts");
    const scroller = { scrollTop: 0, clientHeight: 200, scrollHeight: 4000 };
    (region!.props!.onKeyDown as (event: unknown) => void)({
      key: "ArrowDown",
      currentTarget: scroller,
      preventDefault() {},
    });
    assert.equal(scroller.scrollTop, 84);
    const loadMore = findAll(tree, (element) => element.type === "button" && textContent(element) === "Load more")[0];
    assert.equal(loadMore?.props?.["aria-label"], "Load more contacts");
  } finally {
    await vite.close();
    delete (globalThis as { __growListHooks?: unknown }).__growListHooks;
  }
});

test("useGrowCursorPages appends the next page without duplicating the boundary row", async () => {
  const hooks = createHarness();
  (globalThis as { __growListHooks?: unknown }).__growListHooks = hooks;
  const { vite, page } = await loadList();
  try {
    hooks.beginRender();
    let paging = page.useGrowCursorPages({
      resetKey: "contacts",
      page: { items: [{ id: 1 }, { id: 2 }], nextCursor: "cursor-1", total: 3 },
      getId: (item: { id: number }) => item.id,
      fetchPage: async () => ({ items: [{ id: 2 }, { id: 3 }], nextCursor: null }),
    });
    assert.deepEqual(
      paging.items.map((item) => (item as { id: number }).id),
      [1, 2],
    );
    assert.equal(paging.hasMore, true);
    paging.loadMore();
    await new Promise((resolve) => setTimeout(resolve, 0));
    hooks.beginRender();
    paging = page.useGrowCursorPages({
      resetKey: "contacts",
      page: { items: [{ id: 1 }, { id: 2 }], nextCursor: "cursor-1", total: 3 },
      getId: (item: { id: number }) => item.id,
      fetchPage: async () => ({ items: [], nextCursor: null }),
    });
    assert.deepEqual(
      paging.items.map((item) => (item as { id: number }).id),
      [1, 2, 3],
    );
    assert.equal(paging.hasMore, false);
    assert.equal(paging.total, 3);
  } finally {
    await vite.close();
    delete (globalThis as { __growListHooks?: unknown }).__growListHooks;
  }
});
