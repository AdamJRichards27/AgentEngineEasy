import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

// AE GROW Completion W2-B (E-3) component-behaviour tests, same harness as
// GrowDataRegion.behavior.test.ts / GrowCallFollowupsSection.behavior.test.ts:
// React, React Query, wouter, the session/entitlement hooks and the API client
// are replaced with tiny in-memory fakes so the real component functions run
// under node without a DOM.
//
// The defect under test: an opportunity row was a terminal state. Both the
// Opportunities tab and Contact 360's opportunities table rendered plain <td>
// text — no contact link, no property link, no action — while the identical
// record was fully actionable on Grow Today. These tests assert that both
// tables now offer the next steps, and that the follow-up write they perform is
// the SAME PATCH /grow/opportunities/:id Grow Today already used, not a second
// mutation that could drift from it.

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

function links(tree: unknown): string[] {
  return findAll(tree, (element) => element.type === "a").map((element) => String(element.props?.href));
}

function byId(tree: unknown, id: string): ElementNode | undefined {
  return findAll(tree, (element) => element.props?.id === id)[0];
}

function form(tree: unknown): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "form" && element.props?.role !== "search")[0];
}

class FakeApiError extends Error {
  status: number;
  friendly: string;
  correlationId?: string;
  constructor(status: number, friendly: string, correlationId?: string) {
    super(friendly);
    this.status = status;
    this.friendly = friendly;
    this.correlationId = correlationId;
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
  name: "w2b-opportunity-actions-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:w2b-react") return "\0w2b-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:w2b-jsx") return "\0w2b-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:w2b-query") return "\0w2b-query";
    if (source === "wouter" || source === "virtual:w2b-wouter") return "\0w2b-wouter";
    if (source === "../lib/api") return "\0w2b-api";
    if (source === "../lib/session") return "\0w2b-session";
    // Grow.tsx's heavy child components are never invoked by this harness (jsx()
    // records the element, it does not call the function), so they only need to
    // exist as importable names. components/GrowDataRegion is deliberately NOT
    // stubbed: the region states asserted below are the shipped ones.
    if (
      source === "../components/AskAgentEngine" ||
      source === "../components/CommunicationsSection" ||
      source === "../components/PropertyIntelligencePanel" ||
      source === "../components/GrowContactTranscriptPanel" ||
      source === "../components/GrowPendingCommitmentProposals" ||
      source === "../components/ErrorBoundary"
    ) {
      return "\0w2b-components";
    }
    return null;
  },
  load(id) {
    if (id === "\0w2b-react") {
      return `
        export const useState = (...args) => globalThis.__w2bHooks.useState(...args);
        export const useEffect = (...args) => globalThis.__w2bHooks.useEffect(...args);
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0w2b-jsx") {
      // Unlike the earlier behaviour harnesses, this one CALLS function
      // components rather than only recording the element: the whole point of
      // these tests is what a row renders, and the row's actions live in a
      // child component. Children are evaluated in source order, so the shared
      // hook cursor stays deterministic between renders.
      return `
        export const Fragment = Symbol.for("w2b-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0w2b-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries: (filter) => globalThis.__w2bInvalidated.push(filter.queryKey) });
        export const useQuery = () => globalThis.__w2bQuery;
        export const useMutation = (options) => ({
          isPending: false,
          isError: globalThis.__w2bMutationError != null,
          error: globalThis.__w2bMutationError ?? null,
          mutate(input) {
            globalThis.__w2bPending.push(
              Promise.resolve(options.mutationFn(input)).then(
                (result) => { options.onSuccess?.(result, input); },
                (error) => { options.onError?.(error, input); },
              ),
            );
          },
        });
      `;
    }
    if (id === "\0w2b-wouter") {
      return `
        export const Link = (props) => ({ type: "a", props });
        export const useSearch = () => globalThis.__w2bSearch ?? "";
      `;
    }
    if (id === "\0w2b-api") {
      return `
        export const ApiError = globalThis.__w2bApiError;
        export const apiFetch = (path, options) => globalThis.__w2bApiFetch(path, options);
        export function apiErrorMessage(error, fallback) {
          if (error instanceof ApiError && typeof error.friendly === "string" && error.friendly.trim()) return error.friendly;
          return fallback;
        }
      `;
    }
    if (id === "\0w2b-session") {
      return `
        export const useSession = () => ({ user: { id: 1, firstName: "Sam", role: "Agent" } });
        export const useEntitlements = () => ({
          isLoading: false,
          hasEntitlement: (key) => globalThis.__w2bEntitlements.includes(key),
        });
      `;
    }
    if (id === "\0w2b-components") {
      return `
        export const AskAgentEngine = () => null;
        export const ContactCommunicationsSection = () => null;
        export const PropertyIntelligencePanel = () => null;
        export const GrowContactTranscriptPanel = () => null;
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
        { find: /^react$/, replacement: "virtual:w2b-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:w2b-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:w2b-query" },
        { find: /^wouter$/, replacement: "virtual:w2b-wouter" },
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

const opportunity = (overrides: Record<string, unknown> = {}) => ({
  id: 41,
  opportunityType: "Appraisal",
  status: "Open",
  stage: "Qualified",
  reason: "Enquired about a market appraisal last week",
  partyId: 12,
  propertyId: 77,
  recommendedNextAction: null,
  nextActionDueAt: null,
  ...overrides,
});

function installGlobals(over: Record<string, unknown> = {}) {
  const hooks = createHarness();
  const calls: Call[] = [];
  const invalidated: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  Object.assign(globalThis, {
    __w2bHooks: hooks,
    __w2bApiError: FakeApiError,
    __w2bInvalidated: invalidated,
    __w2bPending: pending,
    __w2bEntitlements: ["grow.access", "run.access", "grow.contacts.read", "grow.opportunities.manage"],
    __w2bMutationError: null,
    __w2bSearch: "",
    __w2bQuery: { isLoading: false, isError: false, data: { opportunities: [opportunity()] }, refetch: () => {} },
    __w2bApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, options });
      return Promise.resolve({ opportunity: { id: 41 } });
    },
    ...over,
  });
  return { hooks, calls, invalidated, pending };
}

