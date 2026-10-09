// GP-5 — Contact 360 hides calling when it is not granted, and Ask AE labels
// mock answers without showing an operator instruction. The coach stays off.

import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { DEMO_AI_LABEL, userVisibleAiText } from "../demoAi";
import { growCallingSurfaces } from "../growCalling";

test("calling surfaces follow grants and explicit off flags", () => {
  const none = {
    entitlementsKnown: true,
    hasEntitlement: (key: string) => key === "grow.access",
  };
  assert.deepEqual(growCallingSurfaces(none), { call: false, transcripts: false });
  assert.deepEqual(
    growCallingSurfaces({ entitlementsKnown: false, hasEntitlement: () => true }),
    { call: false, transcripts: false },
    "a loading session does not start a call request",
  );
  const both = {
    entitlementsKnown: true,
    hasEntitlement: (key: string) => key === "grow.calling.access" || key === "grow.calling.transcription",
  };
  assert.deepEqual(growCallingSurfaces(both), { call: true, transcripts: true });
  assert.deepEqual(growCallingSurfaces({ ...both, callingEnabled: undefined, providerEnabled: undefined }), {
    call: true,
    transcripts: true,
  });
  assert.deepEqual(growCallingSurfaces({ ...both, callingEnabled: false }), { call: false, transcripts: false });
  assert.deepEqual(growCallingSurfaces({ ...both, providerEnabled: false }), { call: false, transcripts: false });
  assert.deepEqual(
    growCallingSurfaces({
      entitlementsKnown: true,
      hasEntitlement: (key: string) => key === "grow.calling.access",
    }),
    { call: true, transcripts: false },
  );
});

test("mock and operator wording becomes the demo label, and a real answer is kept", () => {
  const old =
    "Mock AI Provider. No real model call was made. Set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY in Replit Secrets.";
  assert.equal(userVisibleAiText(old), DEMO_AI_LABEL);
  assert.equal(userVisibleAiText(DEMO_AI_LABEL), DEMO_AI_LABEL);
  assert.equal(userVisibleAiText("Lou has one open appraisal."), "Lou has one open appraisal.");
  assert.equal(
    userVisibleAiText(`Quiet street.\n\n${old}`),
    `${DEMO_AI_LABEL}\n\nQuiet street.`,
  );
  assert.doesNotMatch(userVisibleAiText(old), /AI_PROVIDER/);
});

interface ElementNode {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
}

interface QueryOptions {
  queryKey: unknown[];
  queryFn: () => Promise<unknown>;
  enabled?: boolean;
}

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!node || typeof node !== "object") return "";
  return textContent((node as ElementNode).props?.children);
}

function renderedStrings(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(renderedStrings).join("\n");
  const props = (node as ElementNode).props ?? {};
  return Object.values(props)
    .map((value) => (typeof value === "string" || typeof value === "number" ? String(value) : renderedStrings(value)))
    .join("\n");
}

function findAll(node: unknown, predicate: (element: ElementNode) => boolean): ElementNode[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate));
  if (!node || typeof node !== "object") return [];
  const element = node as ElementNode;
  const own = predicate(element) ? [element] : [];
  return own.concat(findAll(element.props?.children, predicate));
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

