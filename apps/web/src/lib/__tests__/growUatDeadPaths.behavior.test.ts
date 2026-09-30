import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

// G-UAT-1 — two dead paths that already had an API:
//   Complete on a Grow Today commitment card (the Contact 360 PATCH), and
//   Merge on an import duplicate row (resolution "merge").
// React and its data hooks are replaced with the same in-memory fakes the
// other Grow behaviour tests use, so the real page functions run under node.

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

function findAll(
  node: unknown,
  predicate: (element: ElementNode) => boolean,
): ElementNode[] {
  if (Array.isArray(node))
    return node.flatMap((child) => findAll(child, predicate));
  if (!node || typeof node !== "object") return [];
  const element = node as ElementNode;
  const own = predicate(element) ? [element] : [];
  return own.concat(findAll(element.props?.children, predicate));
}

function button(tree: unknown, label: string): ElementNode | undefined {
  return findAll(
    tree,
    (element) =>
      element.type === "button" && textContent(element).trim() === label,
  )[0];
}

function buttons(tree: unknown): string[] {
  return findAll(tree, (element) => element.type === "button").map((element) =>
    textContent(element).trim(),
  );
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

type Call = { path: string; options?: { method?: string; body?: string } };

function createHarness() {
  const state: unknown[] = [];
  let stateCursor = 0;
  return {
    reset() {
      state.length = 0;
    },
    // Drop slots that belonged to a screen which has unmounted, the way React
    // drops that screen's state. The workspace's own slots stay.
    truncate(keep: number) {
      state.length = keep;
    },
    beginRender() {
      stateCursor = 0;
    },
    useState(initial: unknown) {
      const index = stateCursor++;
      if (!(index in state))
        state[index] =
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial;
      return [
        state[index],
        (next: unknown) => {
          state[index] =
            typeof next === "function"
              ? (next as (current: unknown) => unknown)(state[index])
              : next;
        },
      ];
    },
    useEffect() {},
  };
}

async function withVite<T>(
  prefix: string,
  plugin: Plugin,
  run: (vite: ViteDevServer) => Promise<T>,
): Promise<T> {
  const vite = await createServer({
    root: new URL("../../..", import.meta.url).pathname,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: true },
    resolve: {
      alias: [
        { find: /^react$/, replacement: `virtual:${prefix}-react` },
        {
          find: /^react\/jsx-(dev-)?runtime$/,
          replacement: `virtual:${prefix}-jsx`,
        },
        {
          find: /^@tanstack\/react-query$/,
          replacement: `virtual:${prefix}-query`,
        },
        { find: /^wouter$/, replacement: `virtual:${prefix}-wouter` },
      ],
    },
    plugins: [plugin],
  });
  try {
    return await run(vite);
  } finally {
    await vite.close();
  }
}