function clearGlobals() {
  for (const key of [
    "__w2bHooks",
    "__w2bApiError",
    "__w2bInvalidated",
    "__w2bPending",
    "__w2bEntitlements",
    "__w2bMutationError",
    "__w2bSearch",
    "__w2bQuery",
    "__w2bApiFetch",
  ]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

test("E-3: an Opportunities tab row offers contact, property and follow-up, and reuses Today's PATCH", async () => {
  const { hooks, calls, invalidated, pending } = installGlobals();
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: (props: Record<string, unknown>) => unknown;
      };
      const viewed: number[] = [];
      const render = () => {
        hooks.beginRender();
        return GrowOpportunitiesTab({ onViewContact: (partyId: number) => viewed.push(partyId) });
      };

      let tree = render();

      // The row is no longer a dead end.
      const viewContact = button(tree, "View contact");
      assert.ok(viewContact, "a row offers its contact");
      (viewContact.props!.onClick as () => void)();
      assert.deepEqual(viewed, [12], "View contact opens THIS opportunity's contact");

      assert.deepEqual(links(tree), ["/properties/77"], "a row with a property links to it");
      assert.ok(button(tree, "Set due follow-up"), "a row offers the follow-up Grow Today already offered");

      // Opening the form and saving hits the one opportunity write.
      (button(tree, "Set due follow-up")!.props!.onClick as () => void)();
      tree = render();
      const dueAt = byId(tree, "grow-opportunity-41-date");
      const text = byId(tree, "grow-opportunity-41-text");
      assert.ok(dueAt && text, "the shared next-action form is rendered for this row");
      (text.props!.onChange as (e: unknown) => void)({ target: { value: "Call to confirm appraisal time" } });

      tree = render();
      await (form(tree)!.props!.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
      await Promise.all(pending);

      assert.equal(calls.length, 1, "exactly one write");
      assert.equal(calls[0].path, "/grow/opportunities/41", "the same route Grow Today's card PATCHes");
      assert.equal(calls[0].options?.method, "PATCH");
      assert.deepEqual(JSON.parse(calls[0].options!.body!), { recommendedNextAction: "Call to confirm appraisal time" });
      assert.ok(
        invalidated.some((key) => Array.isArray(key) && key[0] === "grow-today"),
        "Today's feed is stale once a follow-up exists, so it is invalidated",
      );
    });
  } finally {
    clearGlobals();
  }
});

