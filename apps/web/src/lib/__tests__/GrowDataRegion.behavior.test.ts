import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

// AE GROW Pilot Readiness WP6b component-behaviour tests, same harness as
// GrowCallFollowupsSection.behavior.test.ts: React, React Query, wouter and the
// API client are replaced with tiny in-memory fakes so the real component
// functions run under node without a DOM.
//
// Covers the two defects whose fix is only visible in the rendered output:
//   D6   — a Grow data region whose query failed shows an explicit error with a
//          working Try again, instead of rendering nothing at all.
//   P3-c — the proposal card's header stops saying "nothing created yet" once
//          the commitment has actually been created.

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

class FakeApiError extends Error {
  status: number;
  friendly: string;
  reason?: string;
  correlationId?: string;
  sideEffectApplied?: boolean;
  constructor(status: number, friendly: string, extras?: { reason?: string; correlationId?: string; sideEffectApplied?: boolean }) {
    super(friendly);
    this.status = status;
    this.friendly = friendly;
    this.reason = extras?.reason;
    this.correlationId = extras?.correlationId;
    this.sideEffectApplied = extras?.sideEffectApplied;
  }
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
      return [state[index], (next: unknown) => {
        state[index] = typeof next === "function" ? (next as (current: unknown) => unknown)(state[index]) : next;
      }];
    },
    useEffect() {},
  };
}

