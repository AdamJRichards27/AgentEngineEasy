// R-F37 — the reconciliation label, and the one read-only line under
// Funds received on the Transaction panel, including when Closed.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { fundsReconciliationLabel, type FundsReconciliationView } from "../fundsReconciliation.ts";

const PROPERTY_ID = 42;
const TRANSACTION_ID = 7;

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

function normalized(node: unknown): string {
  return textContent(node).replace(/\s+/g, " ").trim();
}

function findAll(node: unknown, predicate: (element: ElementNode) => boolean): ElementNode[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate));
  if (!node || typeof node !== "object") return [];
  const element = node as ElementNode;
  const own = predicate(element) ? [element] : [];
  return own.concat(findAll(element.props?.children, predicate));
}

function buttons(tree: unknown, label: string): ElementNode[] {
  return findAll(tree, (element) => element.type === "button" && textContent(element).trim() === label);
}

function transactionSection(tree: unknown): ElementNode {
  const section = findAll(tree, (element) => {
    if (element.type !== "section") return false;
    const heading = findAll(element, (child) => child.type === "h2")[0];
    return textContent(heading).trim() === "Transaction";
  })[0];
  if (!section) throw new Error("missing Transaction section");
  return section;
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

const virtualMocks: Plugin = {
  name: "funds-reconciliation-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:fr-react") return "\0fr-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:fr-jsx") return "\0fr-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:fr-query") return "\0fr-query";
    if (source === "wouter" || source === "virtual:fr-wouter") return "\0fr-wouter";
    if (source.includes("AskAgentEngine")) return "\0fr-stub-ask";
    if (source.includes("PropertyAppraisalSummary")) return "\0fr-stub-appraisal";
    if (source.includes("CommunicationsSection")) return "\0fr-stub-comms";
    if (source.includes("FinancialSummarySection")) return "\0fr-stub-financial";
    if (source.includes("PropertyIntelligencePanel")) return "\0fr-stub-intelligence";
    return null;
  },
  load(id) {
    if (id === "\0fr-react") {
      return `
        export const useState = (...args) => globalThis.__frHooks.useState(...args);
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
        export const useSyncExternalStore = (subscribe, getSnapshot) => getSnapshot();
      `;
    }
    if (id === "\0fr-jsx") {
      return `
        export const Fragment = Symbol.for("fr-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0fr-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries() {} });
        export const useQuery = (options) => {
          const key = JSON.stringify(options.queryKey);
          const table = globalThis.__frQueries || {};
          if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
          return { isLoading: false, isError: false, data: undefined, error: null, refetch() {} };
        };
        export const useMutation = () => ({
          isPending: false,
          isError: false,
          error: null,
          variables: undefined,
          data: undefined,
          mutate() {},
        });
      `;
    }
    if (id === "\0fr-wouter") {
      return `export const Link = (props) => ({ type: "a", props }); export const useLocation = () => ["/", () => {}];`;
    }
    if (id.startsWith("\0fr-stub-")) {
      return `export const AskAgentEngine = () => null;
        export const PropertyAppraisalSummary = () => null;
        export const CommunicationsSection = () => null;
        export const FinancialSummarySection = () => null;
        export const PropertyIntelligencePanel = () => null;`;
    }
    return null;
  },
};

let vite: ViteDevServer;
let Page: (props: { params: { id: string } }) => unknown;

before(async () => {
  vite = await createServer({
    root: new URL("../../..", import.meta.url).pathname,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: true },
    resolve: {
      alias: [
        { find: /^react$/, replacement: "virtual:fr-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:fr-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:fr-query" },
        { find: /^wouter$/, replacement: "virtual:fr-wouter" },
      ],
    },
    plugins: [virtualMocks],
  });
  const mod = (await vite.ssrLoadModule("/src/pages/PropertyWorkspace.tsx")) as {
    default: (props: { params: { id: string } }) => unknown;
  };
  Page = mod.default;
});

after(async () => {
  await vite?.close();
});

function view(overrides: Partial<FundsReconciliationView> = {}): FundsReconciliationView {
  return {
    status: "COMMISSION_NOT_CALCULATED",
    expectedCents: null,
    receivedCents: 0,
    varianceCents: null,
    ...overrides,
  };
}

test("helper labels name each status without adding an action", () => {
  assert.equal(fundsReconciliationLabel(view()), "Commission not calculated yet");
  assert.equal(
    fundsReconciliationLabel(view({ status: "NOT_RECEIVED", expectedCents: 165000, receivedCents: 0, varianceCents: -165000 })),
    "Nothing received yet — $1650.00 expected (incl. GST)",
  );
  assert.equal(
    fundsReconciliationLabel(view({ status: "PARTIAL", expectedCents: 2200000, receivedCents: 2199999, varianceCents: -1 })),
    "Outstanding $0.01 of $22000.00 (incl. GST)",
  );
  assert.equal(
    fundsReconciliationLabel(view({ status: "MATCHED", expectedCents: 165000, receivedCents: 165000, varianceCents: 0 })),
    "Received in full",
  );
  assert.equal(
    fundsReconciliationLabel(view({ status: "OVER_RECEIVED", expectedCents: 165000, receivedCents: 165001, varianceCents: 1 })),
    "Over-received by $0.01 — check with the brokerage's accounts",
  );
});

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: TRANSACTION_ID,
    propertyId: PROPERTY_ID,
    purchasePriceCents: 80000000,
    contractDate: "2026-10-01T00:00:00.000Z",
    financeApprovedAt: null,
    exchangedAt: null,
    unconditionalAt: null,
    settlementDate: "2027-06-01T00:00:00.000Z",
    settlementCompletedAt: null,
    status: "UnderContract",
    grossCommissionCents: 150000,
    gstCents: 15000,
    commissionCalculatedAt: "2026-10-02T00:00:00.000Z",
    fundsReceivedCents: 100000,
    fundsReceivedAt: null,
    agentPaidAt: null,
    closedAt: null,
    legalRepresentatives: null,
    ...overrides,
  };
}