test("E-3: a row with no property offers no property link, and an empty form never writes", async () => {
  const { hooks, calls, pending } = installGlobals({
    __w2bQuery: {
      isLoading: false,
      isError: false,
      data: { opportunities: [opportunity({ id: 42, propertyId: null, reason: null })] },
      refetch: () => {},
    },
  });
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: (props: Record<string, unknown>) => unknown;
      };
      const render = () => {
        hooks.beginRender();
        return GrowOpportunitiesTab({ onViewContact: () => {} });
      };

      let tree = render();
      assert.deepEqual(links(tree), [], "no property means no link — never /properties/null");
      assert.ok(button(tree, "View contact"), "the contact is still reachable");
      assert.doesNotMatch(textContent(tree), /null/, "a missing reason renders as a dash, not 'null'");

      (button(tree, "Set due follow-up")!.props!.onClick as () => void)();
      tree = render();
      await (form(tree)!.props!.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
      await Promise.all(pending);
      assert.deepEqual(calls, [], "submitting with neither field filled in writes nothing");
    });
  } finally {
    clearGlobals();
  }
});

test("E-3: Contact 360's opportunities table is actionable too, without a redundant View contact", async () => {
  const { hooks, calls, pending } = installGlobals();
  try {
    await withVite(async (vite) => {
      const { GrowContactOpportunitiesSection } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowContactOpportunitiesSection: (props: Record<string, unknown>) => unknown;
      };
      let changed = 0;
      const render = () => {
        hooks.beginRender();
        return GrowContactOpportunitiesSection({
          partyId: 12,
          opportunities: [{ id: 41, opportunityType: "Appraisal", status: "Open", stage: "Qualified", reason: "Enquired", nextActionDueAt: null, recommendedNextAction: null, propertyId: 77 }],
          onChanged: () => changed++,
        });
      };

      let tree = render();
      assert.equal(button(tree, "View contact"), undefined, "you are already on this contact");
      assert.deepEqual(links(tree), ["/properties/77"], "the property is reachable");
      assert.ok(button(tree, "Set due follow-up"), "the same follow-up action as every other surface");

      (button(tree, "Set due follow-up")!.props!.onClick as () => void)();
      tree = render();
      (byId(tree, "grow-opportunity-41-text")!.props!.onChange as (e: unknown) => void)({ target: { value: "Book the appraisal" } });
      tree = render();
      await (form(tree)!.props!.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
      await Promise.all(pending);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, "/grow/opportunities/41", "same route as the Opportunities tab and Grow Today");
      assert.equal(changed, 1, "Contact 360 refreshes itself once the follow-up exists");
    });
  } finally {
    clearGlobals();
  }
});

test("E-3: without grow.opportunities.manage no follow-up button is offered on either table", async () => {
  const { hooks } = installGlobals({ __w2bEntitlements: ["grow.access", "grow.contacts.read"] });
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: (props: Record<string, unknown>) => unknown;
      };
      hooks.beginRender();
      const tree = GrowOpportunitiesTab({ onViewContact: () => {} });
      assert.equal(button(tree, "Set due follow-up"), undefined, "a button that would only 403 is never shown");
      assert.equal(button(tree, "Add note"), undefined, "a note button that would only 403 is never shown");
      assert.equal(button(tree, "Ask AE"), undefined, "Ask AE is only offered when the tab is given Today's switch");
      assert.ok(button(tree, "View contact"), "reading the contact is still offered");
      // Owner D5: without run.access the row never links into the Run property workspace.
      assert.equal(JSON.stringify(tree, (_k, v) => (typeof v === "function" ? undefined : v)).includes("/properties/"), false, "no Run property link for a Grow-only user");
    });
  } finally {
    clearGlobals();
  }
});

