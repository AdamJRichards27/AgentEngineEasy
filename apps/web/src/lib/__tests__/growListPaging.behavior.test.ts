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

function rowIndexes(tree: unknown): number[] {
  return findAll(tree, (element) => typeof element.props?.["data-grow-index"] === "number")
    .map((element) => element.props!["data-grow-index"] as number)
    .sort((a, b) => a - b);
}

function spacerHeights(tree: unknown): number[] {
  return findAll(tree, (element) => element.props?.className === "grow-virtual-spacer").map((element) => {
    const child = element.props?.children as ElementNode | undefined;
    const style = (child?.props?.style ?? element.props?.style) as { height?: number } | undefined;
    return style?.height ?? 0;
  });
}

function mixedHeight(index: number): number {
  return 28 + (index % 5) * 22;
}

function renderList(
  page: { GrowVirtualTable: (props: Record<string, unknown>) => unknown; GrowVirtualTimeline: (props: Record<string, unknown>) => unknown },
  kind: "table" | "timeline",
  props: Record<string, unknown>,
) {
  const items = Array.from({ length: 280 }, (_, index) => ({ id: index + 1, name: `Row ${index + 1}` }));
  const shared = {
    singular: "row",
    plural: "rows",
    items,
    total: 280,
    getKey: (item: { id: number }) => item.id,
    hasMore: false,
    loadingMore: false,
    moreError: null,
    onLoadMore: () => {},
    rowHeight: mixedHeight,
    ...props,
  };
  if (kind === "timeline") {
    return page.GrowVirtualTimeline({
      ...shared,
      renderItem: (item: { name: string }) => item.name,
    });
  }
  return page.GrowVirtualTable({
    ...shared,
    colSpan: 1,
    head: "Name",
    renderCells: (item: { name: string }) => item.name,
  });
}

test("every loaded row renders at the end of each Grow list, including mixed heights", async () => {
  const hooks = createHarness();
  (globalThis as { __growListHooks?: unknown }).__growListHooks = hooks;
  const { vite, page } = await loadList();
  try {
    const lists: Array<{ label: string; kind: "table" | "timeline"; estimate: number }> = [
      { label: "Contacts", kind: "table", estimate: 84 },
      { label: "Relationships", kind: "table", estimate: 84 },
      { label: "Recent activity", kind: "timeline", estimate: 96 },
      { label: "Opportunities", kind: "table", estimate: 120 },
    ];
    let total = 0;
    for (let index = 0; index < 280; index += 1) total += mixedHeight(index);
    const viewport = 360;
    for (const list of lists) {
      const listHooks = createHarness();
      (globalThis as { __growListHooks?: unknown }).__growListHooks = listHooks;
      listHooks.beginRender();
      const first = renderList(page, list.kind, { label: list.label, estimate: list.estimate });
      assert.doesNotMatch(textContent(first), /Row 280/, `${list.label} does not paint the tail up front`);
      const region = findAll(first, (element) => element.props?.role === "region" && element.props?.["aria-label"] === list.label)[0];
      assert.ok(region, `${list.label} scroll region`);
      const scroller = { scrollTop: 0, clientHeight: viewport, scrollHeight: total };
      (region!.props!.onKeyDown as (event: unknown) => void)({
        key: "End",
        currentTarget: scroller,
        preventDefault() {},
      });
      assert.equal(scroller.scrollTop, total - viewport, `${list.label} End reaches the scrollport bottom`);
      listHooks.beginRender();
      const tail = renderList(page, list.kind, { label: list.label, estimate: list.estimate });
      const indexes = rowIndexes(tail);
      assert.ok(indexes.includes(279), `${list.label} renders index 279`);
      assert.equal(indexes.at(-1), 279, `${list.label} window ends on the last loaded row`);
      assert.ok(!indexes.includes(0), `${list.label} stays virtualised at the end`);
      assert.ok(indexes.length < 80, `${list.label} does not paint every row`);
      assert.match(textContent(tail), /Showing 280 of 280 rows/);
      assert.match(textContent(tail), /Row 280/);
      const spacers = spacerHeights(tail);
      assert.ok(spacers.length <= 1, `${list.label} has no blank tail spacer`);
    }
  } finally {
    await vite.close();
    delete (globalThis as { __growListHooks?: unknown }).__growListHooks;
  }
});

