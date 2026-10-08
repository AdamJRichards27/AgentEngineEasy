// Appraisal list, workspace, and the property-page deep link.
// React and the data hooks are replaced the same way the Grow appraisal
// tests already do, then the real page modules render.

import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

interface ElementNode {
  type?: unknown;
  props?: Record<string, unknown> & {
    children?: unknown;
    onClick?: () => void;
    onSubmit?: (event: { preventDefault: () => void }) => void;
    onChange?: (event: { target: { value: string } }) => void;
    id?: string;
    value?: string;
    href?: string;
  };
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
  return findAll(tree, (element) => element.type === "button" && textContent(element).trim() === label)[0];
}

function byId(tree: unknown, id: string): ElementNode | undefined {
  return findAll(tree, (element) => element.props?.id === id)[0];
}

class FakeApiError extends Error {
  status: number;
  friendly: string;
  constructor(status: number, friendly: string) {
    super(friendly);
    this.status = status;
    this.friendly = friendly;
  }
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

const mocks: Plugin = {
  name: "appraisal-ui-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:aw-react") return "\0aw-react";
    if (source === "react/jsx-runtime" || source === "react/jsx-dev-runtime" || source === "virtual:aw-jsx") return "\0aw-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:aw-query") return "\0aw-query";
    if (source === "wouter" || source === "virtual:aw-wouter") return "\0aw-wouter";
    if (source === "../lib/api" || source === "../../lib/api") return "\0aw-api";
    if (source === "../lib/session" || source === "../../lib/session") return "\0aw-session";
    return null;
  },
  load(id) {
    if (id === "\0aw-react") {
      return `
        export const useState = (...args) => globalThis.__awHooks.useState(...args);
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0aw-jsx") {
      return `
        export const Fragment = Symbol.for("aw-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0aw-query") {
      return `
        export const useQueryClient = () => ({
          invalidateQueries: (filter) => globalThis.__awInvalidated.push(filter && filter.queryKey),
        });
        export const useQuery = (options) => {
          if (options && options.enabled === false) {
            return { isLoading: false, isError: false, isSuccess: false, data: undefined, error: null };
          }
          const key = options && options.queryKey && options.queryKey[0];
          if (key === "grow-appraisals") return globalThis.__awPipeline;
          if (key === "grow-appraisal-workspace") return globalThis.__awWorkspace;
          if (key === "grow-opportunities") return globalThis.__awOpportunities;
          if (key === "property-timeline") return globalThis.__awTimeline;
          return { isLoading: false, isError: false, isSuccess: false, data: undefined, error: null };
        };
        export const useMutation = (options) => ({
          isPending: false,
          isError: false,
          error: null,
          mutate(input) {
            globalThis.__awPending.push(
              Promise.resolve()
                .then(() => options.mutationFn(input))
                .then(
                  (result) => { options.onSuccess?.(result, input); },
                  (failure) => { options.onError?.(failure, input); },
                ),
            );
          },
        });
      `;
    }
    if (id === "\0aw-wouter") {
      return `
        export const Link = (props) => ({ type: "a", props });
        export const useParams = () => globalThis.__awParams;
        export const useSearch = () => "";
      `;
    }
    if (id === "\0aw-api") {
      return `
        export const ApiError = globalThis.__awApiError;
        export const apiFetch = (path, options) => globalThis.__awApiFetch(path, options);
        export function apiErrorMessage(error, fallback) {
          if (error instanceof ApiError && typeof error.friendly === "string" && error.friendly.trim()) return error.friendly;
          return fallback;
        }
      `;
    }
    if (id === "\0aw-session") {
      return `
        export const useSession = () => ({ user: globalThis.__awUser });
        export const useEntitlements = () => ({
          isLoading: false,
          hasEntitlement: (key) => globalThis.__awEntitlements.includes(key),
        });
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
        { find: /^react$/, replacement: "virtual:aw-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:aw-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:aw-query" },
        { find: /^wouter$/, replacement: "virtual:aw-wouter" },
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

const MANAGE = ["grow.access", "grow.opportunities.manage", "run.access"];

function queryResult(data: unknown, overrides: Record<string, unknown> = {}) {
  return { isLoading: false, isError: false, isSuccess: true, data, error: null, ...overrides };
}

function listRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 8,
    status: "DRAFT",
    outcome: null,
    propertyId: 77,
    propertyAddress: "77 Appraisal St",
    partyId: 12,
    partyDisplayName: "Lou Smith",
    ownerUserId: 4,
    ownerName: "Sam Agent",
    updatedAt: "2026-10-06T00:00:00.000Z",
    isFinalised: false,
    ...overrides,
  };
}

const PIPELINE = [
  listRow(),
  listRow({
    id: 9,
    status: "WON",
    outcome: "WON",
    propertyAddress: "9 Won St",
    partyDisplayName: "Mo Jones",
    ownerUserId: 5,
    ownerName: "Alex Admin",
  }),
  listRow({ id: 10, status: "LOST", outcome: "LOST", propertyAddress: "10 Lost St", partyDisplayName: "Pat Lost" }),
  listRow({ id: 11, status: "DEFERRED", outcome: "DEFERRED", propertyAddress: "11 Later St", partyDisplayName: "Dee Later" }),
  listRow({ id: 12, status: "ARCHIVED", outcome: null, propertyAddress: "12 Old St", partyDisplayName: "Arch Old" }),
  listRow({ id: 13, status: "DRAFT", isFinalised: true, propertyAddress: "13 Final St", partyDisplayName: "Fin Al" }),
];

function appraisalRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 8,
    propertyId: 77,
    partyId: 12,
    opportunityId: 41,
    ownerUserId: 4,
    status: "DRAFT",
    outcome: null,
    outcomeReason: null,
    outcomeNotes: null,
    priceRangeLow: "700000.00",
    priceRangeHigh: "750000.00",
    pricingCommentary: "Quiet street",
    marketPositionNarrative: null,
    sellingStrategy: "Auction",
    marketingProposal: null,
    commissionRatePercent: null,
    commissionProposal: null,
    recommendedNextSteps: "Call tomorrow",
    appointmentAt: null,
    presentationAt: null,
    sentAt: null,
    viewedAt: null,
    followUpAt: null,
    followUpNotes: null,
    outcomeAt: null,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T01:00:00.000Z",
    isFinalised: false,
    finalisedSnapshot: null,
    presentationDocumentId: null,
    ...overrides,
  };
}

type Call = { path: string; options?: { method?: string; body?: string } };

function install(input: {
  role?: string;
  entitlements?: string[];
  params?: { id?: string };
  workspace?: unknown;
  workspaceError?: unknown;
}) {
  const hooks = createHarness();
  const calls: Call[] = [];
  const invalidated: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  Object.assign(globalThis, {
    __awHooks: hooks,
    __awApiError: FakeApiError,
    __awUser: { id: 4, firstName: "Sam", role: input.role ?? "Agent" },
    __awEntitlements: input.entitlements ?? MANAGE,
    __awParams: input.params ?? { id: "8" },
    __awInvalidated: invalidated,
    __awPending: pending,
    __awPipeline: queryResult({ appraisals: PIPELINE }),
    __awWorkspace: input.workspaceError
      ? { isLoading: false, isError: true, isSuccess: false, data: undefined, error: input.workspaceError }
      : queryResult(
          input.workspace ?? {
            appraisal: appraisalRecord(),
            comparableSales: [{ id: 3, address: "1 Comparable St", salePrice: "680000.00", notes: "Similar" }],
            marketCompetition: [],
          },
        ),
    __awOpportunities: queryResult({
      opportunities: [{ id: 41, opportunityType: "Appraisal", stage: "Qualified", reason: "Enquired" }],
    }),
    __awTimeline: queryResult({
      timeline: [
        { occurredAt: "2026-10-06T02:00:00.000Z", label: "Appraisal created", category: "Appraisal" },
        { occurredAt: "2026-10-06T05:00:00.000Z", label: "Offer received", category: "Offer" },
      ],
    }),
    __awApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, options });
      return Promise.resolve({});
    },
  });
  return { hooks, calls, invalidated, pending };
}

function clearGlobals() {
  for (const key of [
    "__awHooks",
    "__awApiError",
    "__awUser",
    "__awEntitlements",
    "__awParams",
    "__awInvalidated",
    "__awPending",
    "__awPipeline",
    "__awWorkspace",
    "__awOpportunities",
    "__awTimeline",
    "__awApiFetch",
  ]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

test("the appraisal list filters by stage, search, and owner without widening an agent's view", async () => {
  const agent = install({ role: "Agent" });
  try {
    await withVite(async (vite) => {
      const { default: GrowAppraisals } = (await vite.ssrLoadModule("/src/pages/GrowAppraisals.tsx")) as {
        default: () => unknown;
      };
      const render = () => {
        agent.hooks.beginRender();
        return GrowAppraisals();
      };
      let tree = render();
      const openText = textContent(tree);
      assert.match(openText, /77 Appraisal St/);
      assert.match(openText, /Lou Smith/);
      assert.doesNotMatch(openText, /9 Won St/);
      assert.doesNotMatch(openText, /13 Final St/);
      assert.equal(byId(tree, "appraisal-owner-filter"), undefined);
      assert.equal(byId(tree, "appraisal-stage-filter")?.props?.value, "open");

      (byId(tree, "appraisal-stage-filter")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "won" },
      });
      tree = render();
      assert.match(textContent(tree), /9 Won St/);
      assert.doesNotMatch(textContent(tree), /77 Appraisal St/);

      (byId(tree, "appraisal-stage-filter")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "lost" },
      });
      tree = render();
      assert.match(textContent(tree), /10 Lost St/);

      (byId(tree, "appraisal-stage-filter")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "deferred" },
      });
      tree = render();
      assert.match(textContent(tree), /11 Later St/);

      (byId(tree, "appraisal-stage-filter")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "archived" },
      });
      tree = render();
      assert.match(textContent(tree), /12 Old St/);

      (byId(tree, "appraisal-stage-filter")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "finalised" },
      });
      tree = render();
      assert.match(textContent(tree), /13 Final St/);
      assert.match(textContent(tree), /Finalised/);

      (byId(tree, "appraisal-stage-filter")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "all" },
      });
      (byId(tree, "appraisal-search")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "mo jones" },
      });
      tree = render();
      assert.match(textContent(tree), /9 Won St/);
      assert.doesNotMatch(textContent(tree), /77 Appraisal St/);
      assert.equal(
        findAll(tree, (element) => element.type === "a" && element.props?.href === "/grow/appraisals/9").length > 0,
        true,
      );
    });
  } finally {
    clearGlobals();
  }

  const admin = install({ role: "Brokerage Administrator" });
  try {
    await withVite(async (vite) => {
      const { default: GrowAppraisals } = (await vite.ssrLoadModule("/src/pages/GrowAppraisals.tsx")) as {
        default: () => unknown;
      };
      const render = () => {
        admin.hooks.beginRender();
        return GrowAppraisals();
      };
      let tree = render();
      assert.ok(byId(tree, "appraisal-owner-filter"));
      (byId(tree, "appraisal-stage-filter")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "all" },
      });
      (byId(tree, "appraisal-owner-filter")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "5" },
      });
      tree = render();
      assert.match(textContent(tree), /9 Won St/);
      assert.match(textContent(tree), /Alex Admin/);
      assert.doesNotMatch(textContent(tree), /77 Appraisal St/);
    });
  } finally {
    clearGlobals();
  }
});

test("the workspace shows the record, posts the next step and outcome, and locks terminal and finalised appraisals", async () => {
  const open = install({});
  try {
    await withVite(async (vite) => {
      const { default: AppraisalWorkspace } = (await vite.ssrLoadModule("/src/pages/AppraisalWorkspace.tsx")) as {
        default: () => unknown;
      };
      const render = () => {
        open.hooks.beginRender();
        return AppraisalWorkspace();
      };
      let tree = render();
      const text = textContent(tree);
      assert.match(text, /77 Appraisal St/);
      assert.match(text, /Lou Smith/);
      assert.match(text, /Enquired/);
      assert.match(text, /Status: Draft/);
      assert.match(text, /Outcome: Not recorded/);
      assert.match(text, /Next step: Appointment scheduled/);
      assert.match(text, /Appraisal started/);
      assert.match(text, /Appraisal created/);
      assert.match(text, /6 Oct 2026/);
      assert.doesNotMatch(text, /Offer received/);
      assert.equal(byId(tree, "appraisal-readonly"), undefined);
      assert.equal(byId(tree, "appraisal-pricing-locked"), undefined);
      assert.ok(byId(tree, "appraisal-price-low"));
      assert.ok(button(tree, "Appointment scheduled"));
      assert.equal(button(tree, "Record outcome"), undefined);

      (byId(tree, "appraisal-status-APPOINTMENT_SCHEDULED")!.props!.onClick as () => void)();
      await Promise.all(open.pending);
      assert.equal(open.calls[0].path, "/grow/appraisals/8/status");
      assert.equal(open.calls[0].options?.method, "POST");
      assert.deepEqual(JSON.parse(open.calls[0].options!.body!), { toStatus: "APPOINTMENT_SCHEDULED" });
      assert.ok(open.invalidated.some((key) => Array.isArray(key) && key[0] === "grow-appraisal-workspace"));
    });
  } finally {
    clearGlobals();
  }

  const presented = install({
    workspace: {
      appraisal: appraisalRecord({ status: "PRESENTED" }),
      comparableSales: [],
      marketCompetition: [],
    },
  });
  try {
    await withVite(async (vite) => {
      const { default: AppraisalWorkspace } = (await vite.ssrLoadModule("/src/pages/AppraisalWorkspace.tsx")) as {
        default: () => unknown;
      };
      const render = () => {
        presented.hooks.beginRender();
        return AppraisalWorkspace();
      };
      let tree = render();
      (button(tree, "Record outcome")!.props!.onClick as () => void)();
      tree = render();
      (byId(tree, "appraisal-outcome")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "LOST" },
      });
      tree = render();
      (byId(tree, "appraisal-outcome-reason")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "relationship" },
      });
      tree = render();
      (byId(tree, "appraisal-outcome-notes")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "Went elsewhere" },
      });
      tree = render();
      const form = byId(tree, "appraisal-outcome-form");
      (form!.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
      await Promise.all(presented.pending);
      assert.equal(presented.calls[0].path, "/grow/appraisals/8/outcome");
      assert.deepEqual(JSON.parse(presented.calls[0].options!.body!), {
        outcome: "LOST",
        outcomeReason: "relationship",
        outcomeNotes: "Went elsewhere",
      });
    });
  } finally {
    clearGlobals();
  }

  for (const item of [
    { status: "WON", outcome: "WON", isFinalised: false, message: /finished and cannot be changed/ },
    { status: "LOST", outcome: "LOST", isFinalised: false, message: /finished and cannot be changed/ },
    { status: "DEFERRED", outcome: "DEFERRED", isFinalised: false, message: /finished and cannot be changed/ },
    { status: "ARCHIVED", outcome: null, isFinalised: false, message: /finished and cannot be changed/ },
  ]) {
    const closed = install({
      workspace: {
        appraisal: appraisalRecord({ status: item.status, outcome: item.outcome, isFinalised: item.isFinalised }),
        comparableSales: [],
        marketCompetition: [],
      },
    });
    try {
      await withVite(async (vite) => {
        const { default: AppraisalWorkspace } = (await vite.ssrLoadModule("/src/pages/AppraisalWorkspace.tsx")) as {
          default: () => unknown;
        };
        closed.hooks.beginRender();
        const tree = AppraisalWorkspace();
        assert.match(textContent(tree), item.message, item.status);
        assert.equal(button(tree, "Appointment scheduled"), undefined, item.status);
        assert.equal(button(tree, "Record outcome"), undefined, item.status);
        assert.equal(button(tree, "Save details"), undefined, item.status);
        assert.equal(button(tree, "Finalise appraisal"), undefined, item.status);
        assert.equal(button(tree, "Send appraisal"), undefined, item.status);
        assert.equal(byId(tree, "appraisal-price-low"), undefined, item.status);
      });
    } finally {
      clearGlobals();
    }
  }
});

test("a finalised follow-up locks pricing and keeps outcome, follow-up, and send available", async () => {
  const finalised = install({
    workspace: {
      appraisal: appraisalRecord({
        status: "FOLLOW_UP",
        isFinalised: true,
        finalisedSnapshot: { priceRangeLow: "700000.00", priceRangeHigh: "750000.00", finalisedAt: "2026-10-06T02:00:00.000Z" },
      }),
      comparableSales: [{ id: 3, address: "1 Comp St", salePrice: "690000.00", saleDate: null, bedrooms: null, bathrooms: null, carSpaces: null, notes: null }],
      marketCompetition: [{ id: 4, address: "2 Rival St", askingPriceDisplay: "$710,000", status: "Active", daysOnMarket: 12, notes: null }],
    },
  });
  try {
    await withVite(async (vite) => {
      const { default: AppraisalWorkspace } = (await vite.ssrLoadModule("/src/pages/AppraisalWorkspace.tsx")) as {
        default: () => unknown;
      };
      const render = () => {
        finalised.hooks.beginRender();
        return AppraisalWorkspace();
      };
      let tree = render();
      const text = textContent(tree);
      assert.match(text, /Pricing is finalised and cannot be changed/);
      assert.equal(byId(tree, "appraisal-readonly"), undefined);
      assert.ok(byId(tree, "appraisal-pricing-locked"));
      assert.equal(byId(tree, "appraisal-price-low"), undefined);
      assert.equal(byId(tree, "appraisal-price-high"), undefined);
      assert.equal(byId(tree, "appraisal-pricing-commentary"), undefined);
      assert.equal(byId(tree, "appraisal-commission-rate"), undefined);
      assert.equal(byId(tree, "appraisal-comparable-address"), undefined);
      assert.equal(byId(tree, "appraisal-competition-address"), undefined);
      assert.equal(byId(tree, "appraisal-comparable-remove-3"), undefined);
      assert.equal(button(tree, "Finalise appraisal"), undefined);
      assert.ok(button(tree, "Record outcome"));
      assert.ok(byId(tree, "appraisal-follow-up-form"));
      assert.ok(button(tree, "Send appraisal"));
      assert.ok(byId(tree, "appraisal-selling-strategy"));
      assert.ok(button(tree, "Save details"));

      (byId(tree, "appraisal-selling-strategy")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "Private treaty" },
      });
      tree = render();
      (button(tree, "Save details")!.props!.onClick as () => void)();
      await Promise.all(finalised.pending);
      assert.equal(finalised.calls[0].path, "/grow/appraisals/8");
      assert.equal(finalised.calls[0].options?.method, "PATCH");
      const body = JSON.parse(finalised.calls[0].options!.body!) as Record<string, unknown>;
      assert.equal(body.sellingStrategy, "Private treaty");
      assert.equal("priceRangeLow" in body, false);
      assert.equal("priceRangeHigh" in body, false);
      assert.equal("pricingCommentary" in body, false);
      assert.equal("commissionRatePercent" in body, false);
      assert.equal("commissionProposal" in body, false);
    });
  } finally {
    clearGlobals();
  }
});

test("a won appraisal can be handed to Run, and a missing appraisal stays not found", async () => {
  const won = install({
    workspace: {
      appraisal: appraisalRecord({ status: "WON", outcome: "WON" }),
      comparableSales: [],
      marketCompetition: [],
    },
  });
  try {
    await withVite(async (vite) => {
      const { default: AppraisalWorkspace } = (await vite.ssrLoadModule("/src/pages/AppraisalWorkspace.tsx")) as {
        default: () => unknown;
      };
      won.hooks.beginRender();
      const tree = AppraisalWorkspace();
      assert.match(textContent(tree), /finished and cannot be changed/);
      (button(tree, "Hand off to Run")!.props!.onClick as () => void)();
      await Promise.all(won.pending);
      assert.equal(won.calls[0].path, "/grow/appraisals/8/run-handoff");
      assert.equal(won.calls[0].options?.method, "POST");
    });
  } finally {
    clearGlobals();
  }

  const noRun = install({
    entitlements: ["grow.access", "grow.opportunities.manage"],
    workspace: {
      appraisal: appraisalRecord({ status: "WON", outcome: "WON" }),
      comparableSales: [],
      marketCompetition: [],
    },
  });
  try {
    await withVite(async (vite) => {
      const { default: AppraisalWorkspace } = (await vite.ssrLoadModule("/src/pages/AppraisalWorkspace.tsx")) as {
        default: () => unknown;
      };
      noRun.hooks.beginRender();
      const tree = AppraisalWorkspace();
      assert.equal(button(tree, "Hand off to Run"), undefined);
    });
  } finally {
    clearGlobals();
  }

  const missing = install({
    params: { id: "nope" },
  });
  try {
    await withVite(async (vite) => {
      const { default: AppraisalWorkspace } = (await vite.ssrLoadModule("/src/pages/AppraisalWorkspace.tsx")) as {
        default: () => unknown;
      };
      missing.hooks.beginRender();
      const tree = AppraisalWorkspace();
      assert.match(textContent(tree), /couldn't be found/);
      assert.equal(missing.calls.length, 0);
    });
  } finally {
    clearGlobals();
  }
});

const OLD_MOCK_NARRATIVE =
  "Mock AI Provider. No real model call was made. Set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY in Replit Secrets.";

function renderedStrings(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(renderedStrings).join("\n");
  const props = (node as ElementNode).props ?? {};
  return Object.values(props)
    .map((value) => (typeof value === "string" || typeof value === "number" ? String(value) : renderedStrings(value)))
    .join("\n");
}

test("a successful listing hand-off names Run and the property, and a failure stays inline", async () => {
  const won = install({
    workspace: {
      appraisal: appraisalRecord({ status: "WON", outcome: "WON" }),
      comparableSales: [],
      marketCompetition: [],
    },
  });
  try {
    await withVite(async (vite) => {
      const { default: AppraisalWorkspace } = (await vite.ssrLoadModule("/src/pages/AppraisalWorkspace.tsx")) as {
        default: () => unknown;
      };
      (globalThis as { __awApiFetch: (path: string, options?: { method?: string }) => Promise<unknown> }).__awApiFetch = () =>
        Promise.resolve({ propertyId: 77, sellerLinkCreated: true });
      const render = () => {
        won.hooks.beginRender();
        return AppraisalWorkspace();
      };
      let tree = render();
      (button(tree, "Hand off to Run")!.props!.onClick as () => void)();
      await Promise.all(won.pending);
      tree = render();
      const confirmation = byId(tree, "appraisal-run-handoff-confirmation");
      assert.equal(confirmation?.props?.role, "status");
      assert.match(textContent(confirmation), /Handed this appraisal to Run for 77 Appraisal St/);
      assert.match(textContent(confirmation), /recorded as the seller/);
      assert.equal(
        findAll(confirmation, (element) => element.type === "a")[0]?.props?.href,
        "/properties/77",
      );
      assert.equal(byId(tree, "appraisal-run-handoff-error"), undefined);
      assert.ok(button(tree, "Hand off to Run"), "the workspace stays on the page");
    });
  } finally {
    clearGlobals();
  }

  const failed = install({
    workspace: {
      appraisal: appraisalRecord({ status: "WON", outcome: "WON" }),
      comparableSales: [],
      marketCompetition: [],
    },
  });
  try {
    await withVite(async (vite) => {
      const { default: AppraisalWorkspace } = (await vite.ssrLoadModule("/src/pages/AppraisalWorkspace.tsx")) as {
        default: () => unknown;
      };
      (globalThis as { __awApiFetch: () => Promise<unknown> }).__awApiFetch = () =>
        Promise.reject(new FakeApiError(400, "Only a won appraisal can be handed to Run."));
      const render = () => {
        failed.hooks.beginRender();
        return AppraisalWorkspace();
      };
      let tree = render();
      (button(tree, "Hand off to Run")!.props!.onClick as () => void)();
      await Promise.all(failed.pending);
      tree = render();
      const error = byId(tree, "appraisal-run-handoff-error");
      assert.equal(error?.props?.role, "alert");
      assert.match(textContent(error), /Only a won appraisal can be handed to Run/);
      assert.equal(byId(tree, "appraisal-run-handoff-confirmation"), undefined);
    });
  } finally {
    clearGlobals();
  }
});

test("a saved or drafted mock narrative is labelled for the reader and drops the operator instruction", async () => {
  const saved = install({
    workspace: {
      appraisal: appraisalRecord({ marketPositionNarrative: OLD_MOCK_NARRATIVE }),
      comparableSales: [],
      marketCompetition: [],
    },
  });
  try {
    await withVite(async (vite) => {
      const { default: AppraisalWorkspace } = (await vite.ssrLoadModule("/src/pages/AppraisalWorkspace.tsx")) as {
        default: () => unknown;
      };
      const render = () => {
        saved.hooks.beginRender();
        return AppraisalWorkspace();
      };
      let tree = render();
      assert.equal(textContent(byId(tree, "appraisal-demo-ai")), "Demo AI: sample text, not generated from your data.");
      assert.equal(byId(tree, "appraisal-market-position")?.props?.value, "Demo AI: sample text, not generated from your data.");
      assert.doesNotMatch(renderedStrings(tree), /AI_PROVIDER/);

      (globalThis as { __awApiFetch: () => Promise<unknown> }).__awApiFetch = () =>
        Promise.resolve({ draftNarrative: `Kept observation about the street.\n\n${OLD_MOCK_NARRATIVE}` });
      (byId(tree, "appraisal-market-position-generate")!.props!.onClick as () => void)();
      await Promise.all(saved.pending);
      tree = render();
      const visible = String(byId(tree, "appraisal-market-position")?.props?.value);
      assert.match(visible, /Demo AI: sample text, not generated from your data/);
      assert.match(visible, /Kept observation about the street/);
      assert.doesNotMatch(visible, /AI_PROVIDER/);
      assert.doesNotMatch(renderedStrings(tree), /AI_PROVIDER/);
    });
  } finally {
    clearGlobals();
  }
});

test("the property page links an existing appraisal to the workspace and still starts one when there is none", async () => {
  install({});
  try {
    await withVite(async (vite) => {
      const { PropertyAppraisalSummary } = (await vite.ssrLoadModule("/src/components/PropertyAppraisalSummary.tsx")) as {
        PropertyAppraisalSummary: (props: {
          appraisal: { id: number; priceRangeLow: string | null; priceRangeHigh: string | null; isFinalised: boolean } | null;
          onStart: () => void;
          startError: string | null;
        }) => unknown;
      };
      const started: number[] = [];
      const linked = PropertyAppraisalSummary({
        appraisal: { id: 8, priceRangeLow: "700000.00", priceRangeHigh: "750000.00", isFinalised: false },
        onStart: () => started.push(1),
        startError: null,
      });
      assert.equal(byId(linked, "property-open-appraisal")?.props?.href, "/grow/appraisals/8");
      assert.match(textContent(linked), /In progress/);
      assert.match(textContent(linked), /\$700,000/);
      assert.equal(button(linked, "Start Appraisal"), undefined);
      assert.equal(button(linked, "Finalise Appraisal"), undefined);
      assert.equal(button(linked, "Save"), undefined);

      const empty = PropertyAppraisalSummary({
        appraisal: null,
        onStart: () => started.push(1),
        startError: null,
      });
      assert.equal(byId(empty, "property-open-appraisal"), undefined);
      (button(empty, "Start Appraisal")!.props!.onClick as () => void)();
      assert.deepEqual(started, [1]);
    });
  } finally {
    clearGlobals();
  }
});