function commitmentCard(overrides: Record<string, unknown> = {}) {
  return {
    id: "commitment:9",
    type: "commitment",
    priority: "DoNow",
    partyId: 12,
    contactName: "Casey Committed",
    contactEmail: null,
    contactMobile: null,
    relationshipType: null,
    propertyId: null,
    propertyLabel: null,
    opportunityId: null,
    appraisalId: null,
    commitmentId: 9,
    reason: "Open commitment is due today. Promised: Call Casey.",
    recommendedAction: "Call Casey.",
    dueAt: "2026-09-24T00:00:00.000Z",
    lastActivityAt: null,
    availableActions: [
      { action: "add_note" },
      { action: "view_contact", partyId: 12 },
      { action: "ask_ae" },
    ],
    rankScore: 0,
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
    refetch() {},
    data: {
      generatedAt: "2026-09-24T01:00:00.000Z",
      hasAnyGrowData: true,
      counts: {
        priorityActions: 1,
        followUpsDue: 1,
        openOpportunities: 0,
        contactsNeedingAttention: 1,
      },
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

const todayMocks: Plugin = {
  name: "guat1-today-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:guat1-react")
      return "\0guat1-react";
    if (
      source === "react/jsx-dev-runtime" ||
      source === "react/jsx-runtime" ||
      source === "virtual:guat1-jsx"
    )
      return "\0guat1-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:guat1-query")
      return "\0guat1-query";
    if (source === "wouter" || source === "virtual:guat1-wouter")
      return "\0guat1-wouter";
    if (source === "../lib/api") return "\0guat1-api";
    if (source === "../lib/session") return "\0guat1-session";
    if (
      source === "../components/AskAgentEngine" ||
      source === "../components/CommunicationsSection" ||
      source === "../components/PropertyIntelligencePanel" ||
      source === "../components/GrowContactTranscriptPanel" ||
      source === "../components/GrowContactConsentPanel" ||
      source === "../components/GrowPendingCommitmentProposals" ||
      source === "../components/ErrorBoundary"
    ) {
      return "\0guat1-components";
    }
    return null;
  },
  load(id) {
    if (id === "\0guat1-react") {
      return `
        export const useState = (...args) => globalThis.__guat1Hooks.useState(...args);
        export const useEffect = (...args) => globalThis.__guat1Hooks.useEffect(...args);
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0guat1-jsx") {
      return `
        export const Fragment = Symbol.for("guat1-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0guat1-query") {
      return `
        export const useQueryClient = () => ({
          invalidateQueries: (filter) => globalThis.__guat1Invalidated.push(filter && filter.queryKey),
        });
        export const useQuery = () => globalThis.__guat1Query;
        export const useMutation = (options) => {
          const index = globalThis.__guat1MutationCursor++;
          globalThis.__guat1Mutations[index] = options;
          const error = globalThis.__guat1MutationErrors[index] ?? null;
          return {
            isPending: false,
            isError: error != null,
            error,
            mutate(input) {
              globalThis.__guat1Pending.push(
                Promise.resolve()
                  .then(() => options.mutationFn(input))
                  .then(
                    (result) => { options.onSuccess?.(result, input); },
                    (failure) => { options.onError?.(failure, input); },
                  ),
              );
            },
          };
        };
      `;
    }
    if (id === "\0guat1-wouter") {
      return `export const Link = (props) => ({ type: "a", props }); export const useSearch = () => "";`;
    }
    if (id === "\0guat1-api") {
      return `
        export const ApiError = globalThis.__guat1ApiError;
        export const apiFetch = (path, options) => globalThis.__guat1ApiFetch(path, options);
        export function apiErrorMessage(error, fallback) {
          if (error instanceof ApiError && typeof error.friendly === "string" && error.friendly.trim()) return error.friendly;
          return fallback;
        }
      `;
    }
    if (id === "\0guat1-session") {
      return `
        export const useSession = () => ({ user: { id: 1, firstName: "Sam", role: "Agent" } });
        export const useEntitlements = () => ({
          isLoading: false,
          hasEntitlement: (key) => globalThis.__guat1Entitlements.includes(key),
        });
      `;
    }
    if (id === "\0guat1-components") {
      return `
        export const AskAgentEngine = () => null;
        export const ContactCommunicationsSection = () => null;
        export const PropertyIntelligencePanel = () => null;
        export const GrowContactTranscriptPanel = () => null;
        export const GrowContactConsentPanel = () => null;
        export const GrowPendingCommitmentProposals = () => null;
        export const ErrorBoundary = (props) => props.children;
      `;
    }
    return null;
  },
};

function installToday(card: Record<string, unknown>, entitlements: string[]) {
  const hooks = createHarness();
  const calls: Call[] = [];
  const invalidated: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const mutations: Array<{
    mutationFn: (input: unknown) => Promise<unknown>;
    onSuccess?: (result: unknown, input: unknown) => void;
  }> = [];
  Object.assign(globalThis, {
    __guat1Hooks: hooks,
    __guat1ApiError: FakeApiError,
    __guat1Query: todayQuery(card),
    __guat1Entitlements: entitlements,
    __guat1Invalidated: invalidated,
    __guat1Pending: pending,
    __guat1Mutations: mutations,
    __guat1MutationCursor: 0,
    __guat1MutationErrors: [] as unknown[],
    __guat1ApiFetch: (
      path: string,
      options?: { method?: string; body?: string },
    ) => {
      calls.push({ path, options });
      const failure = (globalThis as { __guat1FetchFailure?: unknown })
        .__guat1FetchFailure;
      if (failure) return Promise.reject(failure);
      return Promise.resolve({});
    },
  });
  return { hooks, calls, invalidated, pending, mutations };
}

function clearToday() {
  for (const key of [
    "__guat1Hooks",
    "__guat1ApiError",
    "__guat1Query",
    "__guat1Entitlements",
    "__guat1Invalidated",
    "__guat1Pending",
    "__guat1Mutations",
    "__guat1MutationCursor",
    "__guat1MutationErrors",
    "__guat1ApiFetch",
    "__guat1FetchFailure",
  ]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

function renderToday(
  hooks: ReturnType<typeof createHarness>,
  GrowToday: (props: Record<string, unknown>) => unknown,
) {
  (globalThis as { __guat1MutationCursor: number }).__guat1MutationCursor = 0;
  hooks.beginRender();
  return GrowToday({
    onAskAE: () => {},
    onViewContact: () => {},
    onEmailContact: () => {},
    onSmsContact: () => {},
  });
}

test("G-UAT-1: Grow Today Complete patches the commitment as Completed and refreshes Today", async () => {
  const { hooks, calls, invalidated, pending } = installToday(
    commitmentCard(),
    ["grow.activities.manage", "grow.contacts.read"],
  );
  try {
    await withVite("guat1", todayMocks, async (vite) => {
      const { GrowToday } = (await vite.ssrLoadModule(
        "/src/pages/Grow.tsx",
      )) as {
        GrowToday: (props: Record<string, unknown>) => unknown;
      };
      const tree = renderToday(hooks, GrowToday);
      const complete = button(tree, "Complete");
      assert.ok(complete, "an open commitment card offers Complete");
      assert.equal(complete.props?.className, "btn btn-link btn-small");
      assert.equal(complete.props?.type, "button");
      assert.equal(
        button(tree, "Cancel"),
        undefined,
        "Cancel stays on Contact 360",
      );
      assert.ok(
        button(tree, "Reschedule"),
        "an open commitment card offers Reschedule beside Complete",
      );
      assert.ok(button(tree, "Add note"), "the note action is unchanged");
      assert.ok(button(tree, "View contact"), "view contact is unchanged");
      assert.ok(button(tree, "Ask AE"), "Ask AE is unchanged");

      (complete.props!.onClick as () => void)();
      await Promise.all(pending);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, "/grow/contacts/commitments/9");
      assert.equal(calls[0].options?.method, "PATCH");
      assert.deepEqual(JSON.parse(calls[0].options!.body!), {
        status: "Completed",
      });
      assert.ok(
        invalidated.some(
          (key) =>
            Array.isArray(key) && key.length === 1 && key[0] === "grow-today",
        ),
        "Today is invalidated so the completed card leaves the list",
      );
    });
  } finally {
    clearToday();
  }
});

test("G-UAT-1: Complete is hidden without grow.activities.manage and on a card with no commitment", async () => {
  const entitled = installToday(commitmentCard(), ["grow.contacts.read"]);
  try {
    await withVite("guat1", todayMocks, async (vite) => {
      const { GrowToday } = (await vite.ssrLoadModule(
        "/src/pages/Grow.tsx",
      )) as {
        GrowToday: (props: Record<string, unknown>) => unknown;
      };
      const hidden = renderToday(entitled.hooks, GrowToday);
      assert.equal(
        button(hidden, "Complete"),
        undefined,
        "the same entitlement Contact 360 requires",
      );
      assert.equal(
        button(hidden, "Reschedule"),
        undefined,
        "Reschedule uses the same commitment-write key",
      );
      assert.ok(
        button(hidden, "View contact"),
        "reading the contact is still offered",
      );
      assert.equal(button(hidden, "Add note"), undefined);

      clearToday();
      const followUp = installToday(
        commitmentCard({
          id: "opportunity:4",
          type: "opportunity_follow_up",
          commitmentId: null,
          opportunityId: 4,
          contactName: "Olive Owner",
          availableActions: [
            { action: "add_note" },
            { action: "update_next_action", opportunityId: 4 },
            { action: "view_contact", partyId: 12 },
          ],
        }),
        [
          "grow.activities.manage",
          "grow.opportunities.manage",
          "grow.contacts.read",
        ],
      );
      const other = renderToday(followUp.hooks, GrowToday);
      assert.equal(
        button(other, "Complete"),
        undefined,
        "Complete is keyed off the commitment id",
      );
      assert.equal(
        button(other, "Reschedule"),
        undefined,
        "Reschedule is keyed off the commitment id",
      );
      assert.ok(button(other, "Set due follow-up"));
      clearToday();
    });
  } finally {
    clearToday();
  }
});

test("G-UAT-1: a failed Complete shows Contact 360's error sentence and does not refresh Today", async () => {
  const { hooks, calls, invalidated, pending, mutations } = installToday(
    commitmentCard(),
    ["grow.activities.manage"],
  );
  try {
    await withVite("guat1", todayMocks, async (vite) => {
      const { GrowToday } = (await vite.ssrLoadModule(
        "/src/pages/Grow.tsx",
      )) as {
        GrowToday: (props: Record<string, unknown>) => unknown;
      };
      renderToday(hooks, GrowToday);
      const commitmentIndex = mutations.findIndex((mutation) =>
        mutation.mutationFn.toString().includes("/grow/contacts/commitments/"),
      );
      assert.ok(commitmentIndex >= 0, "Today reuses the commitment PATCH");

      (
        globalThis as { __guat1MutationErrors: unknown[] }
      ).__guat1MutationErrors[commitmentIndex] = new FakeApiError(
        409,
        "That commitment is already completed.",
      );
      const failed = renderToday(hooks, GrowToday);
      assert.match(textContent(failed), /That commitment is already completed/);
      assert.equal(
        button(failed, "Complete")?.props?.disabled,
        false,
        "the control stays so the agent can retry",
      );

      (
        globalThis as { __guat1MutationErrors: unknown[] }
      ).__guat1MutationErrors[commitmentIndex] = new Error("socket hang up");
      const bare = renderToday(hooks, GrowToday);
      const bareText = textContent(bare);
      assert.match(bareText, /Something went wrong\. Try again\./);
      assert.equal(bareText.includes("socket hang up"), false);
      assert.equal(bareText.includes("undefined"), false);

      (globalThis as { __guat1FetchFailure?: unknown }).__guat1FetchFailure =
        new Error("nope");
      (
        globalThis as { __guat1MutationErrors: unknown[] }
      ).__guat1MutationErrors[commitmentIndex] = null;
      const retry = renderToday(hooks, GrowToday);
      (button(retry, "Complete")!.props!.onClick as () => void)();
      await Promise.all(pending);
      assert.equal(calls.length, 1, "the PATCH was attempted");
      assert.equal(
        invalidated.length,
        0,
        "a failed PATCH does not refresh Today",
      );
    });
  } finally {
    clearToday();
  }
});

const importMocks: Plugin = {
  name: "guat1-import-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:guat1i-react")
      return "\0guat1i-react";
    if (
      source === "react/jsx-dev-runtime" ||
      source === "react/jsx-runtime" ||
      source === "virtual:guat1i-jsx"
    )
      return "\0guat1i-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:guat1i-query")
      return "\0guat1i-query";
    if (source === "wouter" || source === "virtual:guat1i-wouter")
      return "\0guat1i-wouter";
    if (source === "../lib/api") return "\0guat1i-api";
    return null;
  },
  load(id) {
    if (id === "\0guat1i-react") {
      return `
        export const useState = (...args) => globalThis.__guat1iHooks.useState(...args);
        export const useEffect = (...args) => globalThis.__guat1iHooks.useEffect(...args);
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0guat1i-jsx") {
      return `
        export const Fragment = Symbol.for("guat1i-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0guat1i-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries() {} });
        export const useQuery = (options) => {
          const key = JSON.stringify(options.queryKey);
          const table = globalThis.__guat1iQueries;
          if (table && Object.prototype.hasOwnProperty.call(table, key)) return table[key];
          return { isLoading: true, isError: false, data: undefined, refetch() {} };
        };
        export const useMutation = (options) => ({
          isPending: globalThis.__guat1iPendingFlag === true,
          isError: false,
          error: null,
          mutate(input) {
            globalThis.__guat1iLastMutation = () => options.mutationFn(input);
          },
        });
      `;
    }
    if (id === "\0guat1i-wouter") {
      return `export const Link = (props) => ({ type: "a", props });`;
    }
    if (id === "\0guat1i-api") {
      return `
        export class ApiError extends Error {}
        export const apiFetch = (path, init) => {
          globalThis.__guat1iFetch = { path, init };
          return Promise.resolve({});
        };
        export function apiErrorMessage(error, fallback) {
          return fallback;
        }
      `;
    }
    return null;
  },
};

function reviewJob() {
  return {
    id: 7,
    filename: "contacts.csv",
    sourceFileType: "csv",
    status: "REVIEW_REQUIRED",
    mapping: { Email: "person.email" },
    totalRows: 2,
    processedRows: 2,
    validRows: 2,
    warningRows: 0,
    rejectedRows: 0,
    duplicateCandidates: 2,
    contactsCreated: 0,
    contactsUpdated: 0,
    propertiesCreated: 0,
    propertiesUpdated: 0,
    relationshipsCreated: 0,
    uploadedAt: "2026-09-24T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    failureReason: null,
  };
}

function duplicate(
  kind: "contact" | "property",
  groupKey: string,
  candidateIds: number[],
) {
  return {
    kind,
    groupKey,
    matches: candidateIds.map((candidateId, index) => ({
      candidateId,
      matchType: index === 0 ? "exact" : "probable",
      matchedOn: kind === "contact" ? ["email"] : ["address"],
      score: index === 0 ? 100 : 80,
    })),
    suggestedResolution:
      candidateIds.length === 1 ? "use_existing" : "create_new",
    requiresDecision: candidateIds.length !== 1,
  };
}

function preview(contactIds: number[], propertyIds: number[]) {
  return {
    summary: {
      totalRows: 2,
      validRows: 2,
      warningRows: 0,
      errorRows: 0,
      contactsTotal: 1,
      contactsNew: 0,
      contactsMatchedExact: 1,
      contactsMatchedProbable: 0,
      contactsMatchedPossible: 0,
      propertiesTotal: propertyIds.length > 0 ? 1 : 0,
      propertiesNew: 0,
      propertiesMatchedExact: 0,
      propertiesMatchedProbable: 0,
      propertiesMatchedPossible: 0,
      relationshipsTotal: 0,
      relationshipsPendingReview: 0,
      duplicatesRequiringReview: 1,
    },
    contactDuplicates: [duplicate("contact", "c-1", contactIds)],
    propertyDuplicates:
      propertyIds.length > 0 ? [duplicate("property", "p-1", propertyIds)] : [],
    contactGroupInfo: {
      "c-1": { sourceRowNumbers: [3], displayName: "Ada Lovelace" },
    },
    propertyGroupInfo: {
      "p-1": { sourceRowNumbers: [4], displayName: "12 Example St" },
    },
  };
}

function ready(data: unknown) {
  return { isLoading: false, isError: false, data, refetch() {} };
}

function installImport(contactIds: number[], propertyIds: number[]) {
  const hooks = createHarness();
  const job = reviewJob();
  Object.assign(globalThis, {
    __guat1iHooks: hooks,
    __guat1iPendingFlag: false,
    __guat1iLastMutation: undefined,
    __guat1iFetch: undefined,
    __guat1iQueries: {
      [JSON.stringify(["grow-access"])]: ready({ entitled: true }),
      [JSON.stringify(["import-jobs"])]: ready({ jobs: [job] }),
      [JSON.stringify(["import-job", job.id])]: ready({ job }),
      [JSON.stringify(["import-preview", job.id])]: ready(
        preview(contactIds, propertyIds),
      ),
    },
  });
  return hooks;
}

function clearImport() {
  for (const key of [
    "__guat1iHooks",
    "__guat1iPendingFlag",
    "__guat1iLastMutation",
    "__guat1iFetch",
    "__guat1iQueries",
  ]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

async function openReview(
  vite: ViteDevServer,
  hooks: ReturnType<typeof createHarness>,
) {
  const page = (await vite.ssrLoadModule("/src/pages/GrowImport.tsx")) as {
    default: () => unknown;
  };
  hooks.beginRender();
  const history = page.default();
  const open = button(history, "Open");
  assert.ok(open, "import history offers Open");
  (open.props!.onClick as () => void)();
  hooks.truncate(2);
  hooks.beginRender();
  return page.default();
}

function row(tree: unknown, name: string): ElementNode | undefined {
  return findAll(
    tree,
    (element) =>
      element.props?.className === "stack dup-row" &&
      textContent(element).includes(name),
  )[0];
}

async function postedResolution() {
  const run = (globalThis as { __guat1iLastMutation?: () => Promise<unknown> })
    .__guat1iLastMutation;
  assert.equal(typeof run, "function");
  await run!();
  const fetch = (
    globalThis as {
      __guat1iFetch?: {
        path: string;
        init: { method?: string; body?: string };
      };
    }
  ).__guat1iFetch;
  assert.ok(fetch);
  return {
    path: fetch.path,
    method: fetch.init.method,
    body: JSON.parse(fetch.init.body ?? "{}") as Record<string, unknown>,
  };
}

test("G-UAT-1: Merge sends merge with the selected candidate and describes the fill-gap write", async () => {
  const hooks = installImport([15, 16], [21]);
  try {
    await withVite("guat1i", importMocks, async (vite) => {
      let review = await openReview(vite, hooks);
      const contact = row(review, "Ada Lovelace");
      const property = row(review, "12 Example St");
      assert.ok(contact, "the contact duplicate row is rendered");
      assert.ok(property, "the property duplicate row is rendered");

      assert.deepEqual(buttons(contact).slice(0, 3), [
        "Use existing",
        "Create new",
        "Skip",
      ]);
      assert.ok(button(contact, "Merge"));
      assert.match(
        textContent(contact),
        /Merge fills empty first name, last name, email, mobile, and address on the existing contact from this import row\. A field that already has a value is never overwritten\./,
      );
      assert.match(
        textContent(property),
        /Merge fills empty suburb, state, and postcode on the existing property from this import row\. A field that already has a value is never overwritten\./,
      );

      (button(contact, "Merge")!.props!.onClick as () => void)();
      const merged = await postedResolution();
      assert.equal(merged.path, "/import/jobs/7/resolve");
      assert.equal(merged.method, "POST");
      assert.deepEqual(merged.body, {
        kind: "contact",
        groupKey: "c-1",
        resolution: "merge",
        candidateId: 15,
      });

      const select = findAll(
        contact,
        (element) => element.type === "select",
      )[0];
      assert.ok(select);
      (select.props!.onChange as (event: unknown) => void)({
        target: { value: "16" },
      });
      hooks.beginRender();
      const page = (await vite.ssrLoadModule("/src/pages/GrowImport.tsx")) as {
        default: () => unknown;
      };
      review = page.default();
      const chosen = row(review, "Ada Lovelace");
      assert.ok(chosen);
      (button(chosen, "Merge")!.props!.onClick as () => void)();
      const rematched = await postedResolution();
      assert.deepEqual(rematched.body, {
        kind: "contact",
        groupKey: "c-1",
        resolution: "merge",
        candidateId: 16,
      });

      (
        button(row(review, "12 Example St"), "Merge")!.props!
          .onClick as () => void
      )();
      const propertyMerge = await postedResolution();
      assert.deepEqual(propertyMerge.body, {
        kind: "property",
        groupKey: "p-1",
        resolution: "merge",
        candidateId: 21,
      });
    });
  } finally {
    clearImport();
  }
});

test("G-UAT-1: Use existing, Create new, and Skip are unchanged, and Merge needs a candidate", async () => {
  const hooks = installImport([15], []);
  try {
    await withVite("guat1i", importMocks, async (vite) => {
      const review = await openReview(vite, hooks);
      const contact = row(review, "Ada Lovelace");
      assert.ok(contact);
      assert.equal(button(contact, "Use existing")?.props?.disabled, false);
      assert.equal(button(contact, "Create new")?.props?.disabled, false);
      assert.equal(button(contact, "Skip")?.props?.disabled, false);
      assert.equal(
        button(contact, "Use existing")?.props?.className,
        "btn btn-secondary btn-small",
      );
      assert.equal(
        button(contact, "Create new")?.props?.className,
        "btn btn-secondary btn-small",
      );
      assert.equal(
        button(contact, "Skip")?.props?.className,
        "btn btn-link btn-small",
      );

      (button(contact, "Use existing")!.props!.onClick as () => void)();
      assert.deepEqual((await postedResolution()).body, {
        kind: "contact",
        groupKey: "c-1",
        resolution: "use_existing",
        candidateId: 15,
      });

      (button(contact, "Create new")!.props!.onClick as () => void)();
      const created = await postedResolution();
      assert.equal(created.body.resolution, "create_new");
      assert.equal(
        Object.prototype.hasOwnProperty.call(created.body, "candidateId"),
        false,
      );

      (button(contact, "Skip")!.props!.onClick as () => void)();
      const skipped = await postedResolution();
      assert.equal(skipped.body.resolution, "skip");
      assert.equal(
        Object.prototype.hasOwnProperty.call(skipped.body, "candidateId"),
        false,
      );
    });
  } finally {
    clearImport();
  }
});

test("G-UAT-1: Merge stays disabled when no candidate is selected, same as Use existing", async () => {
  const hooks = installImport([], []);
  try {
    await withVite("guat1i", importMocks, async (vite) => {
      const review = await openReview(vite, hooks);
      const contact = row(review, "Ada Lovelace");
      assert.ok(contact);
      assert.equal(
        findAll(contact, (element) => element.type === "select").length,
        0,
      );
      assert.equal(button(contact, "Merge")?.props?.disabled, true);
      assert.equal(button(contact, "Use existing")?.props?.disabled, true);
      assert.equal(button(contact, "Create new")?.props?.disabled, false);
      assert.equal(button(contact, "Skip")?.props?.disabled, false);

      (button(contact, "Create new")!.props!.onClick as () => void)();
      assert.equal((await postedResolution()).body.resolution, "create_new");
    });
  } finally {
    clearImport();
  }
});