function queriesFor(row: ReturnType<typeof transaction>, reconciliation: FundsReconciliationView | null) {
  const workspace = {
    property: {
      id: PROPERTY_ID,
      formattedAddress: "1 Reconciliation Ave",
      suburb: "Sydney",
      state: "NSW",
      postcode: "2000",
      isManualAddress: false,
      workflowStage: "Settlement",
      amlStatusSummary: "Clear",
      listingStatus: "UnderOffer",
      salesMethod: null,
      priceDisplay: null,
      campaignStartDate: null,
      campaignEndDate: null,
    },
    ownership: { data: null, reviewRequired: false, reviewedBy: null, reviewedAt: null, reviewNotes: null },
    parties: [],
    nextActions: [],
    documentPackage: null,
    agencyAgreementTerms: null,
    appraisal: null,
  };
  const ready = { isLoading: false, isError: false, data: undefined as unknown, error: null, refetch() {} };
  return {
    [`["property-workspace",${PROPERTY_ID}]`]: { ...ready, data: workspace },
    [`["service-orders",${PROPERTY_ID}]`]: { ...ready, data: { serviceOrders: [] } },
    '["payment-methods"]': { ...ready, data: { mine: [], brokerage: [] } },
    [`["offers",${PROPERTY_ID}]`]: { ...ready, data: { offers: [] } },
    [`["transaction",${PROPERTY_ID}]`]: { ...ready, data: { transaction: row, fundsReconciliation: reconciliation } },
    [`["property-timeline",${PROPERTY_ID}]`]: { ...ready, data: { timeline: [] } },
    [`["conditions",${TRANSACTION_ID}]`]: { ...ready, data: { conditions: [] } },
    [`["tasks",${PROPERTY_ID}]`]: { ...ready, data: { tasks: [], attentionItems: [] } },
    [`["property-exceptions",${PROPERTY_ID}]`]: { ...ready, data: { exceptions: [], summary: { openCount: 0, highestSeverity: null } } },
    [`["property-launch",${PROPERTY_ID}]`]: { ...ready, data: { launch: null } },
  };
}

function renderPanel(row: ReturnType<typeof transaction>, reconciliation: FundsReconciliationView | null) {
  const hooks = createHarness();
  Object.assign(globalThis, {
    __frHooks: hooks,
    __frQueries: queriesFor(row, reconciliation),
  });
  hooks.beginRender();
  return transactionSection(Page({ params: { id: String(PROPERTY_ID) } }));
}

test("the Transaction panel shows the reconciliation line under Funds received and offers no control for it", () => {
  const cases: FundsReconciliationView[] = [
    view({ status: "COMMISSION_NOT_CALCULATED", expectedCents: null, receivedCents: 100, varianceCents: null }),
    view({ status: "NOT_RECEIVED", expectedCents: 165000, receivedCents: 0, varianceCents: -165000 }),
    view({ status: "PARTIAL", expectedCents: 165000, receivedCents: 100000, varianceCents: -65000 }),
    view({ status: "MATCHED", expectedCents: 165000, receivedCents: 165000, varianceCents: 0 }),
    view({ status: "OVER_RECEIVED", expectedCents: 165000, receivedCents: 165001, varianceCents: 1 }),
  ];
  for (const reconciliation of cases) {
    const label = fundsReconciliationLabel(reconciliation);
    const section = renderPanel(transaction({ fundsReceivedCents: reconciliation.receivedCents }), reconciliation);
    const text = normalized(section);
    const fundsAt = text.indexOf("Funds received:");
    const lineAt = text.indexOf(label);
    assert.ok(fundsAt >= 0, label);
    assert.ok(lineAt > fundsAt, `${label} sits under Funds received`);
    assert.equal(text.split(label).length - 1, 1, label);
    assert.equal(buttons(section, label).length, 0, label);
  }
});

test("Closed still shows the reconciliation line and still hides Record Funds Received", () => {
  const reconciliation = view({ status: "MATCHED", expectedCents: 165000, receivedCents: 165000, varianceCents: 0 });
  const section = renderPanel(
    transaction({
      status: "Closed",
      closedAt: "2027-07-01T00:00:00.000Z",
      fundsReceivedCents: 165000,
    }),
    reconciliation,
  );
  const text = normalized(section);
  assert.match(text, /Received in full/);
  assert.match(text, /Funds received:/);
  assert.ok(text.indexOf("Received in full") > text.indexOf("Funds received:"));
  assert.equal(buttons(section, "Record Funds Received").length, 0);
  assert.equal(buttons(section, "Received in full").length, 0);
});

test("a missing reconciliation field adds no line", () => {
  const section = renderPanel(transaction(), null);
  const text = normalized(section);
  assert.match(text, /Funds received:/);
  assert.equal(text.includes("Commission not calculated yet"), false);
  assert.equal(text.includes("Received in full"), false);
  assert.equal(text.includes("Nothing received yet"), false);
  assert.equal(text.includes("Outstanding"), false);
  assert.equal(text.includes("Over-received"), false);
});
