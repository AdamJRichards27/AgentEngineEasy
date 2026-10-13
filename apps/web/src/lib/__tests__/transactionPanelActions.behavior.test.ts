// R-F32 — the property Transaction panel only offers actions R-F30 would
// accept. React and the data hooks are replaced the same way the other
// web behaviour tests do, then the real PropertyWorkspace page renders.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { CLOSE_BLOCKED_REASON, CLOSE_BLOCKED_REASON_FOR_OTHERS, plainClosureBlocker, type ClosureBlockerDetail } from "../closureBlockers.ts";

const CLOSED_NOTE = "This transaction is closed — no further changes can be recorded.";
const CONDITIONAL_REASON = "Settlement can be completed once the contract is unconditional";
const PROPERTY_ID = 42;
const TRANSACTION_ID = 7;

interface PanelCondition {
  id: number;
  transactionId: number;
  description: string;
  dueDate: string | null;
  status: string;
  notes: string | null;
  resolvedAt: string | null;
}

interface PanelTask {
  id: string;
  kind: "TASK" | "REMINDER";
  title: string;
  detail: string | null;
  assignedRole: string | null;
  dueAt: string | null;
  status: string;
}

interface PanelException {
  id: string;
  brokerageId: number;
  propertyId: number;
  transactionId: number | null;
  ruleId: string;
  ruleVersion: number;
  category: string;
  severity: string;
  title: string;
  problemDescription: string;
  businessImpact: string;
  detectedCause: string;
  ownerType: string;
  ownerUserId: number | null;
  reassignmentCount: number;
  detectedAt: string;
  dueAt: string | null;
  escalatesAt: string | null;
  status: string;
  recommendedAction: string;
  resolutionRequirements: string;
  dismissible: boolean;
  resolvedAt: string | null;
  resolvedByUserId: number | null;
  resolutionMethod: string | null;
  dismissalReason: string | null;
  occurrenceCount: number;
  lastDetectedAt: string;
  requiresFinancialEntitlement: boolean;
  redacted: boolean;
}

interface PanelQueryOptions {
  conditions?: PanelCondition[] | "unloaded";
  closureBlockers?: string[] | null;
  closureBlockerDetails?: ClosureBlockerDetail[] | null;
  tasks?: PanelTask[];
  exceptions?: PanelException[];
  fundsReconciliation?: {
    status: string;
    expectedCents: number | null;
    receivedCents: number;
    varianceCents: number | null;
  } | null;
}

function conditionRow(id: number, status: string, description?: string): PanelCondition {
  return {
    id,
    transactionId: TRANSACTION_ID,
    description: description ?? `Condition ${status}`,
    dueDate: null,
    status,
    notes: null,
    resolvedAt: status === "Pending" ? null : "2026-10-03T00:00:00.000Z",
  };
}

const DEFAULT_CONDITIONS: PanelCondition[] = [
  {
    ...conditionRow(3, "Pending", "Subject to building inspection"),
    dueDate: "2027-05-01T00:00:00.000Z",
  },
];

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
        export const useQueryClient = () => ({
          invalidateQueries(filter) {
            globalThis.__txInvalidated.push(filter && filter.queryKey);
          },
        });
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
                return;
              }
              if (typeof options.onSuccess === "function") options.onSuccess(undefined, input);
              if (globalThis.__txClearBlockersOnSuccess) {
                const table = globalThis.__txQueries || {};
                for (const key of Object.keys(table)) {
                  if (key.indexOf('["transaction",') === 0 && table[key] && table[key].data) {
                    table[key].data.closureBlockers = [];
                    table[key].data.closureBlockerDetails = [];
                  }
                }
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
let humanizeApiError: (path: string, status: number, serverMessage?: string) => string;

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
    humanizeApiError: (path: string, status: number, serverMessage?: string) => string;
  };
  ApiError = api.ApiError;
  humanizeApiError = api.humanizeApiError;
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