test("a short browser scroll range still reaches the last row, and a jump leaves no gap", async () => {
  const hooks = createHarness();
  (globalThis as { __growListHooks?: unknown }).__growListHooks = hooks;
  const { vite, page } = await loadList();
  try {
    const items = Array.from({ length: 280 }, (_, index) => ({ id: index + 1, name: `Row ${index + 1}` }));
    hooks.beginRender();
    const first = page.GrowVirtualTable({
      label: "Opportunities",
      singular: "opportunity",
      plural: "opportunities",
      colSpan: 1,
      head: "Name",
      items,
      total: 280,
      estimate: 120,
      getKey: (item: { id: number }) => item.id,
      renderCells: (item: { name: string }) => item.name,
      hasMore: false,
      loadingMore: false,
      moreError: null,
      onLoadMore: () => {},
    });
    const region = findAll(first, (element) => element.props?.role === "region")[0];
    // UAT: the laid-out scroll height stops short of estimate × count, so the
    // last indexes would otherwise remain inside the bottom spacer.
    const scroller = { scrollTop: 0, clientHeight: 400, scrollHeight: 9000 };
    (region!.props!.onKeyDown as (event: unknown) => void)({
      key: "End",
      currentTarget: scroller,
      preventDefault() {},
    });
    hooks.beginRender();
    const tail = page.GrowVirtualTable({
      label: "Opportunities",
      singular: "opportunity",
      plural: "opportunities",
      colSpan: 1,
      head: "Name",
      items,
      total: 280,
      estimate: 120,
      getKey: (item: { id: number }) => item.id,
      renderCells: (item: { name: string }) => item.name,
      hasMore: false,
      loadingMore: false,
      moreError: null,
      onLoadMore: () => {},
    });
    const tailIndexes = rowIndexes(tail);
    assert.ok(tailIndexes.includes(279), "index 279 renders when the scrollport is at its real end");
    assert.ok(!tailIndexes.includes(0));

    const height = mixedHeight;
    let total = 0;
    const offset = [0];
    for (let index = 0; index < 280; index += 1) {
      total += height(index);
      offset.push(total);
    }
    const viewport = 300;
    const scrollTop = 4500;
    hooks.beginRender();
    const jumpedFrom = page.GrowVirtualTable({
      label: "Contacts",
      singular: "contact",
      plural: "contacts",
      colSpan: 1,
      head: "Name",
      items,
      total: 280,
      estimate: 84,
      rowHeight: height,
      getKey: (item: { id: number }) => item.id,
      renderCells: (item: { name: string }) => item.name,
      hasMore: false,
      loadingMore: false,
      moreError: null,
      onLoadMore: () => {},
    });
    const jumpRegion = findAll(jumpedFrom, (element) => element.props?.["aria-label"] === "Contacts")[0];
    const jumpedScroller = { scrollTop, clientHeight: viewport, scrollHeight: total };
    (jumpRegion!.props!.onScroll as (event: unknown) => void)({ currentTarget: jumpedScroller });
    hooks.beginRender();
    const jumped = page.GrowVirtualTable({
      label: "Contacts",
      singular: "contact",
      plural: "contacts",
      colSpan: 1,
      head: "Name",
      items,
      total: 280,
      estimate: 84,
      rowHeight: height,
      getKey: (item: { id: number }) => item.id,
      renderCells: (item: { name: string }) => item.name,
      hasMore: false,
      loadingMore: false,
      moreError: null,
      onLoadMore: () => {},
    });
    const indexes = rowIndexes(jumped);
    assert.ok(indexes.length > 1 && indexes.length < 280);
    for (let i = 1; i < indexes.length; i += 1) assert.equal(indexes[i], indexes[i - 1]! + 1, "the window has no holes");
    const top = indexes[0] === 0 ? 0 : spacerHeights(jumped)[0];
    assert.equal(top, offset[indexes[0]!], "the leading spacer matches the rows above the window");
    assert.ok(top <= scrollTop, "the leading spacer does not cover the viewport");
    let covered = top ?? 0;
    for (const index of indexes) covered += height(index);
    assert.ok(covered >= scrollTop + viewport, "rendered rows cover the viewport after the jump");
    const firstVisible = offset.findIndex((value, index) => index > 0 && value > scrollTop) - 1;
    assert.ok(indexes[0]! < firstVisible, "overscan paints rows above the viewport");
  } finally {
    await vite.close();
    delete (globalThis as { __growListHooks?: unknown }).__growListHooks;
  }
});
