// G-UAT-3 — Contact 360 Link property form.
// Hidden unless the user holds both grow.properties.link and
// grow.relationships.manage. Submit posts to POST /grow/relationships.
// Future seller is one of the relationship options. 404, 403 and 409
// render a plain sentence.

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
    disabled?: boolean;
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

function field(tree: unknown, id: string): ElementNode | undefined {
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
  };
}

const mocks: Plugin = {
  name: "guat3-link-property-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:guat3-react") return "\0guat3-react";
    if (source === "react/jsx-runtime" || source === "react/jsx-dev-runtime" || source === "virtual:guat3-jsx") return "\0guat3-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:guat3-query") return "\0guat3-query";
    if (source === "wouter" || source === "virtual:guat3-wouter") return "\0guat3-wouter";
    if (source === "../lib/api") return "\0guat3-api";
    if (source === "../lib/session") return "\0guat3-session";
    if (
      source === "../components/AskAgentEngine" ||
      source === "../components/CommunicationsSection" ||
      source === "../components/PropertyIntelligencePanel" ||
      source === "../components/GrowContactTranscriptPanel" ||
      source === "../components/GrowContactConsentPanel" ||
      source === "../components/GrowPendingCommitmentProposals" ||
      source === "../components/ErrorBoundary"
    ) {
      return "\0guat3-components";
    }
    return null;
  },
  load(id) {
    if (id === "\0guat3-react") {
      return `
        export const useState = (...args) => globalThis.__guat3Hooks.useState(...args);
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0guat3-jsx") {
      return `
        export const Fragment = Symbol.for("guat3-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0guat3-query") {
      return `
        export const useQueryClient = () => ({
          invalidateQueries: (filter) => globalThis.__guat3Invalidated.push(filter && filter.queryKey),
        });
        export const useQuery = () => ({ isLoading: false, isError: false, data: undefined });
        export const useMutation = (options) => {
          const index = globalThis.__guat3MutationCursor++;
          globalThis.__guat3Mutations[index] = options;
          return {
            isPending: false,
            isError: false,
            error: null,
            mutate(input) {
              globalThis.__guat3Pending.push(
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
    if (id === "\0guat3-wouter") {
      return `export const Link = (props) => ({ type: "a", props }); export const useSearch = () => "";`;
    }
    if (id === "\0guat3-api") {
      return `
        export const ApiError = globalThis.__guat3ApiError;
        export const apiFetch = (path, options) => globalThis.__guat3ApiFetch(path, options);
        export function apiErrorMessage(error, fallback) {
          if (error instanceof ApiError && typeof error.friendly === "string" && error.friendly.trim()) return error.friendly;
          return fallback;
        }
      `;
    }
    if (id === "\0guat3-session") {
      return `
        export const useSession = () => ({ user: { id: 1, firstName: "Sam", role: "Agent" } });
        export const useEntitlements = () => ({
          isLoading: false,
          hasEntitlement: (key) => globalThis.__guat3Entitlements.includes(key),
        });
      `;
    }
    if (id === "\0guat3-components") {
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
        { find: /^react$/, replacement: "virtual:guat3-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:guat3-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:guat3-query" },
        { find: /^wouter$/, replacement: "virtual:guat3-wouter" },
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

const BOTH_KEYS = ["grow.properties.link", "grow.relationships.manage"];

function install(entitlements: string[], fetchImpl: (path: string, options?: { method?: string; body?: string }) => Promise<unknown>) {
  const hooks = createHarness();
  const calls: Call[] = [];
  const invalidated: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  Object.assign(globalThis, {
    __guat3Hooks: hooks,
    __guat3ApiError: FakeApiError,
    __guat3Entitlements: entitlements,
    __guat3Invalidated: invalidated,
    __guat3Pending: pending,
    __guat3Mutations: [],
    __guat3MutationCursor: 0,
    __guat3ApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, options });
      return fetchImpl(path, options);
    },
  });
  return { hooks, calls, invalidated, pending };
}

function clearGlobals() {
  for (const key of [
    "__guat3Hooks",
    "__guat3ApiError",
    "__guat3Entitlements",
    "__guat3Invalidated",
    "__guat3Pending",
    "__guat3Mutations",
    "__guat3MutationCursor",
    "__guat3ApiFetch",
  ]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

type FormComponent = (props: { partyId: number; onLinked: () => void }) => unknown;

function render(hooks: ReturnType<typeof createHarness>, Form: FormComponent, onLinked: () => void) {
  (globalThis as { __guat3MutationCursor: number }).__guat3MutationCursor = 0;
  hooks.beginRender();
  return Form({ partyId: 44, onLinked });
}

function openForm(hooks: ReturnType<typeof createHarness>, Form: FormComponent, onLinked: () => void) {
  const closed = render(hooks, Form, onLinked);
  const openButton = button(closed, "Link property");
  assert.ok(openButton, "an entitled user sees Link property");
  assert.equal(button(closed, "Add related contact"), undefined, "household links stay off this form");
  openButton.props!.onClick!();
  return render(hooks, Form, onLinked);
}

async function searchAndSelect(hooks: ReturnType<typeof createHarness>, Form: FormComponent, onLinked: () => void, pending: Promise<unknown>[]) {
  const opened = openForm(hooks, Form, onLinked);
  field(opened, "grow-link-property-search")!.props!.onChange!({ target: { value: "Future St" } });
  const searching = render(hooks, Form, onLinked);
  button(searching, "Search")!.props!.onClick!();
  await Promise.all(pending);
  const results = render(hooks, Form, onLinked);
  const pick = button(results, "9 Future St");
  assert.ok(pick, "the property picker lists GET /properties results");
  pick.props!.onClick!();
  return render(hooks, Form, onLinked);
}

const propertyFetch = async (path: string, options?: { method?: string; body?: string }) => {
  if (path.startsWith("/properties")) return { properties: [{ id: 9, formattedAddress: "9 Future St" }] };
  if (path === "/grow/relationships" && options?.method === "POST") return { relationship: { id: 3 } };
  throw new Error(`unexpected ${options?.method ?? "GET"} ${path}`);
};

test("Link property is hidden unless both keys are held", async () => {
  for (const entitlements of [[], ["grow.properties.link"], ["grow.relationships.manage"], ["grow.contacts.manage"]]) {
    const { hooks, calls } = install(entitlements, propertyFetch);
    try {
      await withVite(async (vite) => {
        const { GrowLinkPropertyForm } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as { GrowLinkPropertyForm: FormComponent };
        const tree = render(hooks, GrowLinkPropertyForm, () => {});
        assert.equal(tree, null);
        assert.equal(button(tree, "Link property"), undefined);
        assert.equal(calls.length, 0);
      });
    } finally {
      clearGlobals();
    }
  }
});

test("submitting Link property posts the property and Future seller, then refetches Contact 360", async () => {
  const { hooks, calls, invalidated, pending } = install(BOTH_KEYS, propertyFetch);
  let linked = 0;
  try {
    await withVite(async (vite) => {
      const { GrowLinkPropertyForm } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as { GrowLinkPropertyForm: FormComponent };
      const ready = await searchAndSelect(hooks, GrowLinkPropertyForm, () => {
        linked += 1;
      }, pending);
      const futureSeller = findAll(ready, (element) => element.type === "option" && element.props?.value === "prospective_seller")[0];
      assert.ok(futureSeller, "Future seller is a relationship option");
      assert.equal(textContent(futureSeller), "Future seller");
      assert.equal(
        findAll(ready, (element) => element.type === "option" && element.props?.value === "spouse_partner").length,
        0,
        "household relationship types are not in the property form",
      );
      field(ready, "grow-link-property-type")!.props!.onChange!({ target: { value: "prospective_seller" } });
      const chosen = render(hooks, GrowLinkPropertyForm, () => {
        linked += 1;
      });
      const form = findAll(chosen, (element) => element.type === "form")[0];
      form.props!.onSubmit!({ preventDefault() {} });
      await Promise.all(pending);

      const post = calls.find((call) => call.path === "/grow/relationships");
      assert.ok(post, "the form posts to POST /grow/relationships");
      assert.equal(post.options?.method, "POST");
      assert.deepEqual(JSON.parse(post.options!.body!), {
        partyId: 44,
        propertyId: 9,
        relationshipType: "prospective_seller",
      });
      assert.ok(calls.some((call) => call.path === "/properties?q=Future%20St"));
      assert.ok(
        invalidated.some((key) => Array.isArray(key) && key[0] === "grow-contact" && key[1] === 44),
        "Contact 360 is refetched",
      );
      assert.equal(linked, 1);
    });
  } finally {
    clearGlobals();
  }
});

test("404, 403 and 409 show a plain message", async () => {
  const cases: Array<{ status: number; friendly: string; expected: RegExp }> = [
    { status: 404, friendly: "That couldn't be found — it may have been removed.", expected: /That property couldn't be found/ },
    { status: 403, friendly: "Your plan doesn't include this. A Brokerage Administrator can add it.", expected: /Your plan doesn't include this/ },
    { status: 409, friendly: "This contact is already linked to that property with this relationship.", expected: /already linked/ },
  ];
  for (const item of cases) {
    const { hooks, pending } = install(BOTH_KEYS, async (path, options) => {
      if (path.startsWith("/properties")) return { properties: [{ id: 9, formattedAddress: "9 Future St" }] };
      if (path === "/grow/relationships" && options?.method === "POST") throw new FakeApiError(item.status, item.friendly);
      throw new Error(`unexpected ${path}`);
    });
    try {
      await withVite(async (vite) => {
        const { GrowLinkPropertyForm } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as { GrowLinkPropertyForm: FormComponent };
        const ready = await searchAndSelect(hooks, GrowLinkPropertyForm, () => {}, pending);
        findAll(ready, (element) => element.type === "form")[0].props!.onSubmit!({ preventDefault() {} });
        await Promise.all(pending);
        const done = render(hooks, GrowLinkPropertyForm, () => {});
        assert.match(textContent(done), item.expected);
      });
    } finally {
      clearGlobals();
    }
  }
});
