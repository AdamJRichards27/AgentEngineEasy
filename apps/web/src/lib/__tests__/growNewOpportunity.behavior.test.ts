// G-UAT-5 — New opportunity on the Opportunities tab and on Contact 360.
// Hidden without grow.opportunities.manage. Submit posts partyId,
// opportunityType and reason, and propertyId only when one is chosen.
// Contact 360 pre-fills the contact. Success refetches the opportunity list,
// that contact, and Grow Today. 400, 403 and 404 render a plain sentence.

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

function formElement(tree: unknown): ElementNode | undefined {
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
  };
}

const mocks: Plugin = {
  name: "guat5-new-opportunity-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:guat5-react") return "\0guat5-react";
    if (source === "react/jsx-runtime" || source === "react/jsx-dev-runtime" || source === "virtual:guat5-jsx") return "\0guat5-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:guat5-query") return "\0guat5-query";
    if (source === "wouter" || source === "virtual:guat5-wouter") return "\0guat5-wouter";
    if (source === "../lib/api") return "\0guat5-api";
    if (source === "../lib/session") return "\0guat5-session";
    if (
      source === "../components/AskAgentEngine" ||
      source === "../components/CommunicationsSection" ||
      source === "../components/PropertyIntelligencePanel" ||
      source === "../components/GrowContactTranscriptPanel" ||
      source === "../components/GrowContactConsentPanel" ||
      source === "../components/GrowPendingCommitmentProposals" ||
      source === "../components/ErrorBoundary"
    ) {
      return "\0guat5-components";
    }
    return null;
  },
  load(id) {
    if (id === "\0guat5-react") {
      return `
        export const useState = (...args) => globalThis.__guat5Hooks.useState(...args);
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0guat5-jsx") {
      return `
        export const Fragment = Symbol.for("guat5-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0guat5-query") {
      return `
        export const useQueryClient = () => ({
          invalidateQueries: (filter) => globalThis.__guat5Invalidated.push(filter && filter.queryKey),
        });
        export const useQuery = () => ({
          isLoading: false,
          isError: false,
          data: { opportunities: [] },
          error: null,
          refetch() {},
        });
        export const useMutation = (options) => {
          globalThis.__guat5MutationCursor++;
          return {
            isPending: false,
            isError: false,
            error: null,
            mutate(input) {
              globalThis.__guat5Pending.push(
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
    if (id === "\0guat5-wouter") {
      return `export const Link = (props) => ({ type: "a", props }); export const useSearch = () => "";`;
    }
    if (id === "\0guat5-api") {
      return `
        export const ApiError = globalThis.__guat5ApiError;
        export const apiFetch = (path, options) => globalThis.__guat5ApiFetch(path, options);
        export function apiErrorMessage(error, fallback) {
          if (error instanceof ApiError && typeof error.friendly === "string" && error.friendly.trim()) return error.friendly;
          return fallback;
        }
      `;
    }
    if (id === "\0guat5-session") {
      return `
        export const useSession = () => ({ user: { id: 1, firstName: "Sam", role: "Agent" } });
        export const useEntitlements = () => ({
          isLoading: false,
          hasEntitlement: (key) => globalThis.__guat5Entitlements.includes(key),
        });
      `;
    }
    if (id === "\0guat5-components") {
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
        { find: /^react$/, replacement: "virtual:guat5-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:guat5-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:guat5-query" },
        { find: /^wouter$/, replacement: "virtual:guat5-wouter" },
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

const MANAGE = ["grow.access", "grow.contacts.read", "grow.opportunities.manage"];

function install(entitlements: string[], fetchImpl: (path: string, options?: { method?: string; body?: string }) => Promise<unknown>) {
  const hooks = createHarness();
  const calls: Call[] = [];
  const invalidated: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  Object.assign(globalThis, {
    __guat5Hooks: hooks,
    __guat5ApiError: FakeApiError,
    __guat5Entitlements: entitlements,
    __guat5Invalidated: invalidated,
    __guat5Pending: pending,
    __guat5MutationCursor: 0,
    __guat5ApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, options });
      return fetchImpl(path, options);
    },
  });
  return { hooks, calls, invalidated, pending };
}

function clearGlobals() {
  for (const key of [
    "__guat5Hooks",
    "__guat5ApiError",
    "__guat5Entitlements",
    "__guat5Invalidated",
    "__guat5Pending",
    "__guat5MutationCursor",
    "__guat5ApiFetch",
  ]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

type TabComponent = (props: { onViewContact: (partyId: number) => void }) => unknown;
type SectionComponent = (props: {
  partyId: number;
  contactName?: string;
  linkedProperties?: Array<{ propertyId: number | null; propertyAddress: string | null }>;
  opportunities: unknown[];
  onChanged: () => void;
}) => unknown;

function renderTab(hooks: ReturnType<typeof createHarness>, Tab: TabComponent) {
  (globalThis as { __guat5MutationCursor: number }).__guat5MutationCursor = 0;
  hooks.beginRender();
  return Tab({ onViewContact: () => {} });
}

const LINKED_PROPERTIES = [
  { propertyId: 9, propertyAddress: "9 Future St" },
  { propertyId: 9, propertyAddress: "9 Future St" },
  { propertyId: null, propertyAddress: "Missing id" },
];

function renderSection(hooks: ReturnType<typeof createHarness>, Section: SectionComponent) {
  (globalThis as { __guat5MutationCursor: number }).__guat5MutationCursor = 0;
  hooks.beginRender();
  return Section({
    partyId: 44,
    contactName: "Ada Lovelace",
    linkedProperties: LINKED_PROPERTIES,
    opportunities: [],
    onChanged: () => {},
  });
}

function openTab(hooks: ReturnType<typeof createHarness>, Tab: TabComponent) {
  const closed = renderTab(hooks, Tab);
  const openButton = button(closed, "New opportunity");
  assert.ok(openButton, "an entitled user sees New opportunity on the Opportunities tab");
  openButton.props!.onClick!();
  return renderTab(hooks, Tab);
}

function openSection(hooks: ReturnType<typeof createHarness>, Section: SectionComponent) {
  const closed = renderSection(hooks, Section);
  const openButton = button(closed, "New opportunity");
  assert.ok(openButton, "an entitled user sees New opportunity on Contact 360");
  openButton.props!.onClick!();
  return renderSection(hooks, Section);
}

async function chooseTabContact(
  hooks: ReturnType<typeof createHarness>,
  Tab: TabComponent,
  pending: Promise<unknown>[],
) {
  const opened = openTab(hooks, Tab);
  const types = findAll(field(opened, "grow-new-opportunity-type"), (element) => element.type === "option").map(
    (element) => element.props?.value,
  );
  assert.deepEqual(types, ["Listing", "Appraisal", "PropertyManagement", "Other"]);
  field(opened, "grow-new-opportunity-contact-search")!.props!.onChange!({ target: { value: "Ada" } });
  const searching = renderTab(hooks, Tab);
  button(searching, "Search contacts")!.props!.onClick!();
  await Promise.all(pending);
  const results = renderTab(hooks, Tab);
  const pick = button(results, "Ada Lovelace");
  assert.ok(pick, "the contact picker lists the contact search results");
  pick.props!.onClick!();
  return renderTab(hooks, Tab);
}

function assertRefetched(invalidated: unknown[], partyId: number) {
  assert.ok(
    invalidated.some((key) => Array.isArray(key) && key.length === 1 && key[0] === "grow-opportunities"),
    "the Opportunities tab is refetched",
  );
  assert.ok(
    invalidated.some((key) => Array.isArray(key) && key[0] === "grow-contact" && key[1] === partyId),
    "Contact 360 is refetched",
  );
  assert.ok(
    invalidated.some((key) => Array.isArray(key) && key.length === 1 && key[0] === "grow-today"),
    "Grow Today's open opportunities are refetched",
  );
}

const successFetch = async (path: string, options?: { method?: string; body?: string }) => {
  if (path.startsWith("/grow/contacts")) return { contacts: [{ id: 44, displayName: "Ada Lovelace" }] };
  if (path.startsWith("/properties")) return { properties: [{ id: 9, formattedAddress: "9 Future St" }] };
  if (path === "/grow/opportunities" && options?.method === "POST") return { opportunity: { id: 8 } };
  throw new Error(`unexpected ${options?.method ?? "GET"} ${path}`);
};

test("New opportunity is hidden on both surfaces without grow.opportunities.manage", async () => {
  const { hooks, calls } = install(["grow.access", "grow.contacts.read", "grow.activities.manage"], successFetch);
  try {
    await withVite(async (vite) => {
      const page = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: TabComponent;
        GrowContactOpportunitiesSection: SectionComponent;
      };
      const tab = renderTab(hooks, page.GrowOpportunitiesTab);
      assert.equal(button(tab, "New opportunity"), undefined);
      assert.equal(field(tab, "grow-new-opportunity-reason"), undefined);
      const section = renderSection(hooks, page.GrowContactOpportunitiesSection);
      assert.equal(button(section, "New opportunity"), undefined);
      assert.equal(field(section, "grow-new-opportunity-contact"), undefined);
      assert.equal(calls.length, 0);
    });
  } finally {
    clearGlobals();
  }
});

test("the Opportunities tab posts the contact, type and reason, and omits propertyId when none is chosen", async () => {
  const { hooks, calls, invalidated, pending } = install(MANAGE, successFetch);
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as { GrowOpportunitiesTab: TabComponent };
      const chosen = await chooseTabContact(hooks, GrowOpportunitiesTab, pending);
      const blank = renderTab(hooks, GrowOpportunitiesTab);
      formElement(blank)!.props!.onSubmit!({ preventDefault() {} });
      await Promise.all(pending);
      assert.equal(
        calls.filter((call) => call.options?.method === "POST").length,
        0,
        "a missing reason does not post",
      );

      field(chosen, "grow-new-opportunity-type")!.props!.onChange!({ target: { value: "Appraisal" } });
      field(chosen, "grow-new-opportunity-reason")!.props!.onChange!({ target: { value: "  Enquired about a market appraisal.  " } });
      const ready = renderTab(hooks, GrowOpportunitiesTab);
      formElement(ready)!.props!.onSubmit!({ preventDefault() {} });
      await Promise.all(pending);

      const post = calls.find((call) => call.path === "/grow/opportunities" && call.options?.method === "POST");
      assert.ok(post, "the form posts to POST /grow/opportunities");
      const body = JSON.parse(post.options!.body!) as Record<string, unknown>;
      assert.deepEqual(body, {
        partyId: 44,
        opportunityType: "Appraisal",
        reason: "Enquired about a market appraisal.",
      });
      assert.equal(Object.prototype.hasOwnProperty.call(body, "propertyId"), false);
      assert.ok(calls.some((call) => call.path === "/grow/contacts?search=Ada"));
      assert.equal(calls.some((call) => call.path.startsWith("/properties")), false);
      assertRefetched(invalidated, 44);
      const done = renderTab(hooks, GrowOpportunitiesTab);
      assert.match(textContent(done), /Opportunity created/);
    });
  } finally {
    clearGlobals();
  }
});

test("the Opportunities tab includes propertyId only after a visible property is chosen", async () => {
  const { hooks, calls, pending } = install(MANAGE, successFetch);
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as { GrowOpportunitiesTab: TabComponent };
      const chosen = await chooseTabContact(hooks, GrowOpportunitiesTab, pending);
      field(chosen, "grow-new-opportunity-property-search")!.props!.onChange!({ target: { value: "Future St" } });
      const searching = renderTab(hooks, GrowOpportunitiesTab);
      button(searching, "Search properties")!.props!.onClick!();
      await Promise.all(pending);
      const results = renderTab(hooks, GrowOpportunitiesTab);
      const pick = button(results, "9 Future St");
      assert.ok(pick, "the property picker lists GET /properties results");
      pick.props!.onClick!();
      const selected = renderTab(hooks, GrowOpportunitiesTab);
      field(selected, "grow-new-opportunity-reason")!.props!.onChange!({ target: { value: "Listing lead" } });
      const ready = renderTab(hooks, GrowOpportunitiesTab);
      formElement(ready)!.props!.onSubmit!({ preventDefault() {} });
      await Promise.all(pending);

      const post = calls.find((call) => call.path === "/grow/opportunities" && call.options?.method === "POST");
      assert.ok(post);
      assert.deepEqual(JSON.parse(post.options!.body!), {
        partyId: 44,
        opportunityType: "Listing",
        reason: "Listing lead",
        propertyId: 9,
      });
      assert.ok(calls.some((call) => call.path === "/properties?q=Future%20St"));
    });
  } finally {
    clearGlobals();
  }
});

test("Contact 360 pre-fills the contact and posts a linked property only when chosen", async () => {
  const { hooks, calls, invalidated, pending } = install(MANAGE, successFetch);
  try {
    await withVite(async (vite) => {
      const { GrowContactOpportunitiesSection } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowContactOpportunitiesSection: SectionComponent;
      };
      const opened = openSection(hooks, GrowContactOpportunitiesSection);
      assert.match(textContent(field(opened, "grow-new-opportunity-contact")), /Ada Lovelace/);
      assert.equal(field(opened, "grow-new-opportunity-contact-search"), undefined, "the contact is not editable");
      assert.equal(field(opened, "grow-new-opportunity-property-search"), undefined, "Contact 360 uses linked properties");
      const propertyOptions = findAll(field(opened, "grow-new-opportunity-property"), (element) => element.type === "option");
      assert.deepEqual(
        propertyOptions.map((element) => element.props?.value),
        ["", 9],
        "duplicate and id-less links collapse to the one visible property",
      );
      assert.equal(textContent(propertyOptions[1]), "9 Future St");

      field(opened, "grow-new-opportunity-type")!.props!.onChange!({ target: { value: "PropertyManagement" } });
      field(opened, "grow-new-opportunity-reason")!.props!.onChange!({ target: { value: "Asked about management" } });
      const withoutProperty = renderSection(hooks, GrowContactOpportunitiesSection);
      formElement(withoutProperty)!.props!.onSubmit!({ preventDefault() {} });
      await Promise.all(pending);
      const first = calls.find((call) => call.path === "/grow/opportunities");
      assert.ok(first);
      const firstBody = JSON.parse(first.options!.body!) as Record<string, unknown>;
      assert.deepEqual(firstBody, {
        partyId: 44,
        opportunityType: "PropertyManagement",
        reason: "Asked about management",
      });
      assert.equal(Object.prototype.hasOwnProperty.call(firstBody, "propertyId"), false);
      assert.equal(calls.some((call) => call.path.startsWith("/properties")), false);
      assert.equal(calls.some((call) => call.path.startsWith("/grow/contacts")), false);
      assertRefetched(invalidated, 44);

      const again = openSection(hooks, GrowContactOpportunitiesSection);
      field(again, "grow-new-opportunity-reason")!.props!.onChange!({ target: { value: "Manage 9 Future St" } });
      field(again, "grow-new-opportunity-property")!.props!.onChange!({ target: { value: "9" } });
      const withProperty = renderSection(hooks, GrowContactOpportunitiesSection);
      formElement(withProperty)!.props!.onSubmit!({ preventDefault() {} });
      await Promise.all(pending);
      const posts = calls.filter((call) => call.path === "/grow/opportunities" && call.options?.method === "POST");
      assert.equal(posts.length, 2);
      assert.deepEqual(JSON.parse(posts[1].options!.body!), {
        partyId: 44,
        opportunityType: "Listing",
        reason: "Manage 9 Future St",
        propertyId: 9,
      });
    });
  } finally {
    clearGlobals();
  }
});

test("400, 403 and 404 show a plain message on both surfaces", async () => {
  const cases: Array<{ status: number; friendly: string; expected: RegExp }> = [
    { status: 400, friendly: "partyId, opportunityType, and reason are required", expected: /partyId, opportunityType, and reason are required/ },
    { status: 403, friendly: "Your plan doesn't include this. A Brokerage Administrator can add it.", expected: /Your plan doesn't include this/ },
    { status: 404, friendly: "That couldn't be found — it may have been removed.", expected: /That contact or property couldn't be found/ },
  ];
  for (const item of cases) {
    const failingFetch = async (path: string, options?: { method?: string; body?: string }) => {
      if (path.startsWith("/grow/contacts")) return { contacts: [{ id: 44, displayName: "Ada Lovelace" }] };
      if (path === "/grow/opportunities" && options?.method === "POST") throw new FakeApiError(item.status, item.friendly);
      throw new Error(`unexpected ${path}`);
    };
    const tabRun = install(MANAGE, failingFetch);
    try {
      await withVite(async (vite) => {
        const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as { GrowOpportunitiesTab: TabComponent };
        const chosen = await chooseTabContact(tabRun.hooks, GrowOpportunitiesTab, tabRun.pending);
        field(chosen, "grow-new-opportunity-reason")!.props!.onChange!({ target: { value: "A reason" } });
        const ready = renderTab(tabRun.hooks, GrowOpportunitiesTab);
        formElement(ready)!.props!.onSubmit!({ preventDefault() {} });
        await Promise.all(tabRun.pending);
        const done = renderTab(tabRun.hooks, GrowOpportunitiesTab);
        assert.match(textContent(done), item.expected);
        assert.doesNotMatch(textContent(done), /Opportunity created/);
        assert.equal(tabRun.invalidated.length, 0);
      });
    } finally {
      clearGlobals();
    }

    const sectionRun = install(MANAGE, failingFetch);
    try {
      await withVite(async (vite) => {
        const { GrowContactOpportunitiesSection } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
          GrowContactOpportunitiesSection: SectionComponent;
        };
        const opened = openSection(sectionRun.hooks, GrowContactOpportunitiesSection);
        field(opened, "grow-new-opportunity-reason")!.props!.onChange!({ target: { value: "A reason" } });
        const ready = renderSection(sectionRun.hooks, GrowContactOpportunitiesSection);
        formElement(ready)!.props!.onSubmit!({ preventDefault() {} });
        await Promise.all(sectionRun.pending);
        const done = renderSection(sectionRun.hooks, GrowContactOpportunitiesSection);
        assert.match(textContent(done), item.expected);
        assert.doesNotMatch(textContent(done), /Opportunity created/);
        assert.equal(sectionRun.invalidated.length, 0);
      });
    } finally {
      clearGlobals();
    }
  }
});