function queriesFor(row: ReturnType<typeof transaction>, viewerRole: string | null, options?: PanelQueryOptions) {
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
    [`["transaction",${PROPERTY_ID}]`]: {
      ...ready,
      data: {
        transaction: row,
        ...(options?.fundsReconciliation !== undefined ? { fundsReconciliation: options.fundsReconciliation } : {}),
        ...(options?.closureBlockers !== undefined ? { closureBlockers: options.closureBlockers } : {}),
        ...(options?.closureBlockerDetails !== undefined ? { closureBlockerDetails: options.closureBlockerDetails } : {}),
      },
    },
    [`["property-timeline",${PROPERTY_ID}]`]: { ...ready, data: { timeline: [] } },
    ...(options?.conditions === "unloaded"
      ? {}
      : {
          [`["conditions",${TRANSACTION_ID}]`]: {
            ...ready,
            data: { conditions: options?.conditions ?? DEFAULT_CONDITIONS },
          },
        }),
    [`["tasks",${PROPERTY_ID}]`]: { ...ready, data: { tasks: options?.tasks ?? [], attentionItems: [] } },
    [`["property-exceptions",${PROPERTY_ID}]`]: {
      ...ready,
      data: {
        exceptions: options?.exceptions ?? [],
        summary: { openCount: options?.exceptions?.length ?? 0, highestSeverity: null, byStatus: {} },
      },
    },
    [`["property-launch",${PROPERTY_ID}]`]: { ...ready, data: { launch: null } },
    // useSession() reads ["session"]. The query mock returns this object as
    // the query result and does not apply `select`, so `data` is the user.
    '["session"]': {
      ...ready,
      data:
        viewerRole === null
          ? null
          : {
              id: 1,
              email: "viewer@example.com",
              firstName: "Vic",
              lastName: "Tor",
              role: viewerRole,
              brokerageId: 1,
              brokerageName: "Harbour Realty",
            },
    },
  };
}

