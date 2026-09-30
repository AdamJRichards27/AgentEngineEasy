// G-UAT-6 — start an appraisal from Contact 360 or an opportunity, then the
// shortest status path and WON / LOST / DEFERRED. Write controls require
// grow.access and grow.opportunities.manage. No property means an explanation,
// not a button.

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

function byId(tree: unknown, id: string): ElementNode | undefined {
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
  name: "guat6-appraisal-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:guat6-react") return "\0guat6-react";
    if (source === "react/jsx-runtime" || source === "react/jsx-dev-runtime" || source === "virtual:guat6-jsx") return "\0guat6-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:guat6-query") return "\0guat6-query";
    if (source === "wouter" || source === "virtual:guat6-wouter") return "\0guat6-wouter";
    if (source === "../lib/api") return "\0guat6-api";
    if (source === "../lib/session") return "\0guat6-session";
    if (
      source === "../components/AskAgentEngine" ||
      source === "../components/CommunicationsSection" ||
      source === "../components/PropertyIntelligencePanel" ||
      source === "../components/GrowContactTranscriptPanel" ||
      source === "../components/GrowContactConsentPanel" ||
      source === "../components/GrowPendingCommitmentProposals" ||
      source === "../components/ErrorBoundary"
    ) {
      return "\0guat6-components";
    }
    return null;
  },
  load(id) {
    if (id === "\0guat6-react") {
      return `
        export const useState = (...args) => globalThis.__guat6Hooks.useState(...args);
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0guat6-jsx") {
      return `
        export const Fragment = Symbol.for("guat6-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0guat6-query") {
      return `
        export const useQueryClient = () => ({
          invalidateQueries: (filter) => globalThis.__guat6Invalidated.push(filter && filter.queryKey),
        });
        export const useQuery = (options) => {
          const key = options && options.queryKey && options.queryKey[0];
          if (key === "grow-appraisals") return globalThis.__guat6AppraisalQuery;
          return globalThis.__guat6OpportunityQuery;
        };
        export const useMutation = (options) => ({
          isPending: false,
          isError: false,
          error: null,
          mutate(input) {
            globalThis.__guat6Pending.push(
              Promise.resolve()
                .then(() => options.mutationFn(input))
                .then(
                  (result) => { options.onSuccess?.(result, input); },
                  (failure) => { options.onError?.(failure, input); },
                ),
            );
          },
        });
      `;
    }
    if (id === "\0guat6-wouter") {
      return `export const Link = (props) => ({ type: "a", props }); export const useSearch = () => "";`;
    }
    if (id === "\0guat6-api") {
      return `
        export const ApiError = globalThis.__guat6ApiError;
        export const apiFetch = (path, options) => globalThis.__guat6ApiFetch(path, options);
        export function apiErrorMessage(error, fallback) {
          if (error instanceof ApiError && typeof error.friendly === "string" && error.friendly.trim()) return error.friendly;
          return fallback;
        }
      `;
    }
    if (id === "\0guat6-session") {
      return `
        export const useSession = () => ({ user: { id: 1, firstName: "Sam", role: "Agent" } });
        export const useEntitlements = () => ({
          isLoading: false,
          hasEntitlement: (key) => globalThis.__guat6Entitlements.includes(key),
        });
      `;
    }
    if (id === "\0guat6-components") {
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
        { find: /^react$/, replacement: "virtual:guat6-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:guat6-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:guat6-query" },
        { find: /^wouter$/, replacement: "virtual:guat6-wouter" },
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

function queryResult(data: unknown) {
  return { isLoading: false, isError: false, data, error: null, refetch() {} };
}

function appraisal(overrides: Record<string, unknown> = {}) {
  return {
    id: 8,
    status: "DRAFT",
    outcome: null,
    propertyId: 77,
    propertyAddress: "77 Appraisal St",
    partyId: 12,
    ...overrides,
  };
}

function install(
  entitlements: string[],
  fetchImpl: (path: string, options?: { method?: string; body?: string }) => Promise<unknown>,
  appraisals: unknown[] = [],
) {
  const hooks = createHarness();
  const calls: Call[] = [];
  const invalidated: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  Object.assign(globalThis, {
    __guat6Hooks: hooks,
    __guat6ApiError: FakeApiError,
    __guat6Entitlements: entitlements,
    __guat6Invalidated: invalidated,
    __guat6Pending: pending,
    __guat6AppraisalQuery: queryResult({ appraisals }),
    __guat6OpportunityQuery: queryResult({
      opportunities: [
        {
          id: 41,
          opportunityType: "Appraisal",
          status: "Open",
          stage: "Qualified",
          reason: "Enquired",
          partyId: 12,
          propertyId: 77,
          recommendedNextAction: null,
          nextActionDueAt: null,
        },
      ],
    }),
    __guat6ApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, options });
      return fetchImpl(path, options);
    },
  });
  return { hooks, calls, invalidated, pending };
}

