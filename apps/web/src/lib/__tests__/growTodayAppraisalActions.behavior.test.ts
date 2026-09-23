import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

// E-2 — Grow Today used to drop Rule E's view_appraisal action. The API
// returned it and the web type named it, but GrowActionCard never rendered
// a control, so an appraisal follow-up had no path to the appraisal. These
// tests render the real GrowToday feed (React and its data hooks replaced
// with the same in-memory fakes the E-3 opportunity tests use) and assert
// what the card now offers.

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
  name: "e2-appraisal-action-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:e2-react") return "\0e2-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:e2-jsx") return "\0e2-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:e2-query") return "\0e2-query";
    if (source === "wouter" || source === "virtual:e2-wouter") return "\0e2-wouter";
    if (source === "../lib/api") return "\0e2-api";
    if (source === "../lib/session") return "\0e2-session";
    if (
      source === "../components/AskAgentEngine" ||
      source === "../components/CommunicationsSection" ||
      source === "../components/PropertyIntelligencePanel" ||
      source === "../components/GrowContactTranscriptPanel" ||
      source === "../components/GrowPendingCommitmentProposals" ||
      source === "../components/ErrorBoundary"
    ) {
      return "\0e2-components";
    }
    return null;
  },
  load(id) {
    if (id === "\0e2-react") {
      return `
        export const useState = (...args) => globalThis.__e2Hooks.useState(...args);
        export const useEffect = (...args) => globalThis.__e2Hooks.useEffect(...args);
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0e2-jsx") {
      return `
        export const Fragment = Symbol.for("e2-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0e2-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries() {} });
        export const useQuery = () => globalThis.__e2Query;
        export const useMutation = () => ({ isPending: false, isError: false, error: null, mutate() {} });
      `;
    }
    if (id === "\0e2-wouter") {
      return `export const Link = (props) => ({ type: "a", props }); export const useSearch = () => "";`;
    }
    if (id === "\0e2-api") {
      return `
        export class ApiError extends Error {}
        export const apiFetch = () => Promise.resolve({});
        export function apiErrorMessage(error, fallback) {
          if (error instanceof ApiError && typeof error.friendly === "string" && error.friendly.trim()) return error.friendly;
          return fallback;
        }
      `;
    }
    if (id === "\0e2-session") {
      return `
        export const useSession = () => ({ user: { id: 1, firstName: "Sam", role: "Agent" } });
        export const useEntitlements = () => ({
          isLoading: false,
          hasEntitlement: (key) => globalThis.__e2Entitlements.includes(key),
        });
      `;
    }
    if (id === "\0e2-components") {
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
        { find: /^react$/, replacement: "virtual:e2-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:e2-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:e2-query" },
        { find: /^wouter$/, replacement: "virtual:e2-wouter" },
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

function appraisalCard(overrides: Record<string, unknown> = {}) {
  return {
    id: "appraisal:9:followup",
    type: "appraisal_follow_up",
    priority: "DoNow",
    partyId: 3,
    contactName: "Ana Appraisal",
    contactEmail: "ana@example.com",
    contactMobile: null,
    relationshipType: null,
    propertyId: 77,
    propertyLabel: "12 Appraisal St",
    opportunityId: 41,
    appraisalId: 9,
    commitmentId: null,
    reason: "Appraisal follow-up was due 1 Sep 2026.",
    recommendedAction: "Follow up on this appraisal.",
    dueAt: "2026-09-01T00:00:00.000Z",
    lastActivityAt: null,
    availableActions: [
      { action: "view_appraisal", appraisalId: 9 },
      { action: "view_property", propertyId: 77 },
      { action: "view_contact", partyId: 3 },
      { action: "ask_ae" },
    ],
    rankScore: 40,
    confidenceBand: null,
    contactability: "contactable",
    contactabilityNote: null,
    whyItMatters: null,
    ...overrides,
  };
}

function todayQuery(card: Record<string, unknown>) {
  return {
    isLoading: false,
    isError: false,
    refetch: () => {},
    data: {
      generatedAt: "2026-09-23T00:00:00.000Z",
      hasAnyGrowData: true,
      counts: { priorityActions: 1, followUpsDue: 1, openOpportunities: 0, contactsNeedingAttention: 0 },
      priorityActions: [card],
      signalSummary: {
        surfaced: 0,
        emergingSurfaced: 0,
        emergingWithheld: 0,
        withheldDoNotContact: 0,
      },
    },
  };
}

function installGlobals(card: Record<string, unknown>, entitlements: string[]) {
  const hooks = createHarness();
  Object.assign(globalThis, {
    __e2Hooks: hooks,
    __e2Entitlements: entitlements,
    __e2Query: todayQuery(card),
  });
  return hooks;
}

function clearGlobals() {
  for (const key of ["__e2Hooks", "__e2Entitlements", "__e2Query"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

test("E-2: an appraisal follow-up card links View appraisal and View property to /properties/{id}", async () => {
  const hooks = installGlobals(appraisalCard(), ["grow.contacts.read"]);
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
      });

      const viewAppraisal = linkByLabel(tree, "View appraisal");
      assert.ok(viewAppraisal, "the card shows View appraisal when view_appraisal is present and propertyId is set");
      assert.equal(viewAppraisal.props?.href, "/properties/77");
      assert.equal(viewAppraisal.props?.className, "btn btn-link btn-small");

      const viewProperty = linkByLabel(tree, "View property");
      assert.ok(viewProperty, "View property appears when the API includes that action");
      assert.equal(viewProperty.props?.href, "/properties/77");
      assert.equal(viewProperty.props?.className, "btn btn-link btn-small");

      assert.deepEqual(
        hrefs(tree).filter((href) => href.startsWith("/properties/")),
        ["/properties/77", "/properties/77"],
      );
      assert.equal(hrefs(tree).some((href) => href.includes("null")), false);
    });
  } finally {
    clearGlobals();
  }
});

test("E-2: View property is omitted when the API does not include it", async () => {
  const hooks = installGlobals(
    appraisalCard({
      availableActions: [
        { action: "view_appraisal", appraisalId: 9 },
        { action: "view_contact", partyId: 3 },
      ],
    }),
    ["grow.contacts.read"],
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
      });

      assert.equal(linkByLabel(tree, "View appraisal")?.props?.href, "/properties/77");
      assert.equal(linkByLabel(tree, "View property"), undefined, "propertyId alone does not invent View property");
      assert.deepEqual(hrefs(tree), ["/properties/77"]);
    });
  } finally {
    clearGlobals();
  }
});

test("E-2: a view_appraisal card with no property does not link to /properties/null", async () => {
  const hooks = installGlobals(
    appraisalCard({
      propertyId: null,
      propertyLabel: null,
      availableActions: [
        { action: "view_appraisal", appraisalId: 9 },
        { action: "view_contact", partyId: 3 },
        { action: "ask_ae" },
      ],
    }),
    ["grow.contacts.read"],
  );
  try {
    await withVite(async (vite) => {
      const { GrowToday } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowToday: (props: Record<string, unknown>) => unknown;
      };
      const viewed: number[] = [];
      const render = () => {
        hooks.beginRender();
        return GrowToday({
          onAskAE: () => {},
          onViewContact: (partyId: number) => viewed.push(partyId),
          onEmailContact: () => {},
          onSmsContact: () => {},
        });
      };

      const tree = render();
      assert.equal(linkByLabel(tree, "View appraisal"), undefined, "no property means no View appraisal link");
      assert.equal(linkByLabel(tree, "View property"), undefined);
      assert.deepEqual(hrefs(tree), [], "no /properties/null and no other property link");
      assert.equal(textContent(tree).includes("/properties/null"), false);

      const viewContact = button(tree, "View contact");
      assert.ok(viewContact, "View contact is the fallback when the card has a person");
      (viewContact.props!.onClick as () => void)();
      assert.deepEqual(viewed, [3]);

      (globalThis as { __e2Entitlements: string[] }).__e2Entitlements = [];
      hooks.reset();
      const withoutContactRead = render();
      assert.equal(button(withoutContactRead, "View contact"), undefined, "without contact read, the dead action stays hidden");
      assert.equal(linkByLabel(withoutContactRead, "View appraisal"), undefined);
      assert.deepEqual(hrefs(withoutContactRead), []);
    });
  } finally {
    clearGlobals();
  }
});
