import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

// Stage F4.3 component-behaviour tests, same harness as
// GrowContactTranscriptPanel.behavior.test.ts: React, React Query, wouter
// and the API client are replaced with tiny in-memory fakes so the real
// component functions run under node without a DOM.

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

function byId(tree: unknown, id: string): ElementNode | undefined {
  return findAll(tree, (element) => element.props?.id === id)[0];
}

class FakeApiError extends Error {
  status: number;
  friendly: string;
  reason?: string;
  code?: string;
  sideEffectApplied?: boolean;
  constructor(status: number, friendly: string, technical?: string, reason?: string, extras?: { code?: string; sideEffectApplied?: boolean }) {
    super(technical ?? friendly);
    this.status = status;
    this.friendly = friendly;
    this.reason = reason;
    this.code = extras?.code;
    this.sideEffectApplied = extras?.sideEffectApplied;
  }
}

type Call = { path: string; options?: { method?: string; body?: string } };

function createHarness() {
  const state: unknown[] = [];
  const effectDeps: unknown[][] = [];
  let stateCursor = 0;
  let effectCursor = 0;
  const hooks = {
    reset() {
      state.length = 0;
      effectDeps.length = 0;
    },
    beginRender() {
      stateCursor = 0;
      effectCursor = 0;
    },
    useState(initial: unknown) {
      const index = stateCursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [state[index], (next: unknown) => {
        state[index] = typeof next === "function" ? (next as (current: unknown) => unknown)(state[index]) : next;
      }];
    },
    useEffect(effect: () => void, deps: unknown[]) {
      const index = effectCursor++;
      const previous = effectDeps[index];
      if (!previous || deps.some((dependency, dependencyIndex) => dependency !== previous[dependencyIndex])) {
        effectDeps[index] = deps;
        effect();
      }
    },
  };
  return hooks;
}

