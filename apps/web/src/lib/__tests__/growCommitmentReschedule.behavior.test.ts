import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

// G-UAT-4 — Reschedule on Grow Today and Contact 360. Both surfaces share
// PATCH /grow/contacts/commitments/:id. The control is hidden without
// grow.activities.manage. A failure shows the plain sentence and does not
// refresh the list.

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
  return findAll(tree, (element) => element.type === "button" && textContent(element).trim() === label)[0];
}

function byId(tree: unknown, id: string): ElementNode | undefined {
  return findAll(tree, (element) => element.props?.id === id)[0];
}

function form(tree: unknown): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "form")[0];
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

const mocks: Plugin = {
  name: "guat4-reschedule-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:guat4-react") return "\0guat4-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:guat4-jsx") return "\0guat4-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:guat4-query") return "\0guat4-query";
    if (source === "wouter" || source === "virtual:guat4-wouter") return "\0guat4-wouter";
    if (source === "../lib/api") return "\0guat4-api";
    if (source === "../lib/session") return "\0guat4-session";
    if (
      source === "../components/AskAgentEngine" ||
      source === "../components/CommunicationsSection" ||
      source === "../components/PropertyIntelligencePanel" ||
      source === "../components/GrowContactTranscriptPanel" ||
      source === "../components/GrowContactConsentPanel" ||
      source === "../components/GrowPendingCommitmentProposals" ||
      source === "../components/ErrorBoundary"
    ) {
      return "\0guat4-components";
    }
    return null;
  },
  load(id) {
    if (id === "\0guat4-react") {
      return `
        export const useState = (...args) => globalThis.__guat4Hooks.useState(...args);
        export const useEffect = (...args) => globalThis.__guat4Hooks.useEffect(...args);
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0guat4-jsx") {
      return `
        export const Fragment = Symbol.for("guat4-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0guat4-query") {
      return `
        export const useQueryClient = () => ({
          invalidateQueries: (filter) => globalThis.__guat4Invalidated.push(filter && filter.queryKey),
        });
        export const useQuery = () => globalThis.__guat4Query;
        export const useMutation = (options) => {
          const index = globalThis.__guat4MutationCursor++;
          globalThis.__guat4Mutations[index] = options;
          const error = globalThis.__guat4MutationErrors[index] ?? null;
          return {
            isPending: false,
            isError: error != null,
            error,
            mutate(input) {
              globalThis.__guat4Pending.push(
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
    if (id === "\0guat4-wouter") {
      return `export const Link = (props) => ({ type: "a", props }); export const useSearch = () => "";`;
    }
    if (id === "\0guat4-api") {
      return `
        export const ApiError = globalThis.__guat4ApiError;
        export const apiFetch = (path, options) => globalThis.__guat4ApiFetch(path, options);
        export function apiErrorMessage(error, fallback) {
          if (error instanceof ApiError && typeof error.friendly === "string" && error.friendly.trim()) return error.friendly;
          return fallback;
        }
      `;
    }
    if (id === "\0guat4-session") {
      return `
        export const useSession = () => ({ user: { id: 1, firstName: "Sam", role: "Agent" } });
        export const useEntitlements = () => ({
          isLoading: false,
          hasEntitlement: (key) => globalThis.__guat4Entitlements.includes(key),
        });
      `;
    }
    if (id === "\0guat4-components") {
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
    reason: "Open commitment was due 28 Sep 2026. Promised: Call Casey.",
    recommendedAction: "Call Casey.",
    dueAt: "2026-09-28T00:00:00.000Z",
    lastActivityAt: null,
    availableActions: [{ action: "add_note" }, { action: "view_contact", partyId: 12 }, { action: "ask_ae" }],
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
      generatedAt: "2026-09-30T01:00:00.000Z",
      hasAnyGrowData: true,
      counts: { priorityActions: 1, followUpsDue: 1, openOpportunities: 0, contactsNeedingAttention: 1 },
      priorityActions: [card],
      signalSummary: { surfaced: 0, emergingSurfaced: 0, emergingWithheld: 0, withheldDoNotContact: 0 },
    },
  };
}

function install(entitlements: string[], query: unknown) {
  const hooks = createHarness();
  const calls: Call[] = [];
  const invalidated: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const mutations: Array<{ mutationFn: (input: unknown) => Promise<unknown> }> = [];
  Object.assign(globalThis, {
    __guat4Hooks: hooks,
    __guat4ApiError: FakeApiError,
    __guat4Query: query,
    __guat4Entitlements: entitlements,
    __guat4Invalidated: invalidated,
    __guat4Pending: pending,
    __guat4Mutations: mutations,
    __guat4MutationCursor: 0,
    __guat4MutationErrors: [] as unknown[],
    __guat4ApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, options });
      const failure = (globalThis as { __guat4FetchFailure?: unknown }).__guat4FetchFailure;
      if (failure) return Promise.reject(failure);
      return Promise.resolve({});
    },
  });
  return { hooks, calls, invalidated, pending, mutations };
}

function clearGlobals() {
  for (const key of [
    "__guat4Hooks",
    "__guat4ApiError",
    "__guat4Query",
    "__guat4Entitlements",
    "__guat4Invalidated",
    "__guat4Pending",
    "__guat4Mutations",
    "__guat4MutationCursor",
    "__guat4MutationErrors",
    "__guat4ApiFetch",
    "__guat4FetchFailure",
  ]) {
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
        { find: /^react$/, replacement: "virtual:guat4-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:guat4-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:guat4-query" },
        { find: /^wouter$/, replacement: "virtual:guat4-wouter" },
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

function renderToday(hooks: ReturnType<typeof createHarness>, GrowToday: (props: Record<string, unknown>) => unknown) {
  (globalThis as { __guat4MutationCursor: number }).__guat4MutationCursor = 0;
  hooks.beginRender();
  return GrowToday({
    onAskAE: () => {},
    onViewContact: () => {},
    onEmailContact: () => {},
    onSmsContact: () => {},
  });
}

const PLAIN_ERRORS: Array<{ status: number; friendly: string }> = [
  { status: 400, friendly: "dueAt must be a valid ISO timestamp" },
  { status: 404, friendly: "That couldn't be found — it may have been removed." },
  { status: 403, friendly: "You don't have permission to do that — ask a Brokerage Administrator." },
];

async function submitReschedule(tree: unknown, hooks: ReturnType<typeof createHarness>, render: () => unknown, inputId: string) {
  (button(tree, "Reschedule")!.props!.onClick as () => void)();
  tree = render();
  const input = byId(tree, inputId);
  assert.equal(input?.props?.type, "datetime-local");
  (input!.props!.onChange as (event: { target: { value: string } }) => void)({ target: { value: "2026-10-02T09:30" } });
  tree = render();
  await (form(tree)!.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
  return tree;
}

describe("G-UAT-4 commitment reschedule", { concurrency: 1 }, () => {
  test("Grow Today Reschedule is hidden without grow.activities.manage", async () => {
    const { hooks } = install(["grow.contacts.read"], todayQuery(commitmentCard()));
    try {
      await withVite(async (vite) => {
        const { GrowToday } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
          GrowToday: (props: Record<string, unknown>) => unknown;
        };
        const hidden = renderToday(hooks, GrowToday);
        assert.equal(button(hidden, "Reschedule"), undefined);
        assert.equal(button(hidden, "Complete"), undefined);
        assert.ok(button(hidden, "View contact"));
      });
    } finally {
      clearGlobals();
    }
  });

  test("Grow Today Reschedule patches dueAt and refreshes Today", async () => {
    const { hooks, calls, invalidated, pending } = install(["grow.activities.manage"], todayQuery(commitmentCard()));
    try {
      await withVite(async (vite) => {
        const { GrowToday } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
          GrowToday: (props: Record<string, unknown>) => unknown;
        };
        const render = () => renderToday(hooks, GrowToday);
        let tree = render();
        assert.ok(button(tree, "Reschedule"));
        assert.ok(button(tree, "Complete"));
        assert.equal(button(tree, "Cancel"), undefined, "Cancel stays on Contact 360");

        tree = await submitReschedule(tree, hooks, render, "grow-today-commitment-9-due");
        await Promise.all(pending);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].path, "/grow/contacts/commitments/9");
        assert.equal(calls[0].options?.method, "PATCH");
        assert.deepEqual(JSON.parse(calls[0].options!.body!), {
          dueAt: new Date("2026-10-02T09:30").toISOString(),
        });
        assert.ok(
          invalidated.some((key) => Array.isArray(key) && key.length === 1 && key[0] === "grow-today"),
          "Today is invalidated so the card can leave Overdue",
        );
      });
    } finally {
      clearGlobals();
    }
  });

  test("Grow Today shows plain messages for 400, 404 and 403 and does not refresh on failure", async () => {
    const { hooks, calls, invalidated, pending, mutations } = install(["grow.activities.manage"], todayQuery(commitmentCard()));
    try {
      await withVite(async (vite) => {
        const { GrowToday } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
          GrowToday: (props: Record<string, unknown>) => unknown;
        };
        const render = () => renderToday(hooks, GrowToday);
        render();
        const commitmentIndex = mutations.findIndex((mutation) => mutation.mutationFn.toString().includes("/grow/contacts/commitments/"));
        assert.ok(commitmentIndex >= 0);

        for (const failure of PLAIN_ERRORS) {
          (globalThis as { __guat4MutationErrors: unknown[] }).__guat4MutationErrors[commitmentIndex] = new FakeApiError(
            failure.status,
            failure.friendly,
          );
          const tree = render();
          const text = textContent(tree);
          assert.match(text, new RegExp(failure.friendly.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          assert.equal(text.includes("Not entitled"), false);
          assert.equal(text.includes("undefined"), false);
          assert.equal(text.includes(String(failure.status)), false);
        }

        (globalThis as { __guat4MutationErrors: unknown[] }).__guat4MutationErrors[commitmentIndex] = null;
        (globalThis as { __guat4FetchFailure?: unknown }).__guat4FetchFailure = new FakeApiError(400, "dueAt must be a valid ISO timestamp");
        const retry = render();
        await submitReschedule(retry, hooks, render, "grow-today-commitment-9-due");
        await Promise.all(pending);
        assert.equal(calls.length, 1);
        assert.equal(invalidated.length, 0, "a failed reschedule does not refresh Today");
      });
    } finally {
      clearGlobals();
    }
  });

  test("Contact 360 Reschedule is hidden without the key and on a closed commitment", async () => {
    const denied = install(["grow.contacts.read"], null);
    try {
      await withVite(async (vite) => {
        const { GrowContactCommitmentsList } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
          GrowContactCommitmentsList: (props: Record<string, unknown>) => unknown;
        };
        denied.hooks.beginRender();
        const hidden = GrowContactCommitmentsList({
          commitments: [openCommitment()],
          canManageActivities: false,
          onChanged: () => {},
        });
        assert.equal(button(hidden, "Reschedule"), undefined);
        assert.equal(button(hidden, "Complete"), undefined);
        assert.equal(button(hidden, "Cancel"), undefined);

        clearGlobals();
        const allowed = install(["grow.activities.manage"], null);
        allowed.hooks.beginRender();
        const closed = GrowContactCommitmentsList({
          commitments: [
            openCommitment(),
            { ...openCommitment(), id: 10, status: "Completed", description: "Done" },
            { ...openCommitment(), id: 11, status: "Cancelled", description: "Dropped" },
          ],
          canManageActivities: true,
          onChanged: () => {},
        });
        assert.equal(findAll(closed, (element) => element.type === "button" && textContent(element).trim() === "Reschedule").length, 1);
        assert.ok(button(closed, "Complete"));
        assert.ok(button(closed, "Cancel"));
      });
    } finally {
      clearGlobals();
    }
  });

  test("Contact 360 Reschedule patches dueAt, refreshes the contact and Today, and shows plain errors", async () => {
    const { hooks, calls, invalidated, pending, mutations } = install(["grow.activities.manage"], null);
    let changed = 0;
    try {
      await withVite(async (vite) => {
        const { GrowContactCommitmentsList } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
          GrowContactCommitmentsList: (props: Record<string, unknown>) => unknown;
        };
        const render = () => {
          (globalThis as { __guat4MutationCursor: number }).__guat4MutationCursor = 0;
          hooks.beginRender();
          return GrowContactCommitmentsList({
            commitments: [openCommitment()],
            canManageActivities: true,
            onChanged: () => {
              changed += 1;
            },
          });
        };

        let tree = render();
        tree = await submitReschedule(tree, hooks, render, "grow-contact-commitment-9-due");
        await Promise.all(pending);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].path, "/grow/contacts/commitments/9");
        assert.equal(calls[0].options?.method, "PATCH");
        assert.deepEqual(JSON.parse(calls[0].options!.body!), {
          dueAt: new Date("2026-10-02T09:30").toISOString(),
        });
        assert.equal(changed, 1, "Contact 360 refetches the contact");
        assert.ok(
          invalidated.some((key) => Array.isArray(key) && key.length === 1 && key[0] === "grow-today"),
          "Today is invalidated so the commitment can leave Overdue",
        );

        const commitmentIndex = mutations.findIndex((mutation) => mutation.mutationFn.toString().includes("/grow/contacts/commitments/"));
        assert.ok(commitmentIndex >= 0);
        for (const failure of PLAIN_ERRORS) {
          (globalThis as { __guat4MutationErrors: unknown[] }).__guat4MutationErrors[commitmentIndex] = new FakeApiError(
            failure.status,
            failure.friendly,
          );
          const failed = render();
          const text = textContent(failed);
          assert.match(text, new RegExp(failure.friendly.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          assert.equal(text.includes("Not entitled"), false);
          assert.equal(text.includes("undefined"), false);
        }
      });
    } finally {
      clearGlobals();
    }
  });
});

function openCommitment() {
  return {
    id: 9,
    description: "Call Casey",
    dueAt: "2026-09-28T00:00:00.000Z",
    status: "Open",
    propertyId: null,
    opportunityId: null,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
  };
}