const virtualMocks: Plugin = {
  name: "wp6b-behavior-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:wp6b-react") return "\0wp6b-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:wp6b-jsx") return "\0wp6b-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:wp6b-query") return "\0wp6b-query";
    if (source === "wouter" || source === "virtual:wp6b-wouter") return "\0wp6b-wouter";
    // Only the component's own "../lib/api" import is faked; lib/growWorkspace's
    // "./api" import resolves to the real module, so the support-reference
    // formatting under test is the shipped one.
    if (source === "../lib/api") return "\0wp6b-api";
    return null;
  },
  load(id) {
    if (id === "\0wp6b-react") {
      return `
        export const useState = (...args) => globalThis.__wp6bHooks.useState(...args);
        export const useEffect = (...args) => globalThis.__wp6bHooks.useEffect(...args);
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0wp6b-jsx") {
      return `
        export const Fragment = Symbol.for("wp6b-fragment");
        export const jsx = (type, props, key) => ({ type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0wp6b-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries: () => {} });
        export const useQuery = () => globalThis.__wp6bQuery;
        export const useMutation = () => ({ isPending: false, isError: false, error: null, mutate: () => {} });
      `;
    }
    if (id === "\0wp6b-wouter") {
      return `export const Link = (props) => ({ type: "a", props });`;
    }
    if (id === "\0wp6b-api") {
      return `
        export const ApiError = globalThis.__wp6bApiError;
        export const apiFetch = (path, options) => globalThis.__wp6bApiFetch(path, options);
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
        { find: /^react$/, replacement: "virtual:wp6b-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:wp6b-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:wp6b-query" },
        { find: /^wouter$/, replacement: "virtual:wp6b-wouter" },
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

test("D6: a failed Grow data region shows the error, a support reference, and a Try again that refetches", async () => {
  await withVite(async (vite) => {
    const { GrowDataRegionStatus } = (await vite.ssrLoadModule("/src/components/GrowDataRegion.tsx")) as {
      GrowDataRegionStatus: (props: Record<string, unknown>) => unknown;
    };
    let retries = 0;
    const props = {
      errorFallback: "Couldn't load opportunities.",
      emptyMessage: "No opportunities yet.",
      onRetry: () => retries++,
    };

    // Loading.
    assert.match(textContent(GrowDataRegionStatus({ ...props, query: { isLoading: true, isError: false }, itemCount: undefined })), /Loading/);

    // The defect: the API is down, so there is no data. Before this fix the
    // section rendered nothing whatsoever.
    const failure = new FakeApiError(500, "Something went wrong on our end. Try again in a moment.", { correlationId: "3f9c2a1b-7d4e-4c2a" });
    const failed = GrowDataRegionStatus({ ...props, query: { isLoading: false, isError: true, error: failure }, itemCount: undefined });
    const text = textContent(failed);
    assert.equal(findAll(failed, (element) => element.props?.role === "alert").length, 1, "the failure is announced");
    assert.match(text, /Something went wrong on our end/);
    assert.match(text, /Reference: 3f9c2a1b/);
    assert.doesNotMatch(text, /No opportunities yet/, "a failure never reads as an empty list");
    const retry = button(failed, "Try again");
    assert.ok(retry, "a failed region offers a retry");
    (retry.props!.onClick as () => void)();
    assert.equal(retries, 1, "retry refetches this region only");

    // A 401 (session expired) shows the humanised message, with no reference
    // to quote because the request never reached a server that stamped one.
    const expired = GrowDataRegionStatus({
      ...props,
      query: { isLoading: false, isError: true, error: new FakeApiError(401, "Your session has ended — please sign in again.") },
      itemCount: undefined,
    });
    assert.match(textContent(expired), /Your session has ended/);
    assert.doesNotMatch(textContent(expired), /Reference:/);

    // Genuinely empty, and genuinely populated.
    assert.match(textContent(GrowDataRegionStatus({ ...props, query: { isLoading: false, isError: false }, itemCount: 0 })), /No opportunities yet/);
    assert.equal(GrowDataRegionStatus({ ...props, query: { isLoading: false, isError: false }, itemCount: 2 }), null, "the caller renders its own table");
  });
});

test("P3-c: the proposal card header reflects the created commitment after approval", async () => {
  const hooks = createHarness();
  const calls: string[] = [];
  Object.assign(globalThis, {
    __wp6bHooks: hooks,
    __wp6bApiError: FakeApiError,
    __wp6bQuery: { isLoading: false, isError: false, data: undefined },
    __wp6bApiFetch: (path: string) => {
      calls.push(path);
      return Promise.resolve(path.endsWith("/execute") ? { request: { id: 900, status: "COMPLETED" }, result: { id: 55 } } : { request: { id: 900, status: "APPROVED" } });
    },
  });
  try {
    await withVite(async (vite) => {
      const { GrowCommitmentProposalCard } = (await vite.ssrLoadModule("/src/components/GrowCommitmentProposalCard.tsx")) as {
        GrowCommitmentProposalCard: (props: Record<string, unknown>) => unknown;
      };
      const proposal = {
        actionRequestId: 900,
        summary: "Call Jo Citizen back about the appraisal",
        contactName: "Jo Citizen",
        dueAt: "2026-10-01T00:00:00.000Z",
        timeZone: "Australia/Brisbane",
        reason: "Overdue follow-up",
        evidenceSummary: null,
        status: "AWAITING_APPROVAL",
        expiresAt: new Date(Date.now() + 23.5 * 3_600_000).toISOString(),
        reviewUrl: "/grow",
        provenance: null,
      };
      const render = () => {
        hooks.beginRender();
        return GrowCommitmentProposalCard({ proposal, dismissible: false });
      };

      let tree = render();
      assert.match(textContent(tree), /Proposed commitment — nothing created yet/, "before approval the header names a commitment, not a follow-up");

      await (button(tree, "Approve & Create Commitment")!.props!.onClick as () => Promise<void>)();
      assert.deepEqual(calls, ["/ai/actions/requests/900/approve", "/ai/actions/requests/900/execute"]);

      tree = render();
      const text = textContent(tree);
      assert.match(text, /Commitment created/);
      assert.doesNotMatch(text, /nothing created yet/, "the header no longer contradicts the outcome");
      assert.match(text, /Commitment created/, "the header itself reports the created commitment");
      assert.doesNotMatch(text, /follow-up commitment/i);
      assert.match(text, /View in Grow \(#55\)/);
    });
  } finally {
    for (const key of ["__wp6bHooks", "__wp6bApiError", "__wp6bQuery", "__wp6bApiFetch"]) {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
