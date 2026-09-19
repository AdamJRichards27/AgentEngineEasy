import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin } from "vite";

interface ElementNode {
  props?: {
    children?: unknown;
    onClick?: () => void;
  };
}

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!node || typeof node !== "object") return "";
  return textContent((node as ElementNode).props?.children);
}

function findButtons(node: unknown, label: string): ElementNode[] {
  if (Array.isArray(node)) return node.flatMap((child) => findButtons(child, label));
  if (!node || typeof node !== "object") return [];
  const element = node as ElementNode & { type?: unknown };
  const own = element.type === "button" && textContent(element).includes(label) ? [element] : [];
  return own.concat(findButtons(element.props?.children, label));
}

test("item decisions stay local until Save, while Save and Discard call only their explicit routes", async () => {
  const state: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const effectDeps: unknown[][] = [];
  const writes: Array<{ path: string; options?: { method?: string; body?: string } }> = [];
  let stateCursor = 0;
  let refCursor = 0;
  let effectCursor = 0;
  let pending: Promise<unknown>[] = [];

  const fixture = {
    id: 71,
    callSessionId: 81,
    processingState: "AWAITING_AGENT_REVIEW",
    transcript: "Provider transcript",
    draftSummary: "AI summary",
    draftKeyPoints: [{ id: "point-1", text: "AI point" }],
    draftCommitments: [],
    draftFollowups: [],
    failureReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const hooks = {
    beginRender() {
      stateCursor = 0;
      refCursor = 0;
      effectCursor = 0;
    },
    useState(initial: unknown) {
      const index = stateCursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (next: unknown) => {
        state[index] = typeof next === "function"
          ? (next as (current: unknown) => unknown)(state[index])
          : next;
      }];
    },
    useRef(initial: unknown) {
      const index = refCursor++;
      if (!refs[index]) refs[index] = { current: initial };
      return refs[index];
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

  const virtualMocks: Plugin = {
    name: "transcript-panel-behavior-mocks",
    enforce: "pre",
    resolveId(source) {
      if (source === "react" || source === "virtual:review-test-react") return "\0review-test-react";
      if (
        source === "react/jsx-dev-runtime" ||
        source === "react/jsx-runtime" ||
        source === "virtual:review-test-jsx"
      ) return "\0review-test-jsx";
      if (source === "@tanstack/react-query" || source === "virtual:review-test-query") return "\0review-test-query";
      if (source.endsWith("/lib/api") || source === "../lib/api") return "\0review-test-api";
      return null;
    },
    load(id) {
      if (id === "\0review-test-react") {
        return `
          export const useState = (...args) => globalThis.__reviewHooks.useState(...args);
          export const useRef = (...args) => globalThis.__reviewHooks.useRef(...args);
          export const useEffect = (...args) => globalThis.__reviewHooks.useEffect(...args);
        `;
      }
      if (id === "\0review-test-jsx") {
        return `
          export const Fragment = Symbol.for("review-test-fragment");
          export const jsx = (type, props) => ({ type, props });
          export const jsxs = jsx;
          export const jsxDEV = jsx;
        `;
      }
      if (id === "\0review-test-query") {
        return `
          export const useQueryClient = () => ({ setQueryData() {} });
          export const useQuery = () => globalThis.__reviewQuery;
          export const useMutation = (options) => ({
            isPending: false,
            isError: false,
            mutate(input) {
              globalThis.__reviewPending.push(Promise.resolve(options.mutationFn(input)));
            },
          });
        `;
      }
      if (id === "\0review-test-api") {
        return `
          export class ApiError extends Error {}
          export const apiFetch = (path, options) => globalThis.__reviewApiFetch(path, options);
        `;
      }
      return null;
    },
  };

  Object.assign(globalThis, {
    __reviewHooks: hooks,
    __reviewQuery: { data: { transcriptions: [fixture] }, isLoading: false, isError: false },
    __reviewPending: pending,
    __reviewApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      writes.push({ path, options });
      return Promise.resolve({ transcription: fixture });
    },
  });

  const vite = await createServer({
    root: new URL("../../..", import.meta.url).pathname,
    configFile: false,
    appType: "custom",
    // This is a component test, not a dev server: do not open an HMR port.
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: true },
    resolve: {
      alias: [
        { find: /^react$/, replacement: "virtual:review-test-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:review-test-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:review-test-query" },
      ],
    },
    plugins: [virtualMocks],
  });
  try {
    const { GrowContactTranscriptPanel } = await vite.ssrLoadModule("/src/components/GrowContactTranscriptPanel.tsx") as {
      GrowContactTranscriptPanel: (props: { partyId: number }) => unknown;
    };
    const render = () => {
      hooks.beginRender();
      return GrowContactTranscriptPanel({ partyId: 12 });
    };

    let tree = render();
    findButtons(tree, "Call transcript")[0]!.props!.onClick!();
    render();
    tree = render();

    findButtons(tree, "Accept")[0]!.props!.onClick!();
    tree = render();
    findButtons(tree, "Reject")[1]!.props!.onClick!();
    tree = render();
    assert.equal(writes.length, 0, "per-item decisions must not persist");

    findButtons(tree, "Save review")[0]!.props!.onClick!();
    await Promise.all(pending);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.path, "/grow/calls/81/transcription/71/review");
    assert.deepEqual(JSON.parse(writes[0]!.options!.body!), {
      reviewState: [
        { itemType: "TRANSCRIPT", itemId: "transcript", decision: "APPROVED", editedText: "Provider transcript" },
        { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED", editedText: "AI summary", rejectionReason: null },
        { itemType: "KEY_POINT", itemId: "point-1", decision: "REJECTED", editedText: null, rejectionReason: null },
      ],
    });

    pending = [];
    (globalThis as typeof globalThis & { __reviewPending: Promise<unknown>[] }).__reviewPending = pending;
    findButtons(tree, "Discard transcript")[0]!.props!.onClick!();
    await Promise.all(pending);
    assert.equal(writes.length, 2);
    assert.equal(writes[1]!.path, "/grow/calls/81/transcription/71/discard");
    assert.deepEqual(JSON.parse(writes[1]!.options!.body!), {});
  } finally {
    await vite.close();
    delete (globalThis as Record<string, unknown>).__reviewHooks;
    delete (globalThis as Record<string, unknown>).__reviewQuery;
    delete (globalThis as Record<string, unknown>).__reviewPending;
    delete (globalThis as Record<string, unknown>).__reviewApiFetch;
  }
});
