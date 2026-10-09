// R-F32 — the property Transaction panel only offers actions R-F30 would
// accept. React and the data hooks are replaced the same way the other
// web behaviour tests do, then the real PropertyWorkspace page renders.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

const CLOSED_NOTE = "This transaction is closed — no further changes can be recorded.";
const PROPERTY_ID = 42;
const TRANSACTION_ID = 7;

interface ElementNode {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void };
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

function click(element: ElementNode | undefined): void {
  const onClick = element?.props?.onClick;
  if (typeof onClick !== "function") throw new Error(`missing click handler for ${textContent(element)}`);
  onClick();
}

function change(element: ElementNode | undefined, value: string): void {
  const onChange = element?.props?.onChange;
  if (typeof onChange !== "function") throw new Error("missing change handler");
  onChange({ target: { value } });
}

function scheduleDateInput(section: ElementNode): ElementNode {
  const hosts = findAll(section, (element) => {
    const schedule = findAll(element, (child) => child.type === "button" && textContent(child).trim() === "Schedule Settlement");
    const dates = findAll(element, (child) => child.type === "input" && child.props?.type === "date");
    return schedule.length === 1 && dates.length === 1;
  });
  const host = hosts.sort((a, b) => textContent(a).length - textContent(b).length)[0];
  const input = host && findAll(host, (element) => element.type === "input" && element.props?.type === "date")[0];
  if (!input) throw new Error("missing settlement date input");
  return input;
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
  name: "transaction-panel-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:tx-react") return "\0tx-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:tx-jsx") return "\0tx-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:tx-query") return "\0tx-query";
    if (source === "wouter" || source === "virtual:tx-wouter") return "\0tx-wouter";
    if (source.includes("AskAgentEngine")) return "\0tx-stub-ask";
    if (source.includes("PropertyAppraisalSummary")) return "\0tx-stub-appraisal";
    if (source.includes("CommunicationsSection")) return "\0tx-stub-comms";
    if (source.includes("FinancialSummarySection")) return "\0tx-stub-financial";
    if (source.includes("PropertyIntelligencePanel")) return "\0tx-stub-intelligence";
    return null;
  },
  load(id) {
    if (id === "\0tx-react") {
      return `
        export const useState = (...args) => globalThis.__txHooks.useState(...args);
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
        export const useSyncExternalStore = (subscribe, getSnapshot) => getSnapshot();
      `;
    }
    if (id === "\0tx-jsx") {
      return `
        export const Fragment = Symbol.for("tx-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0tx-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries() {} });
        export const useQuery = (options) => {
          const key = JSON.stringify(options.queryKey);
          const table = globalThis.__txQueries || {};
          if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
          return { isLoading: false, isError: false, data: undefined, error: null, refetch() {} };
        };
        export const useMutation = (options) => {
          const fn = String(options && options.mutationFn);
          const isTransactionAction = fn.includes("transactionId") && fn.includes("action");
          const shown = globalThis.__txShownError;
          const active = Boolean(shown) && isTransactionAction;
          return {
            isPending: false,
            isError: active,
            error: active ? shown : null,
            variables: active ? globalThis.__txShownVariables : undefined,
            data: undefined,
            mutate(input) {
              globalThis.__txCalls.push(input);
              if (input && typeof input.action === "string" && globalThis.__txScriptedError) {
                globalThis.__txShownError = globalThis.__txScriptedError;
                globalThis.__txShownVariables = input;
              }
            },
          };
        };
      `;
    }
    if (id === "\0tx-wouter") {
      return `export const Link = (props) => ({ type: "a", props }); export const useLocation = () => ["/", () => {}];`;
    }
    if (id.startsWith("\0tx-stub-")) {
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
let ApiError: new (status: number, friendly: string) => Error & { friendly: string };

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
        { find: /^react$/, replacement: "virtual:tx-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:tx-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:tx-query" },
        { find: /^wouter$/, replacement: "virtual:tx-wouter" },
      ],
    },
    plugins: [virtualMocks],
  });
  const mod = (await vite.ssrLoadModule("/src/pages/PropertyWorkspace.tsx")) as {
    default: (props: { params: { id: string } }) => unknown;
  };
  Page = mod.default;
  const api = (await vite.ssrLoadModule("/src/lib/api.ts")) as {
    ApiError: new (status: number, friendly: string) => Error & { friendly: string };
  };
  ApiError = api.ApiError;
});

