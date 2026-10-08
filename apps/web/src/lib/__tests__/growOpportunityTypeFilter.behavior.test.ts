import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

// C-5a — the Opportunities tab filter. The control is a labelled native
// select (keyboard operable), it asks the server for the chosen group, and
// the "Showing N of M" line follows that group's total. Changing it drops
// pages already appended for the previous group.

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

function byId(tree: unknown, id: string): ElementNode | undefined {
  return findAll(tree, (element) => element.props?.id === id)[0];
}

function button(tree: unknown, label: string): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "button" && textContent(element).includes(label))[0];
}

type QueryOptions = { queryKey?: unknown[]; queryFn?: () => Promise<unknown> };

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
  name: "c5a-opportunity-type-filter-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:c5a-react") return "\0c5a-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:c5a-jsx") return "\0c5a-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:c5a-query") return "\0c5a-query";
    if (source === "wouter" || source === "virtual:c5a-wouter") return "\0c5a-wouter";
    if (source === "../lib/api") return "\0c5a-api";
    if (source === "../lib/session") return "\0c5a-session";
    if (
      source === "../components/AskAgentEngine" ||
      source === "../components/CommunicationsSection" ||
      source === "../components/PropertyIntelligencePanel" ||
      source === "../components/GrowContactTranscriptPanel" ||
      source === "../components/GrowPendingCommitmentProposals" ||
      source === "../components/ErrorBoundary"
    ) {
      return "\0c5a-components";
    }
    return null;
  },
  load(id) {
    if (id === "\0c5a-react") {
      return `
        export const useState = (...args) => globalThis.__c5aHooks.useState(...args);
        export const useEffect = (...args) => globalThis.__c5aHooks.useEffect(...args);
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0c5a-jsx") {
      return `
        export const Fragment = Symbol.for("c5a-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0c5a-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries() {} });
        export const useQuery = (options) => {
          const key = options && options.queryKey && options.queryKey[0];
          if (key === "grow-opportunities") globalThis.__c5aOpportunityQuery = options;
          if (key === "grow-appraisals") return { isLoading: false, isError: false, data: { appraisals: [] }, refetch() {} };
          const filter = options.queryKey[1];
          return { isLoading: false, isError: false, data: globalThis.__c5aPages[filter], refetch() {} };
        };
        export const useMutation = () => ({ isPending: false, isError: false, error: null, mutate() {} });
      `;
    }
    if (id === "\0c5a-wouter") {
      return `export const Link = (props) => ({ type: "a", props }); export const useSearch = () => "";`;
    }
    if (id === "\0c5a-api") {
      return `
        export class ApiError extends Error {}
        export const apiFetch = (path, options) => globalThis.__c5aApiFetch(path, options);
        export function apiErrorMessage(_error, fallback) { return fallback; }
      `;
    }
    if (id === "\0c5a-session") {
      return `
        export const useSession = () => ({ user: { id: 1, firstName: "Sam", role: "Agent" } });
        export const useEntitlements = () => ({
          isLoading: false,
          hasEntitlement: (key) => globalThis.__c5aEntitlements.includes(key),
        });
      `;
    }
    if (id === "\0c5a-components") {
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

function opportunity(id: number, opportunityType: string, reason: string) {
  return {
    id,
    opportunityType,
    status: "Open",
    stage: "New",
    reason,
    partyId: 12,
    propertyId: null,
    recommendedNextAction: null,
    nextActionDueAt: null,
  };
}

function installGlobals() {
  const hooks = createHarness();
  const calls: string[] = [];
  Object.assign(globalThis, {
    __c5aHooks: hooks,
    __c5aEntitlements: ["grow.access", "grow.contacts.read"],
    __c5aOpportunityQuery: null,
    __c5aPages: {
      all: {
        opportunities: [opportunity(1, "Listing", "First page listing")],
        nextCursor: "cursor-all",
        total: 2,
      },
      seller_side: {
        opportunities: [opportunity(9, "Appraisal", "Seller appraisal")],
        nextCursor: null,
        total: 1,
      },
      property_management: {
        opportunities: [opportunity(7, "PropertyManagement", "Managed block")],
        nextCursor: "cursor-pm",
        total: 4,
      },
      other: {
        opportunities: [opportunity(8, "Other", "Unclassified other")],
        nextCursor: null,
        total: 1,
      },
    },
    __c5aApiFetch: (path: string) => {
      calls.push(path);
      if (path.includes("cursor=cursor-all")) {
        return Promise.resolve({
          opportunities: [opportunity(2, "General", "Second page listing")],
          nextCursor: null,
          total: 2,
        });
      }
      if (path.includes("type=property_management") && path.includes("cursor=")) {
        return Promise.resolve({
          opportunities: [opportunity(70, "PropertyManagement", "Second managed")],
          nextCursor: null,
          total: 4,
        });
      }
      return Promise.resolve({ opportunities: [], nextCursor: null, total: 0 });
    },
  });
  return { hooks, calls };
}

function clearGlobals() {
  for (const key of ["__c5aHooks", "__c5aEntitlements", "__c5aOpportunityQuery", "__c5aPages", "__c5aApiFetch"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

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
        { find: /^react$/, replacement: "virtual:c5a-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:c5a-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:c5a-query" },
        { find: /^wouter$/, replacement: "virtual:c5a-wouter" },
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

test("the opportunity type filter is labelled, requests the group, and keeps the count", async () => {
  const { hooks, calls } = installGlobals();
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: (props: { onViewContact: (partyId: number) => void }) => unknown;
      };
      const render = () => {
        hooks.beginRender();
        return GrowOpportunitiesTab({ onViewContact: () => {} });
      };

      let tree = render();
      const select = byId(tree, "grow-opportunity-type-filter");
      assert.ok(select, "the opportunities screen has a type filter");
      assert.equal(select.type, "select");
      assert.equal(select.props?.disabled, undefined);
      assert.notEqual(select.props?.tabIndex, -1);
      const label = findAll(tree, (element) => element.type === "label" && element.props?.htmlFor === "grow-opportunity-type-filter")[0];
      assert.equal(textContent(label), "Opportunity type");
      const options = findAll(select, (element) => element.type === "option");
      assert.deepEqual(
        options.map((option) => option.props?.value),
        ["all", "seller_side", "property_management", "other"],
      );
      assert.deepEqual(options.map((option) => textContent(option)), [
        "All",
        "Seller-side (Listing + Appraisal)",
        "Property Management",
        "Other",
      ]);
      assert.equal(select.props?.value, "all");
      assert.match(textContent(tree), /Showing 1 of 2 opportunities/);
      const count = findAll(tree, (element) => element.props?.role === "status" && textContent(element).includes("Showing"))[0];
      assert.ok(count, "the count is exposed to assistive tech");

      const initial = (globalThis as { __c5aOpportunityQuery?: QueryOptions }).__c5aOpportunityQuery;
      assert.deepEqual(initial?.queryKey, ["grow-opportunities", "all"]);
      await initial?.queryFn?.();
      assert.equal(calls.at(-1), "/grow/opportunities");

      (button(tree, "Load more")!.props!.onClick as () => void)();
      await new Promise((resolve) => setTimeout(resolve, 0));
      tree = render();
      assert.match(textContent(tree), /Showing 2 of 2 opportunities/);
      assert.match(textContent(tree), /Second page listing/);
      assert.equal(calls.some((path) => path === "/grow/opportunities?cursor=cursor-all"), true);

      (select.props!.onChange as (event: { target: { value: string } }) => void)({ target: { value: "seller_side" } });
      tree = render();
      const sellerSelect = byId(tree, "grow-opportunity-type-filter");
      assert.equal(sellerSelect?.props?.value, "seller_side");
      assert.match(textContent(tree), /Showing 1 of 1 opportunity/);
      assert.match(textContent(tree), /Seller appraisal/);
      assert.doesNotMatch(textContent(tree), /Second page listing/);
      assert.doesNotMatch(textContent(tree), /First page listing/);
      const sellerQuery = (globalThis as { __c5aOpportunityQuery?: QueryOptions }).__c5aOpportunityQuery;
      assert.deepEqual(sellerQuery?.queryKey, ["grow-opportunities", "seller_side"]);
      await sellerQuery?.queryFn?.();
      assert.equal(calls.at(-1), "/grow/opportunities?type=seller_side");

      (sellerSelect!.props!.onChange as (event: { target: { value: string } }) => void)({ target: { value: "property_management" } });
      tree = render();
      assert.match(textContent(tree), /Showing 1 of 4 opportunities/);
      assert.match(textContent(tree), /Managed block/);
      (button(tree, "Load more")!.props!.onClick as () => void)();
      await new Promise((resolve) => setTimeout(resolve, 0));
      tree = render();
      assert.match(textContent(tree), /Showing 2 of 4 opportunities/);
      assert.equal(
        calls.some((path) => path === "/grow/opportunities?type=property_management&cursor=cursor-pm"),
        true,
      );

      (byId(tree, "grow-opportunity-type-filter")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "not-a-group" },
      });
      tree = render();
      assert.equal(byId(tree, "grow-opportunity-type-filter")?.props?.value, "property_management");
    });
  } finally {
    clearGlobals();
  }
});