function clearGlobals() {
  for (const key of [
    "__guat6Hooks",
    "__guat6ApiError",
    "__guat6Entitlements",
    "__guat6Invalidated",
    "__guat6Pending",
    "__guat6AppraisalQuery",
    "__guat6OpportunityQuery",
    "__guat6ApiFetch",
  ]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

type ContactSection = (props: {
  partyId: number;
  linkedProperties: Array<{ propertyId: number | null; propertyAddress: string | null }>;
}) => unknown;

type OpportunitiesTab = (props: { onViewContact: (partyId: number) => void }) => unknown;

type ContactOpportunities = (props: {
  partyId: number;
  opportunities: Array<Record<string, unknown>>;
  onChanged: () => void;
}) => unknown;

const LINKED = [
  { propertyId: 77, propertyAddress: "77 Appraisal St" },
  { propertyId: null, propertyAddress: "No id" },
];

function assertRefetched(invalidated: unknown[], partyId: number) {
  assert.ok(
    invalidated.some((key) => Array.isArray(key) && key[0] === "grow-contact" && key[1] === partyId),
    "Contact 360 is refetched",
  );
  assert.ok(
    invalidated.some((key) => Array.isArray(key) && key.length === 1 && key[0] === "grow-opportunities"),
    "the Opportunities list is refetched",
  );
  assert.ok(
    invalidated.some((key) => Array.isArray(key) && key.length === 1 && key[0] === "grow-today"),
    "Grow Today is refetched",
  );
}

function assertNoLongPath(tree: unknown) {
  for (const label of ["Preparing", "Ready", "Sent", "Viewed"]) {
    assert.equal(button(tree, label), undefined, `${label} is not a Grow appraisal step`);
  }
}

test("appraisal writes are hidden without grow.opportunities.manage", async () => {
  await withVite(async (vite) => {
    const page = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
      GrowContactAppraisalsSection: ContactSection;
      GrowOpportunitiesTab: OpportunitiesTab;
    };
    const contactRun = install(["grow.access", "grow.contacts.read"], async () => ({}), [appraisal({ status: "PRESENTED" })]);
    try {
      contactRun.hooks.beginRender();
      const contact = page.GrowContactAppraisalsSection({ partyId: 12, linkedProperties: LINKED });
      assert.equal(button(contact, "Start appraisal"), undefined);
      assert.equal(button(contact, "Record outcome"), undefined);
      assert.equal(button(contact, "Appointment scheduled"), undefined);
      assert.match(textContent(contact), /77 Appraisal St/);
      assert.match(textContent(contact), /Presented/);
    } finally {
      clearGlobals();
    }

    const tabRun = install(["grow.access", "grow.contacts.read"], async () => ({}), [appraisal({ status: "PRESENTED" })]);
    try {
      tabRun.hooks.beginRender();
      const tab = page.GrowOpportunitiesTab({ onViewContact: () => {} });
      assert.equal(button(tab, "Start appraisal"), undefined);
      assert.equal(button(tab, "Record outcome"), undefined);
      assert.doesNotMatch(textContent(tab), /Link a property to start an appraisal/);
    } finally {
      clearGlobals();
    }
  });
});

test("a contact with no visible property explains that, and does not offer Start appraisal", async () => {
  const { hooks } = install(MANAGE, async () => ({}));
  try {
    await withVite(async (vite) => {
      const { GrowContactAppraisalsSection } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowContactAppraisalsSection: ContactSection;
      };
      hooks.beginRender();
      const tree = GrowContactAppraisalsSection({
        partyId: 12,
        linkedProperties: [{ propertyId: null, propertyAddress: "Missing" }],
      });
      assert.equal(button(tree, "Start appraisal"), undefined);
      assert.match(textContent(tree), /Link a property to start an appraisal/);
    });
  } finally {
    clearGlobals();
  }
});