test("E-3: an Opportunities row adds a note with Today's POST, and Ask AE uses Today's tab switch", async () => {
  const asked: string[] = [];
  const { hooks, calls, invalidated, pending } = installGlobals({
    __w2bEntitlements: ["grow.access", "run.access", "grow.contacts.read", "grow.opportunities.manage", "grow.activities.manage"],
  });
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: (props: Record<string, unknown>) => unknown;
      };
      const render = () => {
        hooks.beginRender();
        return GrowOpportunitiesTab({
          onViewContact: () => {},
          onAskAE: () => asked.push("ask"),
        });
      };

      let tree = render();
      assert.ok(button(tree, "Add note"), "the row offers the note Grow Today already offers");
      assert.ok(button(tree, "View contact"));
      assert.ok(button(tree, "Set due follow-up"));
      assert.deepEqual(links(tree), ["/properties/77"]);

      (button(tree, "Ask AE")!.props!.onClick as () => void)();
      assert.deepEqual(asked, ["ask"], "Ask AE is the workspace tab switch, not a new destination");

      (button(tree, "Add note")!.props!.onClick as () => void)();
      tree = render();
      const blank = byId(tree, "grow-opportunity-note-41-note");
      assert.ok(blank, "the shared note form is rendered for this row");
      (blank.props!.onChange as (e: unknown) => void)({ target: { value: "   " } });
      tree = render();
      await (form(tree)!.props!.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
      await Promise.all(pending);
      assert.deepEqual(calls, [], "a blank note writes nothing");

      (byId(tree, "grow-opportunity-note-41-note")!.props!.onChange as (e: unknown) => void)({
        target: { value: "Spoke with the owner" },
      });
      tree = render();
      await (form(tree)!.props!.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
      await Promise.all(pending);

      assert.equal(calls.length, 1, "exactly one write");
      assert.equal(calls[0].path, "/grow/activities", "the same route Grow Today's card POSTs");
      assert.equal(calls[0].options?.method, "POST");
      assert.deepEqual(JSON.parse(calls[0].options!.body!), {
        activityType: "note",
        summary: "Spoke with the owner",
        partyId: 12,
        propertyId: 77,
        opportunityId: 41,
      });
      assert.ok(
        invalidated.some((key) => Array.isArray(key) && key[0] === "grow-today"),
        "Today's feed is invalidated once a note exists",
      );
      assert.ok(
        invalidated.some((key) => Array.isArray(key) && key[0] === "grow-activities"),
        "the activity list is invalidated too",
      );
    });
  } finally {
    clearGlobals();
  }
});

test("E-3: a note on an opportunity with no property omits propertyId", async () => {
  const { hooks, calls, pending } = installGlobals({
    __w2bEntitlements: ["grow.access", "grow.activities.manage"],
    __w2bQuery: {
      isLoading: false,
      isError: false,
      data: { opportunities: [opportunity({ id: 42, propertyId: null })] },
      refetch: () => {},
    },
  });
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: (props: Record<string, unknown>) => unknown;
      };
      const render = () => {
        hooks.beginRender();
        return GrowOpportunitiesTab({ onViewContact: () => {} });
      };

      let tree = render();
      assert.deepEqual(links(tree), [], "no property means no link");
      assert.equal(button(tree, "Ask AE"), undefined, "Ask AE is absent unless the workspace passes the switch");
      (button(tree, "Add note")!.props!.onClick as () => void)();
      tree = render();
      (byId(tree, "grow-opportunity-note-42-note")!.props!.onChange as (e: unknown) => void)({
        target: { value: "No property yet" },
      });
      tree = render();
      await (form(tree)!.props!.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
      await Promise.all(pending);

      assert.equal(calls.length, 1);
      assert.deepEqual(JSON.parse(calls[0].options!.body!), {
        activityType: "note",
        summary: "No property yet",
        partyId: 12,
        opportunityId: 42,
      });
    });
  } finally {
    clearGlobals();
  }
});