after(async () => {
  await vite?.close();
});

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: TRANSACTION_ID,
    propertyId: PROPERTY_ID,
    purchasePriceCents: 80000000,
    contractDate: null,
    financeApprovedAt: null,
    exchangedAt: null,
    unconditionalAt: null,
    settlementDate: "2027-06-01T00:00:00.000Z",
    settlementCompletedAt: null,
    status: "ContractPreparation",
    grossCommissionCents: null,
    gstCents: null,
    commissionCalculatedAt: null,
    fundsReceivedCents: 150000,
    fundsReceivedAt: null,
    agentPaidAt: null,
    closedAt: null,
    legalRepresentatives: { sellerSolicitorPartyId: 9, buyerSolicitorPartyId: null },
    ...overrides,
  };
}

function queriesFor(row: ReturnType<typeof transaction>) {
  const workspace = {
    property: {
      id: PROPERTY_ID,
      formattedAddress: "1 Lifecycle Guard Ave",
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
    parties: [
      {
        linkId: 1,
        role: "Solicitor",
        isPrimary: false,
        partyId: 9,
        party: { firstName: "Ada", lastName: "Solicitor" },
        amlStatus: "Complete",
        amlVerificationId: null,
        amlException: null,
      },
    ],
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
    [`["transaction",${PROPERTY_ID}]`]: { ...ready, data: { transaction: row } },
    [`["property-timeline",${PROPERTY_ID}]`]: { ...ready, data: { timeline: [] } },
    [`["conditions",${TRANSACTION_ID}]`]: {
      ...ready,
      data: {
        conditions: [
          {
            id: 3,
            transactionId: TRANSACTION_ID,
            description: "Subject to building inspection",
            dueDate: "2027-05-01T00:00:00.000Z",
            status: "Pending",
            notes: null,
            resolvedAt: null,
          },
        ],
      },
    },
    [`["tasks",${PROPERTY_ID}]`]: { ...ready, data: { tasks: [], attentionItems: [] } },
    [`["property-exceptions",${PROPERTY_ID}]`]: { ...ready, data: { exceptions: [], summary: { openCount: 0, highestSeverity: null } } },
    [`["property-launch",${PROPERTY_ID}]`]: { ...ready, data: { launch: null } },
  };
}

function install(row: ReturnType<typeof transaction>) {
  const hooks = createHarness();
  Object.assign(globalThis, {
    __txHooks: hooks,
    __txQueries: queriesFor(row),
    __txCalls: [] as unknown[],
    __txShownError: null,
    __txShownVariables: undefined,
    __txScriptedError: null,
  });
  const render = () => {
    hooks.beginRender();
    return Page({ params: { id: String(PROPERTY_ID) } });
  };
  return { render };
}

function assertPanel(section: ElementNode, counts: Record<string, number>) {
  for (const [label, count] of Object.entries(counts)) {
    assert.equal(buttons(section, label).length, count, `${label} in the Transaction panel`);
  }
}

const OPEN_WRITERS = {
  "Mark Finance Approved": 1,
  "Mark Contracts Exchanged": 1,
  "Mark Unconditional": 1,
  "Calculate Commission": 1,
  "Record Funds Received": 1,
  "Mark Agent Paid": 1,
  Reschedule: 1,
  "+ Add Condition": 1,
  Save: 1,
};

test("ContractPreparation hides settlement actions until the contract is signed", () => {
  const { render } = install(transaction({ status: "ContractPreparation", contractDate: null }));
  const tree = render();
  const section = transactionSection(tree);
  assertPanel(section, {
    ...OPEN_WRITERS,
    "Mark Contract Signed": 1,
    "Schedule Settlement": 0,
    "Mark Settlement Completed": 0,
    "Close Transaction": 1,
  });
  assert.equal(buttons(section, "Close Transaction")[0]?.props?.disabled, true);
  assert.equal(buttons(tree, "Mark Contract Signed").length, 2);
  assert.equal(normalized(section).includes(CLOSED_NOTE), false);
  assert.equal(findAll(section, (element) => element.type === "select" && textContent(element).includes("Resolve as")).length, 1);
});

test("UnderContract offers schedule and complete once the contract date is set", () => {
  const { render } = install(
    transaction({
      status: "UnderContract",
      contractDate: "2026-10-01T00:00:00.000Z",
    }),
  );
  const tree = render();
  const section = transactionSection(tree);
  assertPanel(section, {
    ...OPEN_WRITERS,
    "Mark Contract Signed": 0,
    "Schedule Settlement": 1,
    "Mark Settlement Completed": 1,
    "Close Transaction": 1,
  });
  assert.equal(buttons(tree, "Mark Contract Signed").length, 0);
  assert.equal(buttons(tree, "Mark Finance Approved").length, 2);
  assert.equal(normalized(section).includes(CLOSED_NOTE), false);
});

test("SettlementScheduled keeps schedule and complete and still hides contract signed", () => {
  const { render } = install(
    transaction({
      status: "SettlementScheduled",
      contractDate: "2026-10-01T00:00:00.000Z",
    }),
  );
  const tree = render();
  const section = transactionSection(tree);
  assertPanel(section, {
    ...OPEN_WRITERS,
    "Mark Contract Signed": 0,
    "Schedule Settlement": 1,
    "Mark Settlement Completed": 1,
    "Close Transaction": 1,
  });
  assert.equal(buttons(tree, "Mark Contract Signed").length, 0);
  assert.match(normalized(section), /SettlementScheduled/);
});

test("Settled hides contract signed when the date is missing and hides settlement reschedule", () => {
  const { render } = install(
    transaction({
      status: "Settled",
      contractDate: null,
      settlementCompletedAt: "2027-06-02T00:00:00.000Z",
    }),
  );
  const tree = render();
  const section = transactionSection(tree);
  assertPanel(section, {
    ...OPEN_WRITERS,
    "Mark Contract Signed": 0,
    "Schedule Settlement": 0,
    "Mark Settlement Completed": 0,
    "Close Transaction": 1,
  });
  assert.equal(buttons(section, "Close Transaction")[0]?.props?.disabled, false);
  assert.equal(buttons(tree, "Mark Contract Signed").length, 0);
  assert.equal(normalized(section).includes(CLOSED_NOTE), false);

  const stillOpen = install(
    transaction({
      status: "Settled",
      contractDate: "2026-10-01T00:00:00.000Z",
      settlementDate: "2027-06-01T00:00:00.000Z",
      settlementCompletedAt: null,
    }),
  );
  const openTree = stillOpen.render();
  const openSection = transactionSection(openTree);
  assert.equal(buttons(openTree, "Mark Contract Signed").length, 0);
  assert.equal(buttons(openSection, "Schedule Settlement").length, 0);
  assert.equal(buttons(openSection, "Mark Settlement Completed").length, 1);
});

test("Closed hides writers and shows the read-only note", () => {
  const { render } = install(
    transaction({
      status: "Closed",
      contractDate: "2026-10-01T00:00:00.000Z",
      settlementDate: "2027-06-01T00:00:00.000Z",
      settlementCompletedAt: null,
      closedAt: "2027-07-01T00:00:00.000Z",
    }),
  );
  const tree = render();
  const section = transactionSection(tree);
  assertPanel(section, {
    "Mark Contract Signed": 0,
    "Mark Finance Approved": 0,
    "Mark Contracts Exchanged": 0,
    "Mark Unconditional": 0,
    "Schedule Settlement": 0,
    "Mark Settlement Completed": 0,
    "Calculate Commission": 0,
    "Record Funds Received": 0,
    "Mark Agent Paid": 0,
    "Close Transaction": 0,
    Reschedule: 0,
    "+ Add Condition": 0,
    Save: 0,
  });
  assert.equal(buttons(tree, "Mark Contract Signed").length, 0);
  assert.equal(buttons(tree, "Mark Finance Approved").length, 0);
  assert.equal(findAll(section, (element) => element.type === "select").length, 0);
  assert.equal(findAll(section, (element) => element.type === "input" && element.props?.placeholder === "Amount ($)").length, 0);
  assert.match(normalized(section), new RegExp(CLOSED_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(normalized(section), /Subject to building inspection/);
  assert.match(normalized(section), /Funds received:/);
  assert.match(normalized(section), /Legal representatives/);
  assert.match(normalized(section), /Closed 2027-07-01/);
});

test("a stale Schedule Settlement click still shows the server error", () => {
  const message = `Transaction ${TRANSACTION_ID} is closed — no further changes can be recorded.`;
  const { render } = install(
    transaction({
      status: "UnderContract",
      contractDate: "2026-10-01T00:00:00.000Z",
    }),
  );
  let tree = render();
  let section = transactionSection(tree);
  assert.equal(buttons(section, "Schedule Settlement").length, 1);
  assert.equal(normalized(section).includes(message), false);
  change(scheduleDateInput(section), "2027-06-01");
  (globalThis as { __txScriptedError?: unknown }).__txScriptedError = new ApiError(400, message);
  tree = render();
  section = transactionSection(tree);
  click(buttons(section, "Schedule Settlement")[0]);
  tree = render();
  section = transactionSection(tree);
  const error = findAll(section, (element) => element.type === "p" && element.props?.className === "error-text")[0];
  assert.equal(textContent(error).trim(), message);
  assert.equal(buttons(section, "Schedule Settlement").length, 1);
  const calls = (globalThis as { __txCalls?: Array<{ action?: string; body?: { settlementDate?: string } }> }).__txCalls ?? [];
  const schedule = calls.find((call) => call.action === "settlement-schedule");
  assert.equal(schedule?.body?.settlementDate, "2027-06-01");
});