test("Start appraisal from a contact posts partyId and the chosen propertyId", async () => {
  const { hooks, calls, invalidated, pending } = install(MANAGE, async () => ({ appraisal: { id: 8 } }));
  try {
    await withVite(async (vite) => {
      const { GrowContactAppraisalsSection } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowContactAppraisalsSection: ContactSection;
      };
      const render = () => {
        hooks.beginRender();
        return GrowContactAppraisalsSection({
          partyId: 12,
          linkedProperties: [
            { propertyId: 77, propertyAddress: "77 Appraisal St" },
            { propertyId: 88, propertyAddress: "88 Other St" },
            { propertyId: 77, propertyAddress: "77 Appraisal St" },
          ],
        });
      };
      let tree = render();
      assert.equal(byId(tree, "grow-contact-appraisal-property")!.props!.value, 77);
      (button(tree, "Start appraisal")!.props!.onClick as () => void)();
      await Promise.all(pending);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, "/grow/appraisals/from-contact");
      assert.equal(calls[0].options?.method, "POST");
      assert.deepEqual(JSON.parse(calls[0].options!.body!), { partyId: 12, propertyId: 77 });
      assertRefetched(invalidated, 12);

      tree = render();
      (byId(tree, "grow-contact-appraisal-property")!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "88" },
      });
      tree = render();
      (button(tree, "Start appraisal")!.props!.onClick as () => void)();
      await Promise.all(pending);
      assert.deepEqual(JSON.parse(calls[1].options!.body!), { partyId: 12, propertyId: 88 });
    });
  } finally {
    clearGlobals();
  }
});

test("Contact 360 lists only that contact's appraisals, with status and outcome", async () => {
  const { hooks } = install(MANAGE, async () => ({}), [
    appraisal(),
    appraisal({ id: 9, partyId: 99, propertyAddress: "Other contact", status: "WON", outcome: "WON" }),
  ]);
  try {
    await withVite(async (vite) => {
      const { GrowContactAppraisalsSection } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowContactAppraisalsSection: ContactSection;
      };
      hooks.beginRender();
      const tree = GrowContactAppraisalsSection({ partyId: 12, linkedProperties: LINKED });
      const text = textContent(tree);
      assert.match(text, /77 Appraisal St/);
      assert.match(text, /Status: Draft/);
      assert.match(text, /Outcome: Not recorded/);
      assert.doesNotMatch(text, /Other contact/);
      assert.equal(button(tree, "Appointment scheduled") !== undefined, true);
      assertNoLongPath(tree);
    });
  } finally {
    clearGlobals();
  }
});

test("status steps are offered only from the status that allows them, and post toStatus", async () => {
  const cases: Array<{ status: string; shown: string[]; hidden: string[]; post?: { id: string; toStatus: string } }> = [
    {
      status: "DRAFT",
      shown: ["Appointment scheduled"],
      hidden: ["Presented", "Needs follow-up", "Record outcome"],
      post: { id: "grow-appraisal-8-status-APPOINTMENT_SCHEDULED", toStatus: "APPOINTMENT_SCHEDULED" },
    },
    {
      status: "APPOINTMENT_SCHEDULED",
      shown: ["Presented", "Needs follow-up"],
      hidden: ["Appointment scheduled", "Record outcome"],
      post: { id: "grow-appraisal-8-status-PRESENTED", toStatus: "PRESENTED" },
    },
    {
      status: "PRESENTED",
      shown: ["Record outcome"],
      hidden: ["Appointment scheduled", "Presented", "Needs follow-up"],
    },
    {
      status: "FOLLOW_UP",
      shown: ["Record outcome"],
      hidden: ["Appointment scheduled", "Presented", "Needs follow-up"],
    },
  ];

  await withVite(async (vite) => {
    const { GrowContactAppraisalsSection } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
      GrowContactAppraisalsSection: ContactSection;
    };
    for (const item of cases) {
      const { hooks, calls, invalidated, pending } = install(MANAGE, async () => ({ appraisal: { id: 8 } }), [
        appraisal({ status: item.status }),
      ]);
      try {
        const render = () => {
          hooks.beginRender();
          return GrowContactAppraisalsSection({ partyId: 12, linkedProperties: LINKED });
        };
        const tree = render();
        assertNoLongPath(tree);
        for (const label of item.shown) assert.ok(button(tree, label), `${item.status} shows ${label}`);
        for (const label of item.hidden) assert.equal(button(tree, label), undefined, `${item.status} hides ${label}`);
        if (item.post) {
          (byId(tree, item.post.id)!.props!.onClick as () => void)();
          await Promise.all(pending);
          assert.equal(calls[0].path, "/grow/appraisals/8/status");
          assert.equal(calls[0].options?.method, "POST");
          assert.deepEqual(JSON.parse(calls[0].options!.body!), { toStatus: item.post.toStatus });
          assertRefetched(invalidated, 12);
        }
      } finally {
        clearGlobals();
      }
    }

    const followUp = install(MANAGE, async () => ({ appraisal: { id: 8 } }), [appraisal({ status: "APPOINTMENT_SCHEDULED" })]);
    try {
      followUp.hooks.beginRender();
      const tree = GrowContactAppraisalsSection({ partyId: 12, linkedProperties: LINKED });
      (byId(tree, "grow-appraisal-8-status-FOLLOW_UP")!.props!.onClick as () => void)();
      await Promise.all(followUp.pending);
      assert.deepEqual(JSON.parse(followUp.calls[0].options!.body!), { toStatus: "FOLLOW_UP" });
      assertRefetched(followUp.invalidated, 12);
    } finally {
      clearGlobals();
    }
  });
});