function install(
  row: ReturnType<typeof transaction>,
  viewerRole: string | null = "Brokerage Administrator",
  options?: PanelQueryOptions,
) {
  const hooks = createHarness();
  Object.assign(globalThis, {
    __txHooks: hooks,
    __txQueries: queriesFor(row, viewerRole, options),
    __txCalls: [] as unknown[],
    __txInvalidated: [] as unknown[],
    __txClearBlockersOnSuccess: false,
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
  assert.equal(buttons(section, "Mark Settlement Completed").length, 0);
  assert.equal(normalized(section).includes(CONDITIONAL_REASON), false);
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
  assert.equal(buttons(section, "Mark Settlement Completed")[0]?.props?.disabled, true);
  assert.match(normalized(section), new RegExp(CONDITIONAL_REASON));
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
  assert.equal(buttons(section, "Mark Settlement Completed")[0]?.props?.disabled, true);
  assert.match(normalized(section), new RegExp(CONDITIONAL_REASON));
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
  assert.equal(buttons(openSection, "Mark Settlement Completed")[0]?.props?.disabled, true);
  assert.match(normalized(openSection), new RegExp(CONDITIONAL_REASON));
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
  assert.equal(normalized(section).includes(CONDITIONAL_REASON), false);
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

const WRONG_ROLE_MESSAGE = "You don't have the right role for that — ask a Brokerage Administrator.";

function fundsAmountInput(section: ElementNode): ElementNode {
  const input = findAll(section, (element) => element.type === "input" && element.props?.placeholder === "Amount ($)")[0];
  if (!input) throw new Error("missing funds amount input");
  return input;
}

function underContractReady(overrides: Record<string, unknown> = {}) {
  return transaction({
    status: "UnderContract",
    contractDate: "2026-10-01T00:00:00.000Z",
    ...overrides,
  });
}

test("Brokerage Administrator sees the three financial actions where R-F32 already allows them", () => {
  const ready = install(underContractReady(), "Brokerage Administrator");
  const section = transactionSection(ready.render());
  assertPanel(section, {
    ...OPEN_WRITERS,
    "Mark Contract Signed": 0,
    "Schedule Settlement": 1,
    "Mark Settlement Completed": 1,
    "Close Transaction": 1,
  });
  assert.equal(findAll(section, (element) => element.type === "input" && element.props?.placeholder === "Amount ($)").length, 1);
  assert.equal(buttons(section, "Mark Settlement Completed")[0]?.props?.disabled, true);
  assert.match(normalized(section), new RegExp(CONDITIONAL_REASON));

  const early = install(transaction({ status: "ContractPreparation", contractDate: null }), "Brokerage Administrator");
  const earlySection = transactionSection(early.render());
  assertPanel(earlySection, {
    "Mark Settlement Completed": 0,
    "Schedule Settlement": 0,
    "Calculate Commission": 1,
    "Record Funds Received": 1,
    "Mark Contract Signed": 1,
  });

  const settled = install(
    transaction({
      status: "Settled",
      contractDate: "2026-10-01T00:00:00.000Z",
      settlementCompletedAt: "2027-06-02T00:00:00.000Z",
    }),
    "Brokerage Administrator",
  );
  const settledSection = transactionSection(settled.render());
  assertPanel(settledSection, {
    "Mark Settlement Completed": 0,
    "Schedule Settlement": 0,
    "Calculate Commission": 1,
    "Record Funds Received": 1,
    "Mark Agent Paid": 1,
    "Close Transaction": 1,
  });
  assert.equal(buttons(settledSection, "Close Transaction")[0]?.props?.disabled, false);
});

for (const role of ["Agent", "Pit Crew"] as const) {
  test(`${role} does not see settlement completion, funds received, or commission calculation`, () => {
    const ready = install(underContractReady(), role);
    const section = transactionSection(ready.render());
    assertPanel(section, {
      "Mark Contract Signed": 0,
      "Mark Finance Approved": 1,
      "Mark Contracts Exchanged": 1,
      "Mark Unconditional": 1,
      "Schedule Settlement": 1,
      "Mark Settlement Completed": 0,
      "Calculate Commission": 0,
      "Record Funds Received": 0,
      "Mark Agent Paid": 1,
      "Close Transaction": 1,
      Reschedule: 1,
      "+ Add Condition": 1,
      Save: 1,
    });
    assert.equal(findAll(section, (element) => element.type === "input" && element.props?.placeholder === "Amount ($)").length, 0);
    assert.match(normalized(section), /not yet calculated/);
    assert.match(normalized(section), /Funds received:/);
    assert.equal(normalized(section).includes(CONDITIONAL_REASON), false);
    assert.match(normalized(section), /SettlementScheduled|scheduled|UnderContract/);
    assert.equal(normalized(section).includes(CLOSED_NOTE), false);
    assert.equal(buttons(section, "Close Transaction")[0]?.props?.disabled, true);

    const early = install(transaction({ status: "ContractPreparation", contractDate: null }), role);
    const earlySection = transactionSection(early.render());
    assertPanel(earlySection, {
      "Mark Contract Signed": 1,
      "Schedule Settlement": 0,
      "Mark Settlement Completed": 0,
      "Calculate Commission": 0,
      "Record Funds Received": 0,
      "Mark Finance Approved": 1,
    });

    const closed = install(
      transaction({
        status: "Closed",
        contractDate: "2026-10-01T00:00:00.000Z",
        settlementCompletedAt: "2027-06-02T00:00:00.000Z",
        closedAt: "2027-07-01T00:00:00.000Z",
      }),
      role,
    );
    const closedSection = transactionSection(closed.render());
    assertPanel(closedSection, {
      "Mark Settlement Completed": 0,
      "Calculate Commission": 0,
      "Record Funds Received": 0,
      "Schedule Settlement": 0,
      "Mark Contract Signed": 0,
      "Mark Agent Paid": 0,
      "Close Transaction": 0,
    });
    assert.match(normalized(closedSection), /Funds received:/);
    assert.match(normalized(closedSection), new RegExp(CLOSED_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
}

test("a signed-in user with no role does not see the three financial actions", () => {
  const { render } = install(underContractReady(), null);
  const section = transactionSection(render());
  assertPanel(section, {
    "Mark Settlement Completed": 0,
    "Calculate Commission": 0,
    "Record Funds Received": 0,
    "Schedule Settlement": 1,
    "Mark Finance Approved": 1,
    "Mark Agent Paid": 1,
  });
});

test("a stale financial action click still shows the server 403", () => {
  const friendly = humanizeApiError(`/transactions/${TRANSACTION_ID}/settlement-complete`, 403, "Forbidden");
  assert.equal(friendly, WRONG_ROLE_MESSAGE);
  const { render } = install(
    underContractReady({ unconditionalAt: "2026-10-02T00:00:00.000Z" }),
    "Brokerage Administrator",
  );
  let tree = render();
  let section = transactionSection(tree);
  assert.equal(buttons(section, "Mark Settlement Completed").length, 1);
  assert.equal(buttons(section, "Mark Settlement Completed")[0]?.props?.disabled, false);
  assert.equal(normalized(section).includes(CONDITIONAL_REASON), false);
  assert.equal(buttons(section, "Calculate Commission").length, 1);
  assert.equal(buttons(section, "Record Funds Received").length, 1);
  assert.equal(normalized(section).includes(WRONG_ROLE_MESSAGE), false);

  (globalThis as { __txScriptedError?: unknown }).__txScriptedError = new ApiError(403, friendly);
  change(fundsAmountInput(section), "1500");
  tree = render();
  section = transactionSection(tree);

  click(buttons(section, "Mark Settlement Completed")[0]);
  tree = render();
  section = transactionSection(tree);
  let error = findAll(section, (element) => element.type === "p" && element.props?.className === "error-text")[0];
  assert.equal(textContent(error).trim(), WRONG_ROLE_MESSAGE);
  assert.equal(buttons(section, "Mark Settlement Completed").length, 1);

  click(buttons(section, "Calculate Commission")[0]);
  tree = render();
  section = transactionSection(tree);
  error = findAll(section, (element) => element.type === "p" && element.props?.className === "error-text")[0];
  assert.equal(textContent(error).trim(), WRONG_ROLE_MESSAGE);
  assert.equal(buttons(section, "Calculate Commission").length, 1);

  click(buttons(section, "Record Funds Received")[0]);
  tree = render();
  section = transactionSection(tree);
  error = findAll(section, (element) => element.type === "p" && element.props?.className === "error-text")[0];
  assert.equal(textContent(error).trim(), WRONG_ROLE_MESSAGE);

  const calls = (globalThis as { __txCalls?: Array<{ action?: string; body?: { amountCents?: number } }> }).__txCalls ?? [];
  assert.equal(calls.some((call) => call.action === "settlement-complete"), true);
  assert.equal(calls.some((call) => call.action === "calculate-commission"), true);
  const funds = calls.find((call) => call.action === "funds-received");
  assert.equal(funds?.body?.amountCents, 150000);
});

function postedActions(): string[] {
  const recorded = (globalThis as { __txCalls?: Array<{ action?: string }> }).__txCalls ?? [];
  return recorded.map((call) => call.action ?? "");
}

function assertSettlement(section: ElementNode, state: "hidden" | "disabled" | "enabled"): void {
  const found = buttons(section, "Mark Settlement Completed");
  const hasReason = normalized(section).includes(CONDITIONAL_REASON);
  if (state === "hidden") {
    assert.equal(found.length, 0);
    assert.equal(hasReason, false);
    return;
  }
  assert.equal(found.length, 1, state);
  assert.equal(Boolean(found[0]?.props?.disabled), state === "disabled", state);
  assert.equal(hasReason, state === "disabled", state);
  if (state === "disabled") assert.equal(normalized(section).split(CONDITIONAL_REASON).length - 1, 1);
}

function signedDeal(overrides: Record<string, unknown> = {}) {
  return transaction({
    status: "SettlementScheduled",
    contractDate: "2026-10-01T00:00:00.000Z",
    settlementDate: "2027-06-01T00:00:00.000Z",
    ...overrides,
  });
}

test("a pending condition disables Mark Settlement Completed and leaves the funds line in place", () => {
  const { render } = install(signedDeal(), "Brokerage Administrator", {
    conditions: [conditionRow(3, "Pending", "Subject to finance")],
    fundsReconciliation: {
      status: "MATCHED",
      expectedCents: 165000,
      receivedCents: 165000,
      varianceCents: 0,
    },
  });
  let section = transactionSection(render());
  assertSettlement(section, "disabled");
  assert.equal(buttons(section, "Schedule Settlement").length, 1);
  change(scheduleDateInput(section), "2027-08-01");
  section = transactionSection(render());
  assert.equal(buttons(section, "Schedule Settlement")[0]?.props?.disabled, false);
  assertSettlement(section, "disabled");
  assert.equal(buttons(section, "Calculate Commission").length, 1);
  assert.equal(buttons(section, "Record Funds Received").length, 1);
  const text = normalized(section);
  const fundsAt = text.indexOf("Funds received:");
  const lineAt = text.indexOf("Received in full");
  assert.ok(fundsAt >= 0);
  assert.ok(lineAt > fundsAt);
  assert.equal(buttons(section, "Received in full").length, 0);
  click(buttons(section, "Mark Settlement Completed")[0]);
  assert.equal(postedActions().includes("settlement-complete"), false);
});

test("a failed condition keeps settlement completion disabled after exchange", () => {
  const { render } = install(
    signedDeal({ exchangedAt: "2026-10-02T00:00:00.000Z" }),
    "Brokerage Administrator",
    { conditions: [conditionRow(4, "Failed", "Subject to building")] },
  );
  assertSettlement(transactionSection(render()), "disabled");
});

test("satisfied and waived conditions do not enable settlement before exchange", () => {
  const { render } = install(signedDeal(), "Brokerage Administrator", {
    conditions: [conditionRow(5, "Satisfied", "Finance"), conditionRow(6, "Waived", "Building")],
  });
  const section = transactionSection(render());
  assertSettlement(section, "disabled");
  click(buttons(section, "Mark Settlement Completed")[0]);
  assert.equal(postedActions().includes("settlement-complete"), false);
});

test("exchange plus satisfied, waived, or not-applicable conditions enables settlement before the timestamp refreshes", () => {
  const { render } = install(
    signedDeal({ exchangedAt: "2026-10-02T00:00:00.000Z", unconditionalAt: null }),
    "Brokerage Administrator",
    {
      conditions: [
        conditionRow(5, "Satisfied", "Finance"),
        conditionRow(6, "Waived", "Building"),
        conditionRow(7, "NotApplicable", "Pest"),
      ],
    },
  );
  const section = transactionSection(render());
  assertSettlement(section, "enabled");
  click(buttons(section, "Mark Settlement Completed")[0]);
  assert.equal(postedActions().includes("settlement-complete"), true);
});

test("a signed exchanged contract with no conditions can complete settlement", () => {
  const { render } = install(
    signedDeal({ exchangedAt: "2026-10-02T00:00:00.000Z", unconditionalAt: null }),
    "Brokerage Administrator",
    { conditions: [] },
  );
  assertSettlement(transactionSection(render()), "enabled");
});

test("a signed contract with no conditions stays conditional until exchange", () => {
  const { render } = install(signedDeal({ unconditionalAt: null }), "Brokerage Administrator", { conditions: [] });
  assertSettlement(transactionSection(render()), "disabled");
});

test("an unloaded conditions list is not treated as zero conditions", () => {
  const { render } = install(
    signedDeal({ exchangedAt: "2026-10-02T00:00:00.000Z", unconditionalAt: null }),
    "Brokerage Administrator",
    { conditions: "unloaded" },
  );
  assertSettlement(transactionSection(render()), "disabled");
});

test("unconditionalAt enables settlement completion even when a condition row is still pending", () => {
  const { render } = install(
    signedDeal({ unconditionalAt: "2026-10-04T00:00:00.000Z" }),
    "Brokerage Administrator",
    { conditions: [conditionRow(3, "Pending", "Subject to finance")] },
  );
  const section = transactionSection(render());
  assertSettlement(section, "enabled");
  click(buttons(section, "Mark Settlement Completed")[0]);
  assert.equal(postedActions().includes("settlement-complete"), true);
});

test("settlement completion stays hidden, with no conditional reason, until a settlement date exists", () => {
  const { render } = install(
    transaction({
      status: "UnderContract",
      contractDate: "2026-10-01T00:00:00.000Z",
      exchangedAt: "2026-10-02T00:00:00.000Z",
      unconditionalAt: "2026-10-02T00:00:00.000Z",
      settlementDate: null,
    }),
    "Brokerage Administrator",
    { conditions: [] },
  );
  const section = transactionSection(render());
  assertSettlement(section, "hidden");
  assert.equal(buttons(section, "Schedule Settlement").length, 1);
});

const CLOSE_BLOCKER_LINES = [
  "AML/CTF verification is not complete for 1 seller party.",
  "Commission has not been calculated.",
  "Funds reconciliation is NOT_RECEIVED, not MATCHED.",
  "An open financial dispute (FIN02) must be resolved before close.",
  "Commission does not reconcile between the transaction record and the Financial Engine.",
];

function settledRow() {
  return transaction({
    status: "Settled",
    contractDate: "2026-10-01T00:00:00.000Z",
    settlementCompletedAt: "2027-06-02T00:00:00.000Z",
  });
}

test("the Transaction panel lists each close blocker and disables Close before the click", () => {
  const blocked = install(settledRow(), "Brokerage Administrator", { closureBlockers: CLOSE_BLOCKER_LINES });
  const section = transactionSection(blocked.render());
  const text = normalized(section);
  assert.equal(text.split(CLOSE_BLOCKED_REASON).length - 1, 1);
  for (const blocker of CLOSE_BLOCKER_LINES) {
    const plain = plainClosureBlocker(blocker);
    assert.equal(text.split(plain).length - 1, 1, plain);
  }
  assert.equal(text.includes("FIN02"), false);
  assert.equal(text.includes("NOT_RECEIVED"), false);
  assert.equal(buttons(section, "Close Transaction").length, 1);
  assert.equal(buttons(section, "Close Transaction")[0]?.props?.disabled, true);
  click(buttons(section, "Close Transaction")[0]);
  assert.equal(postedActions().includes("close"), false);

  const open = install(settledRow(), "Brokerage Administrator", { closureBlockers: [] });
  const openSection = transactionSection(open.render());
  assert.equal(normalized(openSection).includes(CLOSE_BLOCKED_REASON), false);
  assert.equal(buttons(openSection, "Close Transaction")[0]?.props?.disabled, false);
  click(buttons(openSection, "Close Transaction")[0]);
  assert.deepEqual(postedActions(), ["close"]);
});

test("close blockers stay listed, and Close stays disabled, before the transaction is Settled", () => {
  const { render } = install(
    transaction({ status: "UnderContract", contractDate: "2026-10-01T00:00:00.000Z" }),
    "Agent",
    { closureBlockers: ["Commission has not been calculated.", "A blocker the panel has not seen before."] },
  );
  const section = transactionSection(render());
  const text = normalized(section);
  assert.match(text, /Commission has not been calculated/);
  assert.match(text, /A blocker the panel has not seen before/);
  assert.match(text, new RegExp(CLOSE_BLOCKED_REASON_FOR_OTHERS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(text.includes(CLOSE_BLOCKED_REASON), false);
  assert.equal(buttons(section, "Close Transaction")[0]?.props?.disabled, true);
  click(buttons(section, "Close Transaction")[0]);
  assert.equal(postedActions().includes("close"), false);
});

test("a closed transaction does not list close blockers", () => {
  const { render } = install(
    transaction({
      status: "Closed",
      contractDate: "2026-10-01T00:00:00.000Z",
      settlementCompletedAt: "2027-06-02T00:00:00.000Z",
      closedAt: "2027-07-01T00:00:00.000Z",
    }),
    "Brokerage Administrator",
    { closureBlockers: ["Commission has not been calculated."] },
  );
  const section = transactionSection(render());
  assert.equal(buttons(section, "Close Transaction").length, 0);
  assert.equal(normalized(section).includes("Commission has not been calculated."), false);
  assert.equal(normalized(section).includes(CLOSE_BLOCKED_REASON), false);
  assert.match(normalized(section), /Closed 2027-07-01/);
});

for (const role of ["Agent", "Pit Crew"] as const) {
  test(`${role} still does not see Mark Settlement Completed once the contract is unconditional`, () => {
    const { render } = install(
      signedDeal({
        exchangedAt: "2026-10-02T00:00:00.000Z",
        unconditionalAt: "2026-10-02T00:00:00.000Z",
      }),
      role,
      { conditions: [conditionRow(6, "Waived", "Building")] },
    );
    const section = transactionSection(render());
    assertSettlement(section, "hidden");
    assert.equal(buttons(section, "Schedule Settlement").length, 1);
    assert.equal(buttons(section, "Calculate Commission").length, 0);
    assert.equal(buttons(section, "Record Funds Received").length, 0);
    assert.match(normalized(section), /Funds received:/);
    assert.match(normalized(section), /not yet calculated/);
  });
}

const CLOSE_REFRESH_KEYS = [
  ["transaction", PROPERTY_ID],
  ["tasks", PROPERTY_ID],
  ["property-exceptions", PROPERTY_ID],
  ["conditions"],
  ["property-workspace", PROPERTY_ID],
];

function invalidatedKeys(): unknown[] {
  return (globalThis as { __txInvalidated?: unknown[] }).__txInvalidated ?? [];
}

function clearInvalidated(): void {
  (globalThis as { __txInvalidated?: unknown[] }).__txInvalidated = [];
}

function armBlockerClear(): void {
  (globalThis as { __txClearBlockersOnSuccess?: boolean }).__txClearBlockersOnSuccess = true;
}

function sectionByHeading(tree: unknown, title: string): ElementNode | undefined {
  return findAll(tree, (element) => {
    if (element.type !== "section") return false;
    const heading = findAll(element, (child) => child.type === "h2")[0];
    return textContent(heading).trim() === title;
  })[0];
}

function elementIds(tree: unknown): Set<string> {
  return new Set(
    findAll(tree, (element) => typeof element.props?.id === "string").map((element) => String(element.props?.id)),
  );
}

function panelException(id: string, title: string): PanelException {
  return {
    id,
    brokerageId: 1,
    propertyId: PROPERTY_ID,
    transactionId: TRANSACTION_ID,
    ruleId: "TEST",
    ruleVersion: 1,
    category: "SETTLEMENT_CLOSURE",
    severity: "ATTENTION",
    title,
    problemDescription: "Needs an owner.",
    businessImpact: "Close stays blocked.",
    detectedCause: "No owner.",
    ownerType: "UNASSIGNED_QUEUE",
    ownerUserId: null,
    reassignmentCount: 0,
    detectedAt: "2026-10-01T00:00:00.000Z",
    dueAt: null,
    escalatesAt: null,
    status: "OPEN",
    recommendedAction: "Assign an owner.",
    resolutionRequirements: "An owner is assigned.",
    dismissible: false,
    resolvedAt: null,
    resolvedByUserId: null,
    resolutionMethod: null,
    dismissalReason: null,
    occurrenceCount: 1,
    lastDetectedAt: "2026-10-01T00:00:00.000Z",
    requiresFinancialEntitlement: false,
    redacted: false,
  };
}

test("each close blocker links to the section that clears it", () => {
  const details: ClosureBlockerDetail[] = [
    { code: "NOT_UNCONDITIONAL", message: "The transaction has not become unconditional yet." },
    { code: "CONDITIONS_PENDING", message: "1 contract condition(s) are still Pending.", count: 1 },
    { code: "AML_SELLER", message: "AML/CTF verification is not complete for 1 seller party.", count: 1 },
    { code: "AML_BUYER", message: "AML/CTF verification is not complete for 1 buyer party.", count: 1 },
    { code: "ATTENTION_OPEN", message: "1 open attention item(s) require review.", count: 1 },
    {
      code: "MUST_FINISH_TASKS",
      message: "Must-finish task(s) still open: Confirm the transaction record is complete.",
      refs: ["task-1"],
    },
    { code: "COMMISSION_NOT_CALCULATED", message: "Commission has not been calculated." },
    { code: "FUNDS_NOT_MATCHED", message: "Funds reconciliation is NOT_RECEIVED, not MATCHED.", refs: ["NOT_RECEIVED"] },
    { code: "FINANCIAL_DISPUTE_OPEN", message: "An open financial dispute (FIN02) must be resolved before close." },
    {
      code: "COMMISSION_DISCREPANCY",
      message: "Commission does not reconcile between the transaction record and the Financial Engine.",
    },
    {
      code: "EXCEPTIONS_NEED_OWNER",
      message: "1 open non-financial exception(s) need an assigned owner.",
      count: 1,
      refs: ["ex-1"],
    },
    { code: "FUTURE_BLOCKER", message: "A blocker the panel has not seen before." },
  ];
  const { render } = install(settledRow(), "Brokerage Administrator", {
    closureBlockers: details.map((detail) => detail.message),
    closureBlockerDetails: details,
    tasks: [
      {
        id: "task-1",
        kind: "TASK",
        title: "Confirm the transaction record is complete",
        detail: null,
        assignedRole: null,
        dueAt: null,
        status: "ACTIVE",
      },
    ],
    exceptions: [panelException("ex-1", "Needs an owner")],
  });
  const tree = render();
  const section = transactionSection(tree);
  const links = findAll(section, (element) => element.type === "a" && typeof element.props?.href === "string");
  const hrefs = links.map((link) => String(link.props?.href));
  assert.deepEqual(hrefs, [
    "#transaction-unconditional",
    "#transaction-conditions",
    "#workspace-sellers",
    "#workspace-parties",
    "#workspace-tasks",
    "#workspace-tasks",
    "#transaction-commission",
    "#transaction-funds",
    "#workspace-financial",
    "#transaction-commission",
    "#workspace-exceptions",
  ]);
  const ids = elementIds(tree);
  for (const href of hrefs) {
    assert.equal(ids.has(href.slice(1)), true, href);
  }
  assert.equal(normalized(section).includes("A blocker the panel has not seen before."), true);
  assert.equal(
    links.some((link) => textContent(link).includes("A blocker the panel has not seen before.")),
    false,
  );
});

test("resolving a condition, completing a task, or reassigning an exception refetches and re-enables Close", () => {
  const condition = install(settledRow(), "Brokerage Administrator", {
    closureBlockers: ["1 contract condition(s) are still Pending."],
    closureBlockerDetails: [{ code: "CONDITIONS_PENDING", message: "1 contract condition(s) are still Pending.", count: 1 }],
  });
  armBlockerClear();
  let section = transactionSection(condition.render());
  assert.equal(buttons(section, "Close Transaction")[0]?.props?.disabled, true);
  const resolve = findAll(section, (element) => element.type === "select" && textContent(element).includes("Resolve as"))[0];
  change(resolve, "Satisfied");
  assert.deepEqual(invalidatedKeys(), CLOSE_REFRESH_KEYS);
  section = transactionSection(condition.render());
  assert.equal(buttons(section, "Close Transaction")[0]?.props?.disabled, false);

  clearInvalidated();
  const task = install(settledRow(), "Brokerage Administrator", {
    closureBlockers: ["Must-finish task(s) still open: Confirm the transaction record is complete."],
    closureBlockerDetails: [
      {
        code: "MUST_FINISH_TASKS",
        message: "Must-finish task(s) still open: Confirm the transaction record is complete.",
        refs: ["task-1"],
      },
    ],
    tasks: [
      {
        id: "task-1",
        kind: "TASK",
        title: "Confirm the transaction record is complete",
        detail: null,
        assignedRole: null,
        dueAt: null,
        status: "ACTIVE",
      },
    ],
  });
  armBlockerClear();
  let taskTree = task.render();
  assert.equal(buttons(transactionSection(taskTree), "Close Transaction")[0]?.props?.disabled, true);
  click(buttons(sectionByHeading(taskTree, "Tasks & Attention"), "Mark Complete")[0]);
  assert.deepEqual(invalidatedKeys(), CLOSE_REFRESH_KEYS);
  taskTree = task.render();
  assert.equal(buttons(transactionSection(taskTree), "Close Transaction")[0]?.props?.disabled, false);

  clearInvalidated();
  const exception = install(settledRow(), "Brokerage Administrator", {
    closureBlockers: ["1 open non-financial exception(s) need an assigned owner."],
    closureBlockerDetails: [
      {
        code: "EXCEPTIONS_NEED_OWNER",
        message: "1 open non-financial exception(s) need an assigned owner.",
        count: 1,
        refs: ["ex-1"],
      },
    ],
    exceptions: [panelException("ex-1", "Needs an owner")],
  });
  armBlockerClear();
  let exceptionTree = exception.render();
  assert.equal(buttons(transactionSection(exceptionTree), "Close Transaction")[0]?.props?.disabled, true);
  const card = findAll(exceptionTree, (element) => element.type === "li" && textContent(element).includes("Needs an owner"))[0];
  const owner = findAll(card, (element) => element.type === "select" && textContent(element).includes("Reassign to"))[0];
  change(owner, "LISTING_AGENT");
  exceptionTree = exception.render();
  const reason = findAll(
    findAll(exceptionTree, (element) => element.type === "li" && textContent(element).includes("Needs an owner"))[0],
    (element) => element.type === "input" && element.props?.placeholder === "Reason for reassignment",
  )[0];
  change(reason, "Give it an owner");
  exceptionTree = exception.render();
  const reassignCard = findAll(exceptionTree, (element) => element.type === "li" && textContent(element).includes("Needs an owner"))[0];
  click(buttons(reassignCard, "Reassign")[0]);
  assert.deepEqual(invalidatedKeys(), CLOSE_REFRESH_KEYS);
  exceptionTree = exception.render();
  assert.equal(buttons(transactionSection(exceptionTree), "Close Transaction")[0]?.props?.disabled, false);
});

test("recording funds and marking the agent paid refresh tasks and exceptions", () => {
  const { render } = install(settledRow(), "Brokerage Administrator", { closureBlockers: [] });
  let section = transactionSection(render());
  change(fundsAmountInput(section), "10");
  section = transactionSection(render());
  click(buttons(section, "Record Funds Received")[0]);
  assert.deepEqual(invalidatedKeys(), CLOSE_REFRESH_KEYS);
  clearInvalidated();
  section = transactionSection(render());
  click(buttons(section, "Mark Agent Paid")[0]);
  assert.deepEqual(invalidatedKeys(), CLOSE_REFRESH_KEYS);
});