const virtualMocks: Plugin = {
  name: "followups-behavior-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:fu-test-react") return "\0fu-test-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:fu-test-jsx") return "\0fu-test-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:fu-test-query") return "\0fu-test-query";
    if (source === "wouter" || source === "virtual:fu-test-wouter") return "\0fu-test-wouter";
    if (source.endsWith("/lib/api") || source === "../lib/api") return "\0fu-test-api";
    return null;
  },
  load(id) {
    if (id === "\0fu-test-react") {
      return `
        export const useState = (...args) => globalThis.__fuHooks.useState(...args);
        export const useEffect = (...args) => globalThis.__fuHooks.useEffect(...args);
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0fu-test-jsx") {
      return `
        export const Fragment = Symbol.for("fu-test-fragment");
        export const jsx = (type, props, key) => ({ type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0fu-test-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries: (filter) => globalThis.__fuInvalidated.push(filter.queryKey) });
        export const useQuery = () => globalThis.__fuQuery;
        export const useMutation = (options) => ({
          isPending: false,
          isError: false,
          error: null,
          mutate(input) {
            globalThis.__fuPending.push(
              Promise.resolve(options.mutationFn(input)).then(
                (result) => { options.onSuccess?.(result, input); options.onSettled?.(result, null, input); },
                (error) => { options.onError?.(error, input); options.onSettled?.(undefined, error, input); },
              ),
            );
          },
        });
      `;
    }
    if (id === "\0fu-test-wouter") {
      return `export const Link = (props) => ({ type: "a", props });`;
    }
    if (id === "\0fu-test-api") {
      return `
        export const ApiError = globalThis.__fuApiError;
        export const apiFetch = (path, options) => globalThis.__fuApiFetch(path, options);
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
        { find: /^react$/, replacement: "virtual:fu-test-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:fu-test-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:fu-test-query" },
        { find: /^wouter$/, replacement: "virtual:fu-test-wouter" },
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

const candidateFixture = (overrides: Record<string, unknown> = {}) => ({
  itemType: "COMMITMENT",
  itemId: "c-1",
  text: "Send the appraisal pack",
  suggestedDueAt: "2026-10-01T00:00:00.000Z",
  consentBlocked: false,
  existingProposal: { visibility: "NONE" },
  latestProposalStatus: null,
  canPropose: true,
  ...overrides,
});

test("follow-ups: pre-filled date alone never enables proposing; only an explicit confirm + click POSTs the strict body", async () => {
  const hooks = createHarness();
  const calls: Call[] = [];
  const invalidated: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  Object.assign(globalThis, {
    __fuHooks: hooks,
    __fuApiError: FakeApiError,
    __fuInvalidated: invalidated,
    __fuPending: pending,
    __fuQuery: {
      isLoading: false,
      isError: false,
      data: {
        callSessionId: 81,
        transcriptionId: 71,
        partyId: 12,
        consentBlocked: false,
        candidates: [candidateFixture(), candidateFixture({ itemType: "FOLLOWUP", itemId: "f-1", text: "Call back Friday", suggestedDueAt: null })],
      },
    },
    __fuApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, options });
      return Promise.resolve({
        proposals: [{
          itemType: "COMMITMENT",
          itemId: "c-1",
          status: "PROPOSED",
          actionRequest: {
            actionRequestId: 900,
            status: "AWAITING_APPROVAL",
            dueAt: "2026-10-01T00:00:00.000Z",
            description: "Send the appraisal pack",
            proposedByUserId: 7,
            createdAt: "2026-09-19T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        }],
      });
    },
  });
  try {
    await withVite(async (vite) => {
      const { GrowCallFollowupsSection } = await vite.ssrLoadModule("/src/components/GrowCallFollowupsSection.tsx") as {
        GrowCallFollowupsSection: (props: Record<string, unknown>) => unknown;
      };
      const render = () => {
        hooks.beginRender();
        return GrowCallFollowupsSection({ callSessionId: 81, transcriptionId: 71, partyId: 12, contactName: "Jo Citizen" });
      };
      render(); // effect seeds drafts
      let tree = render();
      assert.equal(calls.length, 0, "rendering never proposes anything");

      const due = byId(tree, "grow-followup-71-COMMITMENT-c-1-due")!;
      assert.equal(due.props!.value, "2026-10-01", "suggested date is pre-filled");
      assert.equal(due.props!.type, "date");
      assert.ok(due.props!["aria-label"], "date input is labelled");
      const confirm = byId(tree, "grow-followup-71-COMMITMENT-c-1-confirm")!;
      assert.equal(confirm.props!.checked, false, "a pre-filled date is not pre-confirmed");

      (byId(tree, "grow-followup-71-COMMITMENT-c-1-select")!.props!.onChange as (event: unknown) => void)({ target: { checked: true } });
      tree = render();
      assert.equal(button(tree, "Propose selected follow-ups")!.props!.disabled, true, "selected + pre-filled but unconfirmed stays disabled");
      (button(tree, "Propose selected follow-ups")!.props!.onClick as () => void)();
      assert.equal(calls.length, 0);

      (byId(tree, "grow-followup-71-COMMITMENT-c-1-confirm")!.props!.onChange as (event: unknown) => void)({ target: { checked: true } });
      tree = render();
      // Changing the date after confirming clears the confirmation.
      (byId(tree, "grow-followup-71-COMMITMENT-c-1-due")!.props!.onChange as (event: unknown) => void)({ target: { value: "2026-10-02" } });
      tree = render();
      assert.equal(byId(tree, "grow-followup-71-COMMITMENT-c-1-confirm")!.props!.checked, false);
      assert.equal(button(tree, "Propose selected follow-ups")!.props!.disabled, true);
      (byId(tree, "grow-followup-71-COMMITMENT-c-1-confirm")!.props!.onChange as (event: unknown) => void)({ target: { checked: true } });
      tree = render();
      assert.equal(button(tree, "Propose selected follow-ups")!.props!.disabled, false);

      (button(tree, "Propose selected follow-ups")!.props!.onClick as () => void)();
      await Promise.all(pending);
      assert.equal(calls.length, 1, "exactly one explicit propose call");
      assert.equal(calls[0]!.path, "/grow/calls/81/transcription/71/followups/propose");
      assert.equal(calls[0]!.options!.method, "POST");
      assert.deepEqual(JSON.parse(calls[0]!.options!.body!), {
        items: [{ itemType: "COMMITMENT", itemId: "c-1", dueAt: "2026-10-02T00:00:00.000Z" }],
      });
      assert.deepEqual(invalidated, [["grow-call-followups"], ["grow-pending-commitments"], ["grow-contact", 12], ["grow-activities"]]);

      tree = render();
      const cards = findAll(tree, (element) => typeof element.type === "function" && (element.type as { name?: string }).name === "GrowCommitmentProposalCard");
      assert.equal(cards.length, 1, "the returned proposal is rendered with the shared review card");
      assert.equal((cards[0]!.props!.proposal as { actionRequestId: number }).actionRequestId, 900);
      assert.equal(calls.length, 1, "no auto-approve or auto-execute after proposing");
      assert.ok(calls.every((call) => !call.path.includes("/commitments")), "never calls the direct commitment route");
    });
  } finally {
    for (const key of ["__fuHooks", "__fuApiError", "__fuInvalidated", "__fuPending", "__fuQuery", "__fuApiFetch"]) {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("follow-ups: consent withdrawn shows the message, hides per-item controls, and disables proposing", async () => {
  const hooks = createHarness();
  const calls: Call[] = [];
  Object.assign(globalThis, {
    __fuHooks: hooks,
    __fuApiError: FakeApiError,
    __fuInvalidated: [],
    __fuPending: [],
    __fuQuery: {
      isLoading: false,
      isError: false,
      data: { callSessionId: 81, transcriptionId: 71, partyId: 12, consentBlocked: true, candidates: [candidateFixture({ consentBlocked: true, canPropose: false })] },
    },
    __fuApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, options });
      return Promise.resolve({});
    },
  });
  try {
    await withVite(async (vite) => {
      const { GrowCallFollowupsSection } = await vite.ssrLoadModule("/src/components/GrowCallFollowupsSection.tsx") as {
        GrowCallFollowupsSection: (props: Record<string, unknown>) => unknown;
      };
      hooks.beginRender();
      GrowCallFollowupsSection({ callSessionId: 81, transcriptionId: 71, partyId: 12, contactName: null });
      hooks.beginRender();
      const tree = GrowCallFollowupsSection({ callSessionId: 81, transcriptionId: 71, partyId: 12, contactName: null });
      assert.match(textContent(tree), /Recording consent for this call was withdrawn/);
      assert.equal(byId(tree, "grow-followup-71-COMMITMENT-c-1-select"), undefined);
      assert.equal(button(tree, "Propose selected follow-ups")!.props!.disabled, true);
      (button(tree, "Propose selected follow-ups")!.props!.onClick as () => void)();
      assert.equal(calls.length, 0);
    });
  } finally {
    for (const key of ["__fuHooks", "__fuApiError", "__fuInvalidated", "__fuPending", "__fuQuery", "__fuApiFetch"]) {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("proposal card: one click approves then executes; COMPLETED_AFTER_RECOVERY never offers a retry", async () => {
  const hooks = createHarness();
  const calls: Call[] = [];
  Object.assign(globalThis, {
    __fuHooks: hooks,
    __fuApiError: FakeApiError,
    __fuApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, options });
      if (path.endsWith("/execute")) {
        return Promise.reject(new FakeApiError(409, "Could not execute this request", undefined, "COMPLETED_AFTER_RECOVERY", { sideEffectApplied: true }));
      }
      return Promise.resolve({ request: { id: 900, status: "APPROVED" } });
    },
  });
  try {
    await withVite(async (vite) => {
      const { GrowCommitmentProposalCard } = await vite.ssrLoadModule("/src/components/GrowCommitmentProposalCard.tsx") as {
        GrowCommitmentProposalCard: (props: Record<string, unknown>) => unknown;
      };
      const settled: unknown[] = [];
      const proposal = {
        actionRequestId: 900,
        summary: "Send the appraisal pack",
        contactName: "Jo Citizen",
        dueAt: "2026-10-01T00:00:00.000Z",
        timeZone: null,
        reason: "Commitment approved in call review",
        evidenceSummary: null,
        status: "AWAITING_APPROVAL",
        expiresAt: new Date(Date.now() + 23.5 * 3_600_000).toISOString(),
        reviewUrl: null,
        provenance: { source: "call_review", transcriptionId: 71, itemType: "COMMITMENT", itemId: "c-1" },
      };
      const render = () => {
        hooks.beginRender();
        return GrowCommitmentProposalCard({ proposal, dismissible: false, onSettled: (state: unknown) => settled.push(state) });
      };
      let tree = render();
      const text = textContent(tree);
      assert.match(text, /From call review/);
      assert.match(text, /Expires in 23h/);
      assert.match(text, /Jo Citizen/);
      assert.equal(button(tree, "Not now"), undefined, "persistent lists hide Not now");
      assert.equal(calls.length, 0, "never acts on mount");

      await (button(tree, "Approve & Create Commitment")!.props!.onClick as () => Promise<void>)();
      assert.deepEqual(calls.map((call) => call.path), ["/ai/actions/requests/900/approve", "/ai/actions/requests/900/execute"]);
      tree = render();
      assert.match(textContent(tree), /may already have been created/);
      assert.equal(button(tree, "Try again"), undefined, "no retry after COMPLETED_AFTER_RECOVERY");
      assert.equal(button(tree, "Approve & Create Commitment"), undefined);
      assert.deepEqual(settled, ["completed_after_recovery"]);
      assert.equal(calls.length, 2, "nothing is retried automatically");
    });
  } finally {
    for (const key of ["__fuHooks", "__fuApiError", "__fuApiFetch"]) {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("proposal card: a 404 shows 'no longer available' and reject sends only the reason", async () => {
  const hooks = createHarness();
  const calls: Call[] = [];
  Object.assign(globalThis, {
    __fuHooks: hooks,
    __fuApiError: FakeApiError,
    __fuApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, options });
      if (path.endsWith("/approve")) return Promise.reject(new FakeApiError(404, "Not found", undefined, "NOT_FOUND"));
      return Promise.resolve({ request: { id: 901, status: "REJECTED" } });
    },
  });
  const proposal = {
    actionRequestId: 901,
    summary: "Call back Friday",
    contactName: null,
    dueAt: null,
    timeZone: null,
    reason: null,
    evidenceSummary: null,
    status: "AWAITING_APPROVAL",
    expiresAt: null,
    reviewUrl: null,
    provenance: null,
  };
  try {
    await withVite(async (vite) => {
      const { GrowCommitmentProposalCard } = await vite.ssrLoadModule("/src/components/GrowCommitmentProposalCard.tsx") as {
        GrowCommitmentProposalCard: (props: Record<string, unknown>) => unknown;
      };
      const render = () => {
        hooks.beginRender();
        return GrowCommitmentProposalCard({ proposal });
      };
      let tree = render();
      // No onSettled passed (the Ask AE usage): the failure must still be shown.
      await (button(tree, "Approve & Create Commitment")!.props!.onClick as () => Promise<void>)();
      tree = render();
      assert.match(textContent(tree), /no longer available/);
      assert.deepEqual(calls.map((call) => call.path), ["/ai/actions/requests/901/approve"], "execute is not attempted after a failed approval");

      // Fresh card: reject with an optional reason.
      hooks.reset();
      calls.length = 0;
      tree = render();
      (button(tree, "Reject")!.props!.onClick as () => void)();
      tree = render();
      (byId(tree, "grow-commitment-reject-reason-901")!.props!.onChange as (event: unknown) => void)({ target: { value: "Already done" } });
      tree = render();
      const form = findAll(tree, (element) => element.type === "form")[0]!;
      (form.props!.onSubmit as (event: unknown) => void)({ preventDefault() {} });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.path, "/ai/actions/requests/901/reject");
      assert.deepEqual(JSON.parse(calls[0]!.options!.body!), { reason: "Already done" });
      tree = render();
      assert.match(textContent(tree), /Rejected\. No commitment was created\./);
    });
  } finally {
    for (const key of ["__fuHooks", "__fuApiError", "__fuApiFetch"]) {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("transcript panel: follow-ups appear only for a saved (APPROVED/PARTIALLY_APPROVED) review", async () => {
  const hooks = createHarness();
  const row = (id: number, processingState: string) => ({
    id,
    callSessionId: 80 + id,
    processingState,
    transcript: "t",
    draftSummary: null,
    draftKeyPoints: [],
    draftCommitments: [],
    draftFollowups: [],
    failureReason: null,
    createdAt: "2026-09-18T00:00:00.000Z",
  });
  const calls: Call[] = [];
  Object.assign(globalThis, {
    __fuHooks: hooks,
    __fuApiError: FakeApiError,
    __fuInvalidated: [],
    __fuPending: [],
    __fuQuery: { isLoading: false, isError: false, data: { transcriptions: [row(1, "APPROVED"), row(2, "AWAITING_AGENT_REVIEW"), row(3, "PARTIALLY_APPROVED")] } },
    __fuApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, options });
      return Promise.resolve({});
    },
  });
  try {
    await withVite(async (vite) => {
      const { GrowContactTranscriptPanel } = await vite.ssrLoadModule("/src/components/GrowContactTranscriptPanel.tsx") as {
        GrowContactTranscriptPanel: (props: Record<string, unknown>) => unknown;
      };
      const render = () => {
        hooks.beginRender();
        return GrowContactTranscriptPanel({ partyId: 12, contactName: "Jo Citizen" });
      };
      const sections = (tree: unknown) =>
        findAll(tree, (element) => typeof element.type === "function" && (element.type as { name?: string }).name === "GrowCallFollowupsSection");
      const rows = (tree: unknown) => findAll(tree, (element) => element.type === "button" && textContent(element).includes("Call transcript"));

      let tree = render();
      assert.equal(sections(tree).length, 0, "nothing until a transcript is opened");
      for (const [index, expected] of [[0, { callSessionId: 81, transcriptionId: 1 }], [1, null], [2, { callSessionId: 83, transcriptionId: 3 }]] as const) {
        (rows(tree)[index]!.props!.onClick as () => void)();
        render();
        tree = render();
        const found = sections(tree);
        if (expected === null) {
          assert.equal(found.length, 0, "a review still awaiting the agent has no follow-ups");
        } else {
          assert.equal(found.length, 1);
          assert.equal(found[0]!.props!.callSessionId, expected.callSessionId);
          assert.equal(found[0]!.props!.transcriptionId, expected.transcriptionId);
          assert.equal(found[0]!.props!.partyId, 12);
          assert.equal(found[0]!.props!.contactName, "Jo Citizen");
        }
      }
      assert.equal(calls.length, 0, "opening transcripts never proposes anything");
    });
  } finally {
    for (const key of ["__fuHooks", "__fuApiError", "__fuInvalidated", "__fuPending", "__fuQuery", "__fuApiFetch"]) {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