test("Record outcome posts WON, LOST and DEFERRED with reason and notes, then refetches", async () => {
  const { hooks, calls, invalidated, pending } = install(MANAGE, async () => ({ appraisal: { id: 8, status: "WON" } }), [
    appraisal({ status: "PRESENTED" }),
  ]);
  try {
    await withVite(async (vite) => {
      const { GrowContactAppraisalsSection } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowContactAppraisalsSection: ContactSection;
      };
      const render = () => {
        hooks.beginRender();
        return GrowContactAppraisalsSection({ partyId: 12, linkedProperties: LINKED });
      };
      for (const outcome of ["WON", "LOST", "DEFERRED"]) {
        let tree = render();
        (button(tree, "Record outcome")!.props!.onClick as () => void)();
        tree = render();
        (byId(tree, "grow-appraisal-8-outcome")!.props!.onChange as (event: { target: { value: string } }) => void)({
          target: { value: outcome },
        });
        tree = render();
        (byId(tree, "grow-appraisal-8-outcome-reason")!.props!.onChange as (event: { target: { value: string } }) => void)({
          target: { value: "relationship" },
        });
        tree = render();
        (byId(tree, "grow-appraisal-8-outcome-notes")!.props!.onChange as (event: { target: { value: string } }) => void)({
          target: { value: `Notes for ${outcome}` },
        });
        tree = render();
        await (formElement(tree)!.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
        await Promise.all(pending);
      }
      assert.equal(calls.length, 3);
      for (const [index, outcome] of ["WON", "LOST", "DEFERRED"].entries()) {
        assert.equal(calls[index].path, "/grow/appraisals/8/outcome");
        assert.equal(calls[index].options?.method, "POST");
        assert.deepEqual(JSON.parse(calls[index].options!.body!), {
          outcome,
          outcomeReason: "relationship",
          outcomeNotes: `Notes for ${outcome}`,
        });
      }
      assertRefetched(invalidated, 12);
    });
  } finally {
    clearGlobals();
  }
});

test("FOLLOW_UP also offers Record outcome", async () => {
  const { hooks } = install(MANAGE, async () => ({}), [appraisal({ status: "FOLLOW_UP" })]);
  try {
    await withVite(async (vite) => {
      const { GrowContactAppraisalsSection } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowContactAppraisalsSection: ContactSection;
      };
      hooks.beginRender();
      const tree = GrowContactAppraisalsSection({ partyId: 12, linkedProperties: LINKED });
      assert.ok(button(tree, "Record outcome"));
      assert.equal(button(tree, "Appointment scheduled"), undefined);
      assert.equal(button(tree, "Presented"), undefined);
    });
  } finally {
    clearGlobals();
  }
});