test("E-3: Contact 360 can add a note on an opportunity, and does not offer Ask AE", async () => {
  const { hooks, calls, pending } = installGlobals({
    __w2bEntitlements: ["grow.access", "grow.activities.manage", "grow.opportunities.manage"],
  });
  try {
    await withVite(async (vite) => {
      const { GrowContactOpportunitiesSection } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowContactOpportunitiesSection: (props: Record<string, unknown>) => unknown;
      };
      const render = () => {
        hooks.beginRender();
        return GrowContactOpportunitiesSection({
          partyId: 12,
          opportunities: [
            {
              id: 41,
              opportunityType: "Appraisal",
              status: "Open",
              stage: "Qualified",
              reason: "Enquired",
              nextActionDueAt: null,
              recommendedNextAction: null,
              propertyId: 77,
            },
          ],
          onChanged: () => {},
        });
      };

      let tree = render();
      assert.equal(button(tree, "View contact"), undefined);
      assert.equal(button(tree, "Ask AE"), undefined, "Ask AE is a workspace jump this screen does not own");
      (button(tree, "Add note")!.props!.onClick as () => void)();
      tree = render();
      (byId(tree, "grow-opportunity-note-41-note")!.props!.onChange as (e: unknown) => void)({
        target: { value: "Booked a time" },
      });
      tree = render();
      await (form(tree)!.props!.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
      await Promise.all(pending);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, "/grow/activities");
      assert.deepEqual(JSON.parse(calls[0].options!.body!), {
        activityType: "note",
        summary: "Booked a time",
        partyId: 12,
        propertyId: 77,
        opportunityId: 41,
      });
    });
  } finally {
    clearGlobals();
  }
});

test("G-4: a failed Opportunities fetch shows the failure and a retry, never an empty table", async () => {
  const { hooks } = installGlobals({
    __w2bQuery: {
      isLoading: false,
      isError: true,
      error: new FakeApiError(500, "Something went wrong on our end. Try again in a moment.", "3f9c2a1b-7d4e"),
      data: undefined,
      refetch: () => {},
    },
  });
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: (props: Record<string, unknown>) => unknown;
      };
      hooks.beginRender();
      const tree = GrowOpportunitiesTab({ onViewContact: () => {} });
      const text = textContent(tree);
      assert.match(text, /Something went wrong on our end/);
      assert.doesNotMatch(text, /No opportunities yet/, "a failure never reads as an empty list");
      assert.ok(button(tree, "Try again"));
    });
  } finally {
    clearGlobals();
  }
});

test("E-6/E-7: /grow deep-link parameters open the right tab and contact, and junk is ignored", async () => {
  installGlobals();
  try {
    await withVite(async (vite) => {
      const { growWorkspaceEntryState } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        growWorkspaceEntryState: (search: string) => { tab: string; contactPartyId: number | null };
      };

      // Older ?contact= links still name the contact. The address bar is rewritten to /grow/contacts/:id.
      assert.deepEqual(growWorkspaceEntryState("?tab=contacts&contact=12"), { tab: "contacts", contactPartyId: 12 });
      assert.deepEqual(growWorkspaceEntryState("tab=contacts&contact=12"), { tab: "contacts", contactPartyId: 12 });
      // A contact alone still lands on the only tab that can render it.
      assert.deepEqual(growWorkspaceEntryState("?contact=12"), { tab: "contacts", contactPartyId: 12 });
      // What the import results screen links to.
      assert.deepEqual(growWorkspaceEntryState("?tab=contacts"), { tab: "contacts", contactPartyId: null });

      // Nothing, or anything unparseable, lands on the normal Today view rather
      // than opening a contact that may not exist.
      assert.deepEqual(growWorkspaceEntryState(""), { tab: "today", contactPartyId: null });
      assert.deepEqual(growWorkspaceEntryState("?contact=null"), { tab: "today", contactPartyId: null });
      assert.deepEqual(growWorkspaceEntryState("?contact=-1"), { tab: "today", contactPartyId: null });
      assert.deepEqual(growWorkspaceEntryState("?contact=0"), { tab: "today", contactPartyId: null });
      assert.deepEqual(growWorkspaceEntryState("?contact=1e3"), { tab: "today", contactPartyId: null });
      assert.deepEqual(growWorkspaceEntryState("?tab=nonsense"), { tab: "today", contactPartyId: null });
    });
  } finally {
    clearGlobals();
  }
});