const CONTACT = {
  contact: {
    id: 12,
    partyType: "Person",
    firstName: "Jane",
    middleName: null,
    lastName: "Smith",
    organisationName: null,
    displayName: "Jane Smith",
    email: "jane@example.com",
    mobile: "0400000000",
    residentialAddress: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  assignedAgentUserId: null,
  roles: [] as string[],
  householdRelationships: [],
  properties: [],
  opportunities: [],
  activities: [],
  commitments: [],
  timeline: [],
  intelligence: {
    roles: [],
    relatedPropertyCount: 0,
    mostRecentInteractionAt: null,
    daysSinceLastInteraction: null,
    nextFollowUpAt: null,
    nextFollowUpDescription: null,
    activeOpportunityCount: 0,
    recentActivityCount: 0,
    outstandingCommitmentCount: 0,
    relationshipAgeDays: null,
  },
  contactability: {
    evaluatedAt: "2026-01-01T00:00:00.000Z",
    status: "UNKNOWN",
    statusReasonCode: "NONE",
    hasConsentRecords: false,
    awaitingPolicyApproval: false,
    policies: [],
    channels: [],
    activeSuppressions: [],
    history: [],
    historyTruncated: false,
  },
};

const ELIGIBILITY = {
  eligible: true,
  status: "Ready to call",
  reason: "ok",
  displayNumber: "0400 000 000",
  requiresCountryConfirmation: false,
  recording: {
    available: true,
    permitted: true,
    status: "Recording available",
    statusCode: "ok",
    reason: "Allowed",
    provider: "sandbox",
    fiveGateResult: { gates: {} },
  },
};

function queryResult(key: unknown) {
  if (key === "grow-access") {
    return { isLoading: false, isError: false, data: (globalThis as { __gp5Access?: unknown }).__gp5Access, error: null, refetch() {} };
  }
  if (key === "grow-contact") {
    return { isLoading: false, isError: false, data: CONTACT, error: null, refetch() {} };
  }
  if (key === "grow-call-eligibility") {
    return { isLoading: false, isError: false, data: ELIGIBILITY, error: null, refetch() {} };
  }
  if (key === "grow-contact-transcriptions") {
    return { isLoading: false, isError: false, data: { transcriptions: [] }, error: null, refetch() {} };
  }
  if (key === "grow-appraisals") {
    return { isLoading: false, isError: false, data: { appraisals: [] }, error: null, refetch() {} };
  }
  return { isLoading: false, isError: false, data: undefined, error: null, refetch() {} };
}

const contactMocks: Plugin = {
  name: "gp5-contact-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:gp5-react") return "\0gp5-react";
    if (source === "react/jsx-runtime" || source === "react/jsx-dev-runtime" || source === "virtual:gp5-jsx") return "\0gp5-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:gp5-query") return "\0gp5-query";
    if (source === "wouter" || source === "virtual:gp5-wouter") return "\0gp5-wouter";
    if (source === "../lib/api") return "\0gp5-api";
    if (source === "../lib/session") return "\0gp5-session";
    if (
      source === "../components/AskAgentEngine" ||
      source === "../components/CommunicationsSection" ||
      source === "../components/PropertyIntelligencePanel" ||
      source === "../components/GrowContactConsentPanel" ||
      source === "../components/GrowPendingCommitmentProposals" ||
      source === "../components/ErrorBoundary" ||
      source === "../components/GrowContactEditForm"
    ) {
      return "\0gp5-components";
    }
    return null;
  },
  load(id) {
    if (id === "\0gp5-react") {
      return `
        export const useState = (...args) => globalThis.__gp5Hooks.useState(...args);
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0gp5-jsx") {
      return `
        export const Fragment = Symbol.for("gp5-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0gp5-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries() {} });
        export const useQuery = (options) => {
          globalThis.__gp5Queries.push(options);
          if (options && options.enabled === false) {
            return { isLoading: false, isFetching: false, isError: false, data: undefined, error: null, refetch() {} };
          }
          options.queryFn();
          return globalThis.__gp5QueryResult(options.queryKey && options.queryKey[0]);
        };
        export const useMutation = () => ({ isPending: false, isError: false, error: null, mutate() {} });
      `;
    }
    if (id === "\0gp5-wouter") {
      return `export const Link = (props) => ({ type: "a", props }); export const useSearch = () => "";`;
    }
    if (id === "\0gp5-api") {
      return `
        export class ApiError extends Error {
          constructor(status, friendly) { super(friendly); this.status = status; this.friendly = friendly; }
        }
        export const apiFetch = (path) => {
          globalThis.__gp5Calls.push(path);
          return Promise.resolve({});
        };
        export function apiErrorMessage(_error, fallback) { return fallback; }
      `;
    }
    if (id === "\0gp5-session") {
      return `
        export const useSession = () => ({ user: { id: 1, firstName: "Sam", role: "Agent" } });
        export const useEntitlements = () => ({
          isLoading: globalThis.__gp5EntitlementsLoading === true,
          hasEntitlement: (key) => globalThis.__gp5Entitlements.includes(key),
        });
      `;
    }
    if (id === "\0gp5-components") {
      return `
        export const AskAgentEngine = () => null;
        export const ContactCommunicationsSection = () => null;
        export const PropertyIntelligencePanel = () => null;
        export const GrowContactConsentPanel = () => null;
        export const GrowPendingCommitmentProposals = () => null;
        export const ErrorBoundary = (props) => props.children;
        export const GrowContactEditForm = () => null;
      `;
    }
    return null;
  },
};

function installContact(input: { entitlements: string[]; loading?: boolean; access?: Record<string, unknown> }) {
  const hooks = createHarness();
  const calls: string[] = [];
  const queries: QueryOptions[] = [];
  Object.assign(globalThis, {
    __gp5Hooks: hooks,
    __gp5Calls: calls,
    __gp5Queries: queries,
    __gp5QueryResult: queryResult,
    __gp5Entitlements: input.entitlements,
    __gp5EntitlementsLoading: input.loading === true,
    __gp5Access: {
      entitled: true,
      entitlements: input.entitlements,
      billingProviderName: "mock",
      ...input.access,
    },
  });
  return { hooks, calls, queries };
}

function clearContactGlobals() {
  for (const key of [
    "__gp5Hooks",
    "__gp5Calls",
    "__gp5Queries",
    "__gp5QueryResult",
    "__gp5Entitlements",
    "__gp5EntitlementsLoading",
    "__gp5Access",
  ]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

function callingPaths(calls: string[]): string[] {
  return calls.filter((path) => path.includes("/eligibility") || path.includes("/transcriptions") || path.startsWith("/grow/calls"));
}

async function renderContact(input: { entitlements: string[]; loading?: boolean; access?: Record<string, unknown> }) {
  const installed = installContact(input);
  const vite = await createServer({
    root: new URL("../../..", import.meta.url).pathname,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: true },
    resolve: {
      alias: [
        { find: /^react$/, replacement: "virtual:gp5-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:gp5-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:gp5-query" },
        { find: /^wouter$/, replacement: "virtual:gp5-wouter" },
      ],
    },
    plugins: [contactMocks],
  });
  try {
    const { GrowContactDetail } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
      GrowContactDetail: (props: {
        partyId: number;
        onBack: () => void;
        pendingComposeChannel: null;
        onComposeHandled: () => void;
      }) => unknown;
    };
    installed.hooks.beginRender();
    const tree = GrowContactDetail({
      partyId: 12,
      onBack() {},
      pendingComposeChannel: null,
      onComposeHandled() {},
    });
    return { tree, calls: installed.calls };
  } finally {
    await vite.close();
    clearContactGlobals();
  }
}

test("Contact 360 hides calling and does not request it without grants", async () => {
  const hidden = await renderContact({ entitlements: ["grow.access"] });
  const text = textContent(hidden.tree);
  assert.match(text, /Jane Smith/);
  assert.doesNotMatch(text, /Call Jane Smith/);
  assert.doesNotMatch(text, /Review calls before CRM actions/);
  assert.doesNotMatch(text, /plan doesn't include/i);
  assert.deepEqual(callingPaths(hidden.calls), []);
  assert.ok(hidden.calls.includes("/grow/access"));
  assert.ok(hidden.calls.includes("/grow/contacts/12"));

  const loading = await renderContact({
    entitlements: ["grow.access", "grow.calling.access", "grow.calling.transcription"],
    loading: true,
  });
  assert.doesNotMatch(textContent(loading.tree), /Call Jane Smith/);
  assert.deepEqual(callingPaths(loading.calls), []);

  const callingOff = await renderContact({
    entitlements: ["grow.access", "grow.calling.access", "grow.calling.transcription"],
    access: { callingEnabled: false },
  });
  assert.doesNotMatch(textContent(callingOff.tree), /Call Jane Smith/);
  assert.doesNotMatch(textContent(callingOff.tree), /Review calls before CRM actions/);
  assert.deepEqual(callingPaths(callingOff.calls), []);

  const providerOff = await renderContact({
    entitlements: ["grow.access", "grow.calling.access", "grow.calling.transcription"],
    access: { providerEnabled: false },
  });
  assert.deepEqual(callingPaths(providerOff.calls), []);
  assert.doesNotMatch(textContent(providerOff.tree), /Review calls before CRM actions/);
});

test("Contact 360 still shows calling and loads eligibility and transcripts when granted", async () => {
  const shown = await renderContact({
    entitlements: ["grow.access", "grow.calling.access", "grow.calling.transcription"],
  });
  const text = textContent(shown.tree);
  assert.match(text, /Call Jane Smith/);
  assert.match(text, /Ready to call/);
  assert.match(text, /Review calls before CRM actions/);
  assert.match(text, /No call transcripts for this contact yet/);
  assert.ok(shown.calls.includes("/grow/calls/contacts/12/eligibility"));
  assert.ok(shown.calls.includes("/grow/calls/contacts/12/transcriptions"));
  assert.equal(
    shown.calls.filter((path) => path.startsWith("/grow/calls/") && !path.includes("/contacts/")).length,
    0,
    "an idle call panel does not poll a session",
  );

  const callOnly = await renderContact({ entitlements: ["grow.access", "grow.calling.access"] });
  assert.match(textContent(callOnly.tree), /Call Jane Smith/);
  assert.doesNotMatch(textContent(callOnly.tree), /Review calls before CRM actions/);
  assert.ok(callOnly.calls.includes("/grow/calls/contacts/12/eligibility"));
  assert.equal(callOnly.calls.some((path) => path.includes("/transcriptions")), false);
});

const askMocks: Plugin = {
  name: "gp5-ask-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:gp5-ask-react") return "\0gp5-ask-react";
    if (source === "react/jsx-runtime" || source === "react/jsx-dev-runtime" || source === "virtual:gp5-ask-jsx") return "\0gp5-ask-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:gp5-ask-query") return "\0gp5-ask-query";
    if (source === "wouter" || source === "virtual:gp5-ask-wouter") return "\0gp5-ask-wouter";
    if (source === "../lib/api") return "\0gp5-ask-api";
    return null;
  },
  load(id) {
    if (id === "\0gp5-ask-react") {
      return `
        export const useState = (...args) => globalThis.__gp5AskHooks.useState(...args);
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0gp5-ask-jsx") {
      return `
        export const Fragment = Symbol.for("gp5-ask-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0gp5-ask-query") {
      return `
        export const useQuery = (options) => {
          if (options && options.enabled !== false) options.queryFn();
          return { data: globalThis.__gp5Capabilities, isLoading: false };
        };
        export const useMutation = (options) => ({
          isPending: false,
          mutate(input) {
            globalThis.__gp5AskPending.push(
              Promise.resolve()
                .then(() => options.mutationFn(input))
                .then((result) => { options.onSuccess?.(result); }),
            );
          },
        });
      `;
    }
    if (id === "\0gp5-ask-wouter") {
      return `export const Link = (props) => ({ type: "a", props });`;
    }
    if (id === "\0gp5-ask-api") {
      return `
        export class ApiError extends Error {
          constructor(status, friendly) { super(friendly); this.status = status; this.friendly = friendly; }
        }
        export const apiFetch = (path) => {
          globalThis.__gp5AskCalls.push(path);
          return Promise.resolve(globalThis.__gp5AskResult);
        };
      `;
    }
    return null;
  },
};

function installAsk(capabilities: { copilotEnabled: boolean; businessCoachEnabled: boolean }) {
  const hooks = createHarness();
  const calls: string[] = [];
  const pending: Promise<unknown>[] = [];
  Object.assign(globalThis, {
    __gp5AskHooks: hooks,
    __gp5AskCalls: calls,
    __gp5AskPending: pending,
    __gp5Capabilities: capabilities,
    __gp5AskResult: {
      requestId: "req-1",
      response: {
        kind: "summary",
        summary:
          "Mock AI Provider. No real model call was made. Set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY in Replit Secrets.",
        details: [],
        toolsUsed: [],
        riskLevel: 0,
      },
    },
  });
  return { hooks, calls, pending };
}

function clearAskGlobals() {
  for (const key of ["__gp5AskHooks", "__gp5AskCalls", "__gp5AskPending", "__gp5Capabilities", "__gp5AskResult"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

async function withAskVite<T>(run: (vite: ViteDevServer) => Promise<T>): Promise<T> {
  const vite = await createServer({
    root: new URL("../../..", import.meta.url).pathname,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: true },
    resolve: {
      alias: [
        { find: /^react$/, replacement: "virtual:gp5-ask-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:gp5-ask-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:gp5-ask-query" },
        { find: /^wouter$/, replacement: "virtual:gp5-ask-wouter" },
      ],
    },
    plugins: [askMocks],
  });
  try {
    return await run(vite);
  } finally {
    await vite.close();
  }
}

test("Ask AE shows the demo label and the coach stays off", async () => {
  const ask = installAsk({ copilotEnabled: true, businessCoachEnabled: false });
  try {
    await withAskVite(async (vite) => {
      const { AskAgentEngine } = (await vite.ssrLoadModule("/src/components/AskAgentEngine.tsx")) as {
        AskAgentEngine: (props: { contextType: string; contextId: null; mode?: string }) => unknown;
      };
      const render = (mode?: string) => {
        ask.hooks.beginRender();
        return AskAgentEngine({ contextType: "grow", contextId: null, mode });
      };
      let tree = render("ask");
      const input = findAll(tree, (element) => element.props?.["aria-label"] === "Ask AE a question")[0];
      assert.ok(input);
      (input.props!.onChange as (event: { target: { value: string } }) => void)({ target: { value: "Who is waiting?" } });
      tree = render("ask");
      const askButton = findAll(tree, (element) => element.type === "button" && textContent(element).trim() === "Ask")[0];
      (askButton.props!.onClick as () => void)();
      await Promise.all(ask.pending);
      tree = render("ask");
      assert.match(renderedStrings(tree), /Demo AI: sample text, not generated from your data/);
      assert.doesNotMatch(renderedStrings(tree), /AI_PROVIDER/);
      assert.equal(ask.calls.includes("/ai/ask"), true);
      assert.equal(ask.calls.some((path) => path.includes("/grow/calls")), false);

      (globalThis as { __gp5AskResult: { response: { summary: string } } }).__gp5AskResult = {
        requestId: "req-2",
        response: {
          kind: "summary",
          summary: "Lou has one open appraisal.",
          details: [],
          toolsUsed: [],
          riskLevel: 0,
        },
      } as never;
      tree = render("ask");
      (findAll(tree, (element) => element.type === "button" && textContent(element).trim() === "Ask")[0].props!.onClick as () => void)();
      await Promise.all(ask.pending);
      tree = render("ask");
      assert.match(renderedStrings(tree), /Lou has one open appraisal/);
      assert.doesNotMatch(renderedStrings(tree), /AI_PROVIDER/);

      const coach = render("coach");
      const coachText = renderedStrings(coach);
      assert.match(coachText, /Business Coach/);
      assert.match(coachText, /isn’t enabled for this brokerage/);
      assert.equal(findAll(coach, (element) => element.props?.["aria-label"] === "Ask the Business Coach a question").length, 0);
      assert.doesNotMatch(coachText, /What should I focus on/);
      assert.doesNotMatch(coachText, /AI_PROVIDER/);
    });
  } finally {
    clearAskGlobals();
  }
});