test("400, 403, 404 and 409 from starting an appraisal show a plain message", async () => {
  const cases: Array<{ status: number; friendly: string; expected: RegExp }> = [
    { status: 400, friendly: "Invalid request", expected: /Invalid request/ },
    { status: 403, friendly: "You don't have permission to update this appraisal.", expected: /don't have permission/ },
    { status: 404, friendly: "Property not found", expected: /That couldn't be found/ },
    { status: 409, friendly: "Cannot record outcome WON from status DRAFT", expected: /Cannot record outcome WON from status DRAFT/ },
  ];
  let current = cases[0];
  const { hooks, invalidated, pending } = install(MANAGE, async () => {
    throw new FakeApiError(current.status, current.friendly);
  });
  try {
    await withVite(async (vite) => {
      const { GrowContactAppraisalsSection } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowContactAppraisalsSection: ContactSection;
      };
      for (const item of cases) {
        current = item;
        invalidated.length = 0;
        pending.length = 0;
        const render = () => {
          hooks.beginRender();
          return GrowContactAppraisalsSection({ partyId: 12, linkedProperties: LINKED });
        };
        const tree = render();
        (button(tree, "Start appraisal")!.props!.onClick as () => void)();
        await Promise.all(pending);
        const done = render();
        assert.match(textContent(done), item.expected, `status ${item.status}`);
        assert.equal(invalidated.length, 0, "a failed write does not refetch");
      }
    });
  } finally {
    clearGlobals();
  }
});

test("Start appraisal from an opportunity posts opportunityId, and 409 is shown plainly", async () => {
  const started = install(MANAGE, async () => ({ appraisal: { id: 8, status: "DRAFT" } }));
  try {
    await withVite(async (vite) => {
      const page = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: OpportunitiesTab;
        GrowContactOpportunitiesSection: ContactOpportunities;
      };
      const renderTab = () => {
        started.hooks.beginRender();
        return page.GrowOpportunitiesTab({ onViewContact: () => {} });
      };
      let tree = renderTab();
      (button(tree, "Start appraisal")!.props!.onClick as () => void)();
      await Promise.all(started.pending);
      assert.equal(started.calls[0].path, "/grow/appraisals/from-opportunity");
      assert.equal(started.calls[0].options?.method, "POST");
      assert.deepEqual(JSON.parse(started.calls[0].options!.body!), { opportunityId: 41 });
      assertRefetched(started.invalidated, 12);
    });
  } finally {
    clearGlobals();
  }

  const contactOpportunity = install(MANAGE, async () => ({ appraisal: { id: 8, status: "DRAFT" } }));
  try {
    await withVite(async (vite) => {
      const { GrowContactOpportunitiesSection } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowContactOpportunitiesSection: ContactOpportunities;
      };
      contactOpportunity.hooks.beginRender();
      const tree = GrowContactOpportunitiesSection({
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
      (byId(tree, "grow-opportunity-start-appraisal-41")!.props!.onClick as () => void)();
      await Promise.all(contactOpportunity.pending);
      assert.equal(contactOpportunity.calls[0].path, "/grow/appraisals/from-opportunity");
      assert.deepEqual(JSON.parse(contactOpportunity.calls[0].options!.body!), { opportunityId: 41 });
      assertRefetched(contactOpportunity.invalidated, 12);
    });
  } finally {
    clearGlobals();
  }

  const failed = install(MANAGE, async (path) => {
    if (path === "/grow/appraisals/from-opportunity") {
      throw new FakeApiError(409, "Opportunity has no linked property yet -- link or create a property before starting an appraisal");
    }
    return {};
  });
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: OpportunitiesTab;
      };
      const render = () => {
        failed.hooks.beginRender();
        return GrowOpportunitiesTab({ onViewContact: () => {} });
      };
      const tree = render();
      (button(tree, "Start appraisal")!.props!.onClick as () => void)();
      await Promise.all(failed.pending);
      const done = render();
      assert.match(textContent(done), /Opportunity has no linked property yet/);
      assert.equal(failed.invalidated.length, 0);
    });
  } finally {
    clearGlobals();
  }
});

test("an opportunity with no property explains that, and a started appraisal offers the next step", async () => {
  const { hooks, calls, pending, invalidated } = install(MANAGE, async () => ({ appraisal: { id: 8 } }), [
    appraisal({ status: "DRAFT" }),
  ]);
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: OpportunitiesTab;
      };
      (globalThis as { __guat6OpportunityQuery: ReturnType<typeof queryResult> }).__guat6OpportunityQuery = queryResult({
        opportunities: [
          {
            id: 42,
            opportunityType: "Appraisal",
            status: "Open",
            stage: "Qualified",
            reason: null,
            partyId: 12,
            propertyId: null,
            recommendedNextAction: null,
            nextActionDueAt: null,
          },
          {
            id: 41,
            opportunityType: "Appraisal",
            status: "Open",
            stage: "Qualified",
            reason: "Enquired",
            partyId: 12,
            propertyId: 77,
            recommendedNextAction: null,
            nextActionDueAt: null,
          },
        ],
      });
      const render = () => {
        hooks.beginRender();
        return GrowOpportunitiesTab({ onViewContact: () => {} });
      };
      const tree = render();
      assert.equal(byId(tree, "grow-opportunity-start-appraisal-42"), undefined);
      assert.match(textContent(tree), /Link a property to start an appraisal/);
      assert.ok(byId(tree, "grow-opportunity-start-appraisal-41"));
      assert.ok(button(tree, "Appointment scheduled"));
      assert.equal(button(tree, "Record outcome"), undefined);
      (byId(tree, "grow-appraisal-8-status-APPOINTMENT_SCHEDULED")!.props!.onClick as () => void)();
      await Promise.all(pending);
      assert.equal(calls[0].path, "/grow/appraisals/8/status");
      assert.deepEqual(JSON.parse(calls[0].options!.body!), { toStatus: "APPOINTMENT_SCHEDULED" });
      assertRefetched(invalidated, 12);
    });
  } finally {
    clearGlobals();
  }
});
