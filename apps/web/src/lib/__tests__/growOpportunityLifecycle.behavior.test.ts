// GP-1 — Opportunities tab contact column and manual lifecycle actions.
// Controls are native select, button and input elements so they are keyboard
// operable. The actions cell is the one the phone-width stylesheet keeps on
// screen at 375px.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

interface ElementNode {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
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

function byId(tree: unknown, id: string): ElementNode | undefined {
  return findAll(tree, (element) => element.props?.id === id)[0];
}

function button(tree: unknown, label: string): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "button" && textContent(element).trim() === label)[0];
}

function links(tree: unknown): Array<{ href: string; text: string }> {
  return findAll(tree, (element) => element.type === "a").map((element) => ({
    href: String(element.props?.href),
    text: textContent(element),
  }));
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
    useEffect(fn: () => unknown, deps: unknown[] = []) {
      const index = effectCursor++;
      const prev = effects[index];
      const changed = !prev || prev.deps.length !== deps.length || deps.some((dep, i) => !Object.is(dep, prev.deps[i]));
      if (!prev || changed) effects[index] = { fn, deps, cleanup: prev?.cleanup, run: true };
      else prev.run = false;
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

const virtualMocks: Plugin = {
  name: "gp1-opportunity-lifecycle-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:gp1-react") return "\0gp1-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:gp1-jsx") return "\0gp1-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:gp1-query") return "\0gp1-query";
    if (source === "wouter" || source === "virtual:gp1-wouter") return "\0gp1-wouter";
    if (source === "../lib/api") return "\0gp1-api";
    if (source === "../lib/session") return "\0gp1-session";
    if (
      source === "../components/AskAgentEngine" ||
      source === "../components/CommunicationsSection" ||
      source === "../components/PropertyIntelligencePanel" ||
      source === "../components/GrowContactTranscriptPanel" ||
      source === "../components/GrowPendingCommitmentProposals" ||
      source === "../components/ErrorBoundary"
    ) {
      return "\0gp1-components";
    }
    return null;
  },
  load(id) {
    if (id === "\0gp1-react") {
      return `
        export const useState = (...args) => globalThis.__gp1Hooks.useState(...args);
        export const useEffect = (...args) => globalThis.__gp1Hooks.useEffect(...args);
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0gp1-jsx") {
      return `
        export const Fragment = Symbol.for("gp1-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0gp1-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries() {} });
        export const useQuery = (options) => {
          const key = options && options.queryKey && options.queryKey[0];
          if (key === "grow-opportunities") {
            globalThis.__gp1OpportunityQuery = options;
            const filter = options.queryKey[1];
            return {
              isLoading: false,
              isError: false,
              data: globalThis.__gp1Pages[filter],
              refetch() { return options.queryFn(); },
            };
          }
          if (key === "grow-appraisals") return { isLoading: false, isError: false, data: { appraisals: [] }, refetch() {} };
          return { isLoading: false, isError: false, data: undefined, refetch() {} };
        };
        export const useMutation = (options) => ({
          isPending: false,
          isError: false,
          error: null,
          mutate(input) {
            globalThis.__gp1Calls.push({ input, path: null });
            const pending = Promise.resolve(options.mutationFn(input)).then((result) => {
              options.onSuccess?.(result, input);
              return result;
            });
            globalThis.__gp1Pending.push(pending);
            return pending;
          },
        });
      `;
    }
    if (id === "\0gp1-wouter") {
      return `export const Link = (props) => ({ type: "a", props }); export const useSearch = () => "";`;
    }
    if (id === "\0gp1-api") {
      return `
        export class ApiError extends Error {}
        export const apiFetch = (path, options) => globalThis.__gp1ApiFetch(path, options);
        export function apiErrorMessage(_error, fallback) { return fallback; }
      `;
    }
    if (id === "\0gp1-session") {
      return `
        export const useSession = () => ({ user: { id: 1, firstName: "Sam", role: "Agent" } });
        export const useEntitlements = () => ({
          isLoading: false,
          hasEntitlement: (key) => globalThis.__gp1Entitlements.includes(key),
        });
      `;
    }
    if (id === "\0gp1-components") {
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

function opportunity(overrides: Record<string, unknown> = {}) {
  return {
    id: 41,
    opportunityType: "Listing",
    status: "Open",
    stage: "Qualified",
    reason: "Seller might list",
    partyId: 12,
    propertyId: null,
    recommendedNextAction: null,
    nextActionDueAt: null,
    contactName: "Ada Owner",
    ...overrides,
  };
}

function installGlobals(entitlements: string[]) {
  const hooks = createHarness();
  const calls: string[] = [];
  const bodies: string[] = [];
  Object.assign(globalThis, {
    __gp1Hooks: hooks,
    __gp1Entitlements: entitlements,
    __gp1OpportunityQuery: null,
    __gp1Calls: [] as Array<{ input: unknown }>,
    __gp1Pending: [] as Promise<unknown>[],
    __gp1Bodies: bodies,
    __gp1Pages: {
      all: {
        opportunities: [opportunity(), opportunity({ id: 42, contactName: "Bea Manager", opportunityType: "PropertyManagement", stage: "New" })],
        nextCursor: null,
        total: 2,
      },
      seller_side: {
        opportunities: [opportunity()],
        nextCursor: null,
        total: 1,
      },
    },
    __gp1ApiFetch: (path: string, options?: { body?: string }) => {
      calls.push(path);
      if (typeof options?.body === "string") bodies.push(options.body);
      return Promise.resolve({ opportunity: { id: 41 } });
    },
  });
  return { hooks, calls, bodies };
}

function clearGlobals() {
  for (const key of ["__gp1Hooks", "__gp1Entitlements", "__gp1OpportunityQuery", "__gp1Calls", "__gp1Pending", "__gp1Bodies", "__gp1Pages", "__gp1ApiFetch"]) {
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
        { find: /^react$/, replacement: "virtual:gp1-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:gp1-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:gp1-query" },
        { find: /^wouter$/, replacement: "virtual:gp1-wouter" },
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

const MANAGE = ["grow.access", "grow.contacts.read", "grow.opportunities.manage"];

test("the contact column links to Contact 360 when the user can see that contact", async () => {
  const { hooks } = installGlobals(MANAGE);
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: (props: { onViewContact: (partyId: number) => void }) => unknown;
      };
      const tree = (() => {
        hooks.beginRender();
        return GrowOpportunitiesTab({ onViewContact: () => {} });
      })();
      assert.match(textContent(tree), /Contact/);
      assert.match(textContent(tree), /Ada Owner/);
      assert.match(textContent(tree), /Bea Manager/);
      const contactLinks = links(tree).filter((link) => link.href.startsWith("/grow/contacts/"));
      assert.deepEqual(contactLinks, [
        { href: "/grow/contacts/12", text: "Ada Owner" },
        { href: "/grow/contacts/12", text: "Bea Manager" },
      ]);
      const header = findAll(tree, (element) => element.type === "th").map((element) => textContent(element));
      assert.equal(header[0], "Contact");
    });
  } finally {
    clearGlobals();
  }
});

test("stage, mark lost and close are keyboard controls and lost requires a reason", async () => {
  const { hooks, calls, bodies } = installGlobals(MANAGE);
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
      (byId(tree, "grow-opportunity-type-filter")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "seller_side" },
      });
      tree = render();

      const stage = byId(tree, "grow-opportunity-stage-41");
      assert.ok(stage, "each open row has a stage control");
      assert.equal(stage.type, "select");
      assert.notEqual(stage.props?.tabIndex, -1);
      assert.equal(stage.props?.value, "Qualified");
      const stageLabel = findAll(tree, (element) => element.type === "label" && element.props?.htmlFor === "grow-opportunity-stage-41")[0];
      assert.equal(textContent(stageLabel), "Change stage");
      assert.deepEqual(
        findAll(stage, (element) => element.type === "option").map((option) => option.props?.value),
        ["New", "Contacted", "Qualified"],
      );
      const actionsCell = findAll(tree, (element) => element.props?.className === "grow-opportunity-actions-cell")[0];
      assert.ok(actionsCell, "actions stay in the cell the phone layout pins");

      (stage.props!.onChange as (event: { target: { value: string } }) => void)({ target: { value: "Contacted" } });
      await Promise.all((globalThis as { __gp1Pending: Promise<unknown>[] }).__gp1Pending);
      assert.ok(calls.includes("/grow/opportunities/41/lifecycle"));
      assert.deepEqual(JSON.parse(bodies.at(-1) ?? "{}"), { stage: "Contacted" });

      const markLost = button(tree, "Mark lost");
      assert.ok(markLost);
      assert.equal(markLost.type, "button");
      assert.notEqual(markLost.props?.tabIndex, -1);
      (markLost.props!.onClick as () => void)();
      tree = render();
      const reason = byId(tree, "grow-opportunity-lost-reason-41");
      assert.ok(reason);
      assert.equal(reason.type, "input");
      assert.equal(reason.props?.required, true);
      assert.equal(reason.props?.["aria-required"], "true");
      const reasonLabel = findAll(tree, (element) => element.type === "label" && element.props?.htmlFor === "grow-opportunity-lost-reason-41")[0];
      assert.equal(textContent(reasonLabel), "Lost reason");
      const submit = button(tree, "Mark lost");
      assert.equal(submit?.props?.disabled, true);
      const lostForm = findAll(tree, (element) => element.type === "form" && textContent(element).includes("Lost reason"))[0];
      await (lostForm!.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
      assert.equal(calls.filter((path) => path.includes("/lifecycle")).length, 1, "an empty reason does not write");

      (reason.props!.onChange as (event: { target: { value: string } }) => void)({ target: { value: "  Seller said no  " } });
      tree = render();
      assert.equal(button(tree, "Mark lost")?.props?.disabled, false);
      const filledForm = findAll(tree, (element) => element.type === "form" && textContent(element).includes("Lost reason"))[0];
      await (filledForm!.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
      await Promise.all((globalThis as { __gp1Pending: Promise<unknown>[] }).__gp1Pending);
      assert.deepEqual(JSON.parse(bodies.at(-1) ?? "{}"), { status: "Lost", lostReason: "Seller said no" });

      tree = render();
      (byId(tree, "grow-opportunity-type-filter")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "seller_side" },
      });
      tree = render();
      const close = byId(tree, "grow-opportunity-close-41");
      assert.ok(close);
      assert.equal(close.type, "button");
      assert.equal(close.props?.["aria-label"], "Close opportunity");
      assert.notEqual(close.props?.tabIndex, -1);
      calls.length = 0;
      (close.props!.onClick as () => void)();
      await Promise.all((globalThis as { __gp1Pending: Promise<unknown>[] }).__gp1Pending);
      assert.equal(calls[0], "/grow/opportunities/41/lifecycle");
      assert.deepEqual(JSON.parse(bodies.at(-1) ?? "{}"), { status: "Closed" });
      const query = (globalThis as { __gp1OpportunityQuery?: { queryKey?: unknown[]; queryFn?: () => Promise<unknown> } }).__gp1OpportunityQuery;
      assert.deepEqual(query?.queryKey, ["grow-opportunities", "seller_side"]);
      calls.length = 0;
      await query?.queryFn?.();
      assert.equal(calls.at(-1), "/grow/opportunities?type=seller_side");
    });
  } finally {
    clearGlobals();
  }
});

test("lifecycle actions are hidden without grow.opportunities.manage, and the name stays text without contact access", async () => {
  const { hooks } = installGlobals(["grow.access", "grow.contacts.read"]);
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: (props: { onViewContact: (partyId: number) => void }) => unknown;
      };
      const tree = (() => {
        hooks.beginRender();
        return GrowOpportunitiesTab({ onViewContact: () => {} });
      })();
      assert.equal(button(tree, "Mark lost"), undefined);
      assert.equal(byId(tree, "grow-opportunity-close-41"), undefined);
      assert.equal(byId(tree, "grow-opportunity-stage-41"), undefined);
      assert.equal(links(tree).some((link) => link.href === "/grow/contacts/12"), true);
    });
  } finally {
    clearGlobals();
  }

  const hidden = installGlobals(["grow.access", "grow.opportunities.manage"]);
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: (props: { onViewContact: (partyId: number) => void }) => unknown;
      };
      const tree = (() => {
        hidden.hooks.beginRender();
        return GrowOpportunitiesTab({ onViewContact: () => {} });
      })();
      assert.match(textContent(tree), /Ada Owner/);
      assert.equal(links(tree).some((link) => link.href.startsWith("/grow/contacts/")), false);
      assert.ok(byId(tree, "grow-opportunity-stage-41"));
    });
  } finally {
    clearGlobals();
  }
});

test("a lost opportunity shows its lost reason in the status cell and keeps its own reason", async () => {
  const { hooks } = installGlobals(MANAGE);
  const pages = (globalThis as { __gp1Pages: { all: { opportunities: unknown[] }; seller_side: { opportunities: unknown[] } } }).__gp1Pages;
  pages.all = {
    opportunities: [
      opportunity({ status: "Lost", stage: "Lost", lostReason: "UAT check", reason: "Seller might list" }),
      opportunity({ id: 42, contactName: "Bea Manager", opportunityType: "PropertyManagement", stage: "New", reason: "Lease review" }),
    ],
    nextCursor: null,
    total: 2,
  };
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: (props: { onViewContact: (partyId: number) => void }) => unknown;
      };
      const tree = (() => {
        hooks.beginRender();
        return GrowOpportunitiesTab({ onViewContact: () => {} });
      })();
      assert.match(textContent(tree), /Lost: UAT check/);
      assert.match(textContent(tree), /Seller might list/);
      assert.match(textContent(tree), /Lease review/);
      assert.doesNotMatch(textContent(tree), /Lost: Lease review/);
      const statusCells = findAll(tree, (element) => element.type === "span" && String(element.props?.className ?? "").includes("pill"));
      assert.equal(textContent(statusCells[0]), "Lost: UAT check");
      assert.equal(textContent(statusCells[1]), "Open");
    });
  } finally {
    clearGlobals();
  }
});

test("Contact 360's opportunity row shows the lost reason beside the opportunity's own reason", async () => {
  const { hooks } = installGlobals(MANAGE);
  try {
    await withVite(async (vite) => {
      const { GrowContactOpportunitiesSection } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowContactOpportunitiesSection: (props: Record<string, unknown>) => unknown;
      };
      const tree = (() => {
        hooks.beginRender();
        return GrowContactOpportunitiesSection({
          partyId: 12,
          opportunities: [
            {
              id: 41,
              opportunityType: "Other",
              status: "Lost",
              stage: "Lost",
              reason: "Seller might list",
              lostReason: "UAT check",
              nextActionDueAt: null,
              recommendedNextAction: null,
              propertyId: null,
            },
          ],
          onChanged: () => {},
        });
      })();
      assert.match(textContent(tree), /Lost: UAT check/);
      assert.match(textContent(tree), /Seller might list/);
    });
  } finally {
    clearGlobals();
  }
});

