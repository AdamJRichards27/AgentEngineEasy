// UAT follow-up to I-9/I-10 — the lists already accept `search` and contacts
// accept `role`, but Relationships, Recent activity and Opportunities had no
// search box, Contacts had no role control, and an empty sentence could stay
// on screen after a later search had rows.

import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

interface ElementNode {
  type?: unknown;
  props?: Record<string, unknown> & {
    children?: unknown;
    onChange?: (event: { target: { value: string } }) => void;
    onSubmit?: (event: { preventDefault: () => void }) => void;
    onClick?: () => void;
    id?: string;
    htmlFor?: string;
  };
}

interface EffectSlot {
  fn: () => unknown;
  deps: unknown[];
  cleanup?: () => void;
  run: boolean;
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

function findAll(node: unknown, predicate: (element: ElementNode) => boolean): ElementNode[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate));
  if (!node || typeof node !== "object") return [];
  const element = node as ElementNode;
  const own = predicate(element) ? [element] : [];
  return own.concat(findAll(element.props?.children, predicate));
}

function byId(tree: unknown, id: string): ElementNode {
  const element = findAll(tree, (candidate) => candidate.props?.id === id)[0];
  assert.ok(element, `missing #${id}`);
  return element;
}

function createHarness() {
  const state: unknown[] = [];
  let stateCursor = 0;
  const effects: EffectSlot[] = [];
  let effectCursor = 0;
  return {
    beginRender() {
      stateCursor = 0;
      effectCursor = 0;
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
    useEffect(fn: () => unknown, deps: unknown[]) {
      const index = effectCursor++;
      const prev = effects[index];
      const changed = !prev || prev.deps.length !== deps.length || deps.some((dep, i) => !Object.is(dep, prev.deps[i]));
      if (!prev) {
        effects[index] = { fn, deps, run: true };
        return;
      }
      if (changed) {
        effects[index] = { fn, deps, cleanup: prev.cleanup, run: true };
        return;
      }
      prev.run = false;
    },
    flushEffects() {
      for (const effect of effects) {
        if (!effect?.run) continue;
        effect.cleanup?.();
        const cleanup = effect.fn();
        effect.cleanup = typeof cleanup === "function" ? cleanup : undefined;
        effect.run = false;
      }
    },
  };
}

function contact(id: number, name: string) {
  return {
    id,
    displayName: name,
    partyType: "Person",
    email: null,
    mobile: null,
    roles: [] as string[],
    relatedPropertyCount: 0,
  };
}

function relationship(id: number, name: string) {
  return {
    id,
    relationshipType: "owner",
    role: null,
    status: "Active",
    isPrimary: false,
    partyFirstName: name,
    partyLastName: "Person",
    partyOrganisationName: null,
    propertyAddress: "1 Queen Street",
  };
}

function activity(id: number, summary: string) {
  return { id, activityType: "note", occurredAt: "2026-01-01T00:00:00.000Z", summary };
}

function opportunity(id: number, reason: string) {
  return {
    id,
    opportunityType: "Listing",
    status: "Open",
    stage: "New",
    reason,
    partyId: 1,
    propertyId: null,
    recommendedNextAction: null,
    nextActionDueAt: null,
  };
}

function dataFor(queryKey: unknown[]) {
  const [name, search, role] = queryKey as [string, string?, string?];
  const term = search ?? "";
  if (name === "grow-contacts") {
    if (term === "UAT1") return { contacts: [], total: 0, nextCursor: null };
    if (term === "Seller") {
      return {
        contacts: Array.from({ length: 38 }, (_, index) => contact(index + 1, `Seller ${index + 1}`)),
        total: 38,
        nextCursor: null,
      };
    }
    if (role === "Buyer" || term === "Ada") return { contacts: [contact(7, "Ada Buyer")], total: 1, nextCursor: null };
    return { contacts: [contact(1, "First Contact")], total: 280, nextCursor: "contact-cursor" };
  }
  if (name === "grow-relationships") {
    if (term === "zzz") return { relationships: [], total: 0, nextCursor: null };
    if (term === "Queen") {
      return {
        relationships: Array.from({ length: 4 }, (_, index) => relationship(index + 3, "Queenie")),
        total: 4,
        nextCursor: null,
      };
    }
    return { relationships: [relationship(1, "Alpha")], total: 280, nextCursor: "rel-cursor" };
  }
  if (name === "grow-activities") {
    if (term === "nope") return { activities: [], total: 0, nextCursor: null };
    if (term.length > 0) {
      return {
        activities: [activity(9, `Hit ${term}`), activity(10, `Also ${term}`)],
        total: 2,
        nextCursor: null,
      };
    }
    return { activities: [activity(1, "Logged note")], total: 10, nextCursor: null };
  }
  if (name === "grow-opportunities") {
    const typeFilters = new Set(["all", "seller_side", "property_management", "other"]);
    const typeFilter = typeFilters.has(term) ? term : "all";
    const query = typeFilters.has(term) ? (role ?? "") : term;
    if (query === "missing") return { opportunities: [], total: 0, nextCursor: null };
    if (typeFilter === "seller_side" && query === "Ada") {
      return { opportunities: [opportunity(11, "Ada seller")], total: 1, nextCursor: null };
    }
    if (query === "Ada") return { opportunities: [opportunity(10, "Ada open")], total: 5, nextCursor: "ada-cursor" };
    if (query.length > 0) {
      return {
        opportunities: Array.from({ length: 38 }, (_, index) => opportunity(index + 1, `Reason ${query} ${index + 1}`)),
        total: 38,
        nextCursor: null,
      };
    }
    return { opportunities: [opportunity(1, "Open reason")], total: 3, nextCursor: "opp-cursor" };
  }
  if (name === "grow-appraisals") return { appraisals: [] };
  return undefined;
}

const mocks: Plugin = {
  name: "grow-list-filter-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:list-filter-react") return "\0list-filter-react";
    if (source === "react/jsx-runtime" || source === "react/jsx-dev-runtime" || source === "virtual:list-filter-jsx") {
      return "\0list-filter-jsx";
    }
    if (source === "@tanstack/react-query" || source === "virtual:list-filter-query") return "\0list-filter-query";
    if (source === "wouter" || source === "virtual:list-filter-wouter") return "\0list-filter-wouter";
    if (source === "../lib/api") return "\0list-filter-api";
    if (source === "../lib/session") return "\0list-filter-session";
    if (
      source === "../components/AskAgentEngine" ||
      source === "../components/CommunicationsSection" ||
      source === "../components/PropertyIntelligencePanel" ||
      source === "../components/GrowContactTranscriptPanel" ||
      source === "../components/GrowContactConsentPanel" ||
      source === "../components/GrowPendingCommitmentProposals" ||
      source === "../components/ErrorBoundary"
    ) {
      return "\0list-filter-components";
    }
    return null;
  },
  load(id) {
    if (id === "\0list-filter-react") {
      return `
        export const useState = (...args) => globalThis.__listHooks.useState(...args);
        export const useEffect = (...args) => globalThis.__listHooks.useEffect(...args);
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0list-filter-jsx") {
      return `
        export const Fragment = Symbol.for("list-filter-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0list-filter-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries() {} });
        export const useQuery = (options) => {
          globalThis.__listQueries.push(options);
          if (options && options.enabled === false) {
            return { isLoading: false, isFetching: false, isError: false, data: undefined, refetch() {} };
          }
          const key = options && options.queryKey && options.queryKey[0];
          const fetching = globalThis.__listFetching === key;
          return {
            isLoading: false,
            isFetching: fetching,
            isError: false,
            data: fetching ? undefined : globalThis.__listData(options.queryKey),
            refetch() {},
          };
        };
        export const useMutation = () => ({ isPending: false, isError: false, error: null, mutate() {} });
      `;
    }
    if (id === "\0list-filter-wouter") {
      return `export const Link = (props) => ({ type: "a", props }); export const useSearch = () => "";`;
    }
    if (id === "\0list-filter-api") {
      return `
        export class ApiError extends Error {}
        export const apiFetch = (path, options) => globalThis.__listFetch(path, options);
        export function apiErrorMessage(_error, fallback) { return fallback; }
      `;
    }
    if (id === "\0list-filter-session") {
      return `
        export const useSession = () => ({ user: { id: 1, firstName: "Sam", role: "Agent" } });
        export const useEntitlements = () => ({ isLoading: false, hasEntitlement: () => false });
      `;
    }
    if (id === "\0list-filter-components") {
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

function install() {
  const hooks = createHarness();
  const calls: string[] = [];
  const queries: QueryOptions[] = [];
  Object.assign(globalThis, {
    __listHooks: hooks,
    __listQueries: queries,
    __listData: dataFor,
    __listFetching: null as string | null,
    __listFetch: (path: string) => {
      calls.push(path);
      if (path.includes("cursor=contact-cursor")) {
        return Promise.resolve({ contacts: [contact(2, "Page Two")], nextCursor: null, total: 280 });
      }
      if (path.includes("cursor=rel-cursor")) {
        return Promise.resolve({ relationships: [relationship(2, "Bravo")], nextCursor: null, total: 280 });
      }
      if (path.includes("cursor=opp-cursor")) {
        return Promise.resolve({ opportunities: [opportunity(2, "Second reason")], nextCursor: null, total: 3 });
      }
      if (path.includes("cursor=ada-cursor")) {
        return Promise.resolve({ opportunities: [opportunity(12, "Ada second")], nextCursor: null, total: 5 });
      }
      return Promise.resolve({});
    },
  });
  return { hooks, calls, queries };
}

function clearGlobals() {
  for (const key of ["__listHooks", "__listQueries", "__listData", "__listFetching", "__listFetch"]) {
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
        { find: /^react$/, replacement: "virtual:list-filter-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:list-filter-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:list-filter-query" },
        { find: /^wouter$/, replacement: "virtual:list-filter-wouter" },
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

function render(hooks: ReturnType<typeof createHarness>, Page: () => unknown) {
  hooks.beginRender();
  return Page();
}

function lastQuery(queries: QueryOptions[], name: string): QueryOptions {
  const match = [...queries].reverse().find((query) => query.queryKey[0] === name);
  assert.ok(match, name);
  return match;
}

test("contact search and role reset the cursor, and a stale empty sentence clears", async () => {
  const { hooks, calls, queries } = install();
  try {
    await withVite(async (vite) => {
      const { GrowContactList } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as { GrowContactList: () => unknown };
      const loaded = render(hooks, GrowContactList);
      const role = byId(loaded, "grow-contacts-role");
      assert.equal(role.type, "select");
      const roleLabel = findAll(loaded, (element) => element.type === "label" && element.props?.htmlFor === "grow-contacts-role")[0];
      assert.equal(textContent(roleLabel).trim().startsWith("Role"), true);
      assert.match(textContent(role), /All roles/);
      assert.match(textContent(role), /Buyer/);
      assert.match(textContent(loaded), /Showing 1 of 280 contacts/);

      const loadMore = findAll(loaded, (element) => element.type === "button" && element.props?.["aria-label"] === "Load more contacts")[0];
      assert.ok(loadMore, "the unfiltered list can load another page");
      loadMore.props!.onClick!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const paged = render(hooks, GrowContactList);
      assert.match(textContent(paged), /Page Two/);
      assert.ok(calls.some((path) => path.includes("cursor=contact-cursor")));

      const search = findAll(paged, (element) => element.props?.["aria-label"] === "Search contacts")[0];
      assert.equal(search?.props?.type, "search");
      search!.props!.onChange!({ target: { value: "Ada" } });
      const typed = render(hooks, GrowContactList);
      byId(typed, "grow-contacts-role").props!.onChange!({ target: { value: "Buyer" } });
      const filtered = render(hooks, GrowContactList);
      assert.doesNotMatch(textContent(filtered), /Page Two/, "changing role drops the appended page");
      assert.match(textContent(filtered), /Showing 1 of 1 contact/);
      assert.match(textContent(filtered), /Ada Buyer/);
      const contactQuery = lastQuery(queries, "grow-contacts");
      assert.deepEqual(contactQuery.queryKey, ["grow-contacts", "Ada", "Buyer"]);
      calls.length = 0;
      await contactQuery.queryFn();
      assert.equal(calls.at(-1), "/grow/contacts?search=Ada&role=Buyer");
      assert.equal(calls.at(-1)!.includes("cursor="), false);

      findAll(filtered, (element) => element.props?.["aria-label"] === "Search contacts")[0]!.props!.onChange!({
        target: { value: "UAT1" },
      });
      const typedEmpty = render(hooks, GrowContactList);
      findAll(typedEmpty, (element) => element.type === "form" && textContent(element).includes("All roles"))[0]!.props!.onSubmit!({
        preventDefault() {},
      });
      const empty = render(hooks, GrowContactList);
      assert.match(textContent(empty), /No contacts match “UAT1” with the Buyer role/);
      assert.doesNotMatch(textContent(empty), /Ada Buyer/);
      assert.doesNotMatch(textContent(empty), /Showing 1 of 1 contact/);

      (globalThis as { __listFetching?: string | null }).__listFetching = "grow-contacts";
      findAll(empty, (element) => element.props?.["aria-label"] === "Search contacts")[0]!.props!.onChange!({
        target: { value: "Seller" },
      });
      const typing = render(hooks, GrowContactList);
      findAll(typing, (element) => element.type === "form" && textContent(element).includes("All roles"))[0]!.props!.onSubmit!({
        preventDefault() {},
      });
      const inflight = render(hooks, GrowContactList);
      assert.doesNotMatch(textContent(inflight), /No contacts match “UAT1”/, "the previous empty sentence does not stay up");
      assert.match(textContent(inflight), /Loading/);

      (globalThis as { __listFetching?: string | null }).__listFetching = null;
      const results = render(hooks, GrowContactList);
      assert.doesNotMatch(textContent(results), /No contacts match/);
      assert.match(textContent(results), /Showing 38 of 38 contacts/);
      const sellerQuery = lastQuery(queries, "grow-contacts");
      calls.length = 0;
      await sellerQuery.queryFn();
      assert.equal(calls.at(-1), "/grow/contacts?search=Seller&role=Buyer");
    });
  } finally {
    clearGlobals();
  }
});

test("relationship and activity search is debounced, resets the cursor, and clears its empty state", async (t) => {
  const { hooks, calls, queries } = install();
  try {
    await withVite(async (vite) => {
      const { GrowContactList } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as { GrowContactList: () => unknown };
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const loaded = render(hooks, GrowContactList);
      hooks.flushEffects();
      const relationshipLabel = findAll(
        loaded,
        (element) => element.type === "label" && element.props?.htmlFor === "grow-relationships-search",
      )[0];
      assert.match(textContent(relationshipLabel), /Search relationships/);
      assert.equal(byId(loaded, "grow-relationships-search").props?.type, "search");
      assert.match(textContent(loaded), /Showing 1 of 280 relationships/);

      const loadMore = findAll(loaded, (element) => element.props?.["aria-label"] === "Load more relationships")[0];
      loadMore!.props!.onClick!();
      await new Promise((resolve) => setImmediate(resolve));
      const paged = render(hooks, GrowContactList);
      assert.match(textContent(paged), /Bravo/);
      assert.ok(calls.some((path) => path === "/grow/relationships?cursor=rel-cursor"));

      byId(paged, "grow-relationships-search").props!.onChange!({ target: { value: "Queen" } });
      const typed = render(hooks, GrowContactList);
      hooks.flushEffects();
      t.mock.timers.tick(299);
      const waiting = render(hooks, GrowContactList);
      assert.equal(lastQuery(queries, "grow-relationships").queryKey[1], "");
      assert.match(textContent(waiting), /Bravo/, "the list waits out the debounce");

      t.mock.timers.tick(1);
      const filtered = render(hooks, GrowContactList);
      assert.equal(lastQuery(queries, "grow-relationships").queryKey[1], "Queen");
      assert.doesNotMatch(textContent(filtered), /Bravo/);
      assert.doesNotMatch(textContent(filtered), /Alpha/);
      assert.match(textContent(filtered), /Queenie/);
      assert.match(textContent(filtered), /Showing 4 of 4 relationships/);
      calls.length = 0;
      await lastQuery(queries, "grow-relationships").queryFn();
      assert.equal(calls.at(-1), "/grow/relationships?search=Queen");

      byId(filtered, "grow-relationships-search").props!.onChange!({ target: { value: "zzz" } });
      render(hooks, GrowContactList);
      hooks.flushEffects();
      t.mock.timers.tick(300);
      const none = render(hooks, GrowContactList);
      assert.match(textContent(none), /No relationships match “zzz”/);
      assert.doesNotMatch(textContent(none), /Showing 4 of 4/);
      assert.doesNotMatch(textContent(none), /Queenie/);

      byId(none, "grow-activities-search").props!.onChange!({ target: { value: "nope" } });
      const activityTyped = render(hooks, GrowContactList);
      const activityForm = findAll(activityTyped, (element) => element.type === "form" && textContent(element).includes("Search activity"))[0];
      assert.equal(byId(activityTyped, "grow-activities-search").props?.type, "search");
      activityForm!.props!.onSubmit!({ preventDefault() {} });
      const activityEmpty = render(hooks, GrowContactList);
      assert.match(textContent(activityEmpty), /No activities match “nope”/);
      assert.equal(lastQuery(queries, "grow-activities").queryKey[1], "nope");
      calls.length = 0;
      await lastQuery(queries, "grow-activities").queryFn();
      assert.equal(calls.at(-1), "/grow/activities?search=nope");
      assert.equal(calls.at(-1)!.includes("cursor="), false);

      byId(activityEmpty, "grow-activities-search").props!.onChange!({ target: { value: "Logged" } });
      render(hooks, GrowContactList);
      findAll(render(hooks, GrowContactList), (element) => element.type === "form" && textContent(element).includes("Search activity"))[0]!.props!.onSubmit!({
        preventDefault() {},
      });
      const activityHit = render(hooks, GrowContactList);
      assert.doesNotMatch(textContent(activityHit), /No activities match/);
      assert.match(textContent(activityHit), /Showing 2 of 2 activities/);
      assert.match(textContent(activityHit), /Hit Logged/);
    });
  } finally {
    t.mock.timers.reset();
    clearGlobals();
  }
});

test("opportunity search sends search, resets the cursor, and does not send a type filter", async (t) => {
  const { hooks, calls, queries } = install();
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: (props: { onViewContact: (partyId: number) => void }) => unknown;
      };
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const renderTab = () => render(hooks, () => GrowOpportunitiesTab({ onViewContact: () => {} }));
      const loaded = renderTab();
      hooks.flushEffects();
      const label = findAll(loaded, (element) => element.type === "label" && element.props?.htmlFor === "grow-opportunities-search")[0];
      assert.match(textContent(label), /Search opportunities/);
      const input = byId(loaded, "grow-opportunities-search");
      assert.equal(input.props?.type, "search");
      assert.equal(
        findAll(loaded, (element) => element.props?.id === "grow-opportunities-type").length,
        0,
        "opportunity type stays out of this list",
      );
      assert.match(textContent(loaded), /Showing 1 of 3 opportunities/);

      const loadMore = findAll(loaded, (element) => element.props?.["aria-label"] === "Load more opportunities")[0];
      loadMore!.props!.onClick!();
      await new Promise((resolve) => setImmediate(resolve));
      const paged = renderTab();
      assert.match(textContent(paged), /Second reason/);
      assert.ok(calls.some((path) => path === "/grow/opportunities?cursor=opp-cursor"));

      byId(paged, "grow-opportunities-search").props!.onChange!({ target: { value: "missing" } });
      renderTab();
      hooks.flushEffects();
      t.mock.timers.tick(300);
      const empty = renderTab();
      assert.match(textContent(empty), /No opportunities match “missing”/);
      assert.doesNotMatch(textContent(empty), /Second reason/);
      assert.doesNotMatch(textContent(empty), /Open reason/);
      calls.length = 0;
      await lastQuery(queries, "grow-opportunities").queryFn();
      assert.equal(calls.at(-1), "/grow/opportunities?search=missing");
      assert.equal(calls.at(-1)!.includes("type="), false);
      assert.equal(calls.at(-1)!.includes("cursor="), false);

      byId(empty, "grow-opportunities-search").props!.onChange!({ target: { value: "vendor" } });
      renderTab();
      hooks.flushEffects();
      t.mock.timers.tick(300);
      const results = renderTab();
      assert.doesNotMatch(textContent(results), /No opportunities match/);
      assert.match(textContent(results), /Showing 38 of 38 opportunities/);
      calls.length = 0;
      await lastQuery(queries, "grow-opportunities").queryFn();
      assert.equal(calls.at(-1), "/grow/opportunities?search=vendor");
    });
  } finally {
    t.mock.timers.reset();
    clearGlobals();
  }
});

test("opportunity search composes with the type filter, resets the cursor, and keeps the total", async (t) => {
  const { hooks, calls, queries } = install();
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: (props: { onViewContact: (partyId: number) => void }) => unknown;
      };
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const renderTab = () => render(hooks, () => GrowOpportunitiesTab({ onViewContact: () => {} }));
      const loaded = renderTab();
      hooks.flushEffects();
      assert.equal(byId(loaded, "grow-opportunity-type-filter").props?.value, "all");
      assert.match(textContent(loaded), /Showing 1 of 3 opportunities/);

      findAll(loaded, (element) => element.props?.["aria-label"] === "Load more opportunities")[0]!.props!.onClick!();
      await new Promise((resolve) => setImmediate(resolve));
      const paged = renderTab();
      assert.match(textContent(paged), /Second reason/);

      byId(paged, "grow-opportunities-search").props!.onChange!({ target: { value: "Ada" } });
      renderTab();
      hooks.flushEffects();
      t.mock.timers.tick(300);
      const searched = renderTab();
      assert.doesNotMatch(textContent(searched), /Second reason/);
      assert.match(textContent(searched), /Showing 1 of 5 opportunities/);
      assert.match(textContent(searched), /Ada open/);
      assert.deepEqual(lastQuery(queries, "grow-opportunities").queryKey, ["grow-opportunities", "all", "Ada"]);
      calls.length = 0;
      await lastQuery(queries, "grow-opportunities").queryFn();
      assert.equal(calls.at(-1), "/grow/opportunities?search=Ada");

      findAll(searched, (element) => element.props?.["aria-label"] === "Load more opportunities")[0]!.props!.onClick!();
      await new Promise((resolve) => setImmediate(resolve));
      const searchedPage = renderTab();
      assert.match(textContent(searchedPage), /Ada second/);
      assert.match(textContent(searchedPage), /Showing 2 of 5 opportunities/);
      assert.ok(calls.some((path) => path === "/grow/opportunities?search=Ada&cursor=ada-cursor"));

      byId(searchedPage, "grow-opportunity-type-filter").props!.onChange!({ target: { value: "seller_side" } });
      const both = renderTab();
      assert.doesNotMatch(textContent(both), /Ada second/);
      assert.doesNotMatch(textContent(both), /Ada open/);
      assert.match(textContent(both), /Ada seller/);
      assert.match(textContent(both), /Showing 1 of 1 opportunity/);
      assert.deepEqual(lastQuery(queries, "grow-opportunities").queryKey, ["grow-opportunities", "seller_side", "Ada"]);
      calls.length = 0;
      await lastQuery(queries, "grow-opportunities").queryFn();
      assert.equal(calls.at(-1), "/grow/opportunities?search=Ada&type=seller_side");
      assert.equal(calls.at(-1)!.includes("cursor="), false);
    });
  } finally {
    t.mock.timers.reset();
    clearGlobals();
  }
});
