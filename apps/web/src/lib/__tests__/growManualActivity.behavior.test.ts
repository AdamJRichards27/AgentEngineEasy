// GP-3 — log a call or meeting that already happened, from Contact 360 and
// from an opportunity row. The write is POST /grow/activities. It does not
// place a call.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

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

function form(tree: unknown): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "form" && element.props?.role !== "search")[0];
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

const virtualMocks: Plugin = {
  name: "gp3-manual-activity-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:gp3-react") return "\0gp3-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:gp3-jsx") return "\0gp3-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:gp3-query") return "\0gp3-query";
    if (source === "wouter" || source === "virtual:gp3-wouter") return "\0gp3-wouter";
    if (source === "../lib/api") return "\0gp3-api";
    if (source === "../lib/session") return "\0gp3-session";
    if (
      source === "../components/AskAgentEngine" ||
      source === "../components/CommunicationsSection" ||
      source === "../components/PropertyIntelligencePanel" ||
      source === "../components/GrowContactTranscriptPanel" ||
      source === "../components/GrowPendingCommitmentProposals" ||
      source === "../components/ErrorBoundary"
    ) {
      return "\0gp3-components";
    }
    return null;
  },
  load(id) {
    if (id === "\0gp3-react") {
      return `
        export const useState = (...args) => globalThis.__gp3Hooks.useState(...args);
        export const useEffect = (...args) => globalThis.__gp3Hooks.useEffect(...args);
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0gp3-jsx") {
      return `
        export const Fragment = Symbol.for("gp3-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0gp3-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries: (filter) => globalThis.__gp3Invalidated.push(filter.queryKey) });
        export const useQuery = () => globalThis.__gp3Query;
        export const useMutation = (options) => ({
          isPending: false,
          isError: false,
          error: null,
          mutate(input) {
            globalThis.__gp3Pending.push(
              Promise.resolve(options.mutationFn(input)).then((result) => { options.onSuccess?.(result, input); }),
            );
          },
        });
      `;
    }
    if (id === "\0gp3-wouter") {
      return `
        export const Link = (props) => ({ type: "a", props });
        export const useSearch = () => "";
      `;
    }
    if (id === "\0gp3-api") {
      return `
        export class ApiError extends Error { constructor(status, friendly) { super(friendly); this.status = status; this.friendly = friendly; } }
        export const apiFetch = (path, options) => globalThis.__gp3ApiFetch(path, options);
        export function apiErrorMessage(error, fallback) { return fallback; }
      `;
    }
    if (id === "\0gp3-session") {
      return `
        export const useSession = () => ({ user: { id: 1, firstName: "Sam", role: "Agent" } });
        export const useEntitlements = () => ({
          isLoading: false,
          hasEntitlement: (key) => globalThis.__gp3Entitlements.includes(key),
        });
      `;
    }
    if (id === "\0gp3-components") {
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
        { find: /^react$/, replacement: "virtual:gp3-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:gp3-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:gp3-query" },
        { find: /^wouter$/, replacement: "virtual:gp3-wouter" },
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

function installGlobals(entitlements: string[]) {
  const hooks = createHarness();
  const calls: Call[] = [];
  const invalidated: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  Object.assign(globalThis, {
    __gp3Hooks: hooks,
    __gp3Invalidated: invalidated,
    __gp3Pending: pending,
    __gp3Entitlements: entitlements,
    __gp3Query: {
      isLoading: false,
      isError: false,
      data: {
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
      },
      refetch: () => {},
    },
    __gp3ApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, options });
      return Promise.resolve({ activity: { id: 9 } });
    },
  });
  return { hooks, calls, invalidated, pending };
}

function clearGlobals() {
  for (const key of ["__gp3Hooks", "__gp3Invalidated", "__gp3Pending", "__gp3Entitlements", "__gp3Query", "__gp3ApiFetch"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

const CAN_LOG = ["grow.access", "grow.contacts.read", "grow.activities.manage", "grow.opportunities.manage"];

function setValue(tree: unknown, id: string, value: string) {
  const node = byId(tree, id);
  assert.ok(node, id);
  (node.props!.onChange as (event: unknown) => void)({ target: { value } });
}

test("a user without grow.activities.manage is not offered the log form", async () => {
  const { hooks } = installGlobals(["grow.access", "grow.contacts.read", "grow.opportunities.manage"]);
  try {
    await withVite(async (vite) => {
      const { GrowOpportunitiesTab, GrowContactActivityLog } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowOpportunitiesTab: (props: Record<string, unknown>) => unknown;
        GrowContactActivityLog: (props: { partyId: number; canLog: boolean }) => unknown;
      };
      hooks.beginRender();
      const row = GrowOpportunitiesTab({ onViewContact: () => {} });
      assert.equal(button(row, "Log call or meeting"), undefined);
      assert.equal(button(row, "Add note"), undefined);
      hooks.beginRender();
      const contact = GrowContactActivityLog({ partyId: 12, canLog: false });
      assert.equal(contact, null);
    });
  } finally {
    clearGlobals();
  }
});

test("an opportunity row logs a past call through POST /grow/activities and does not place a call", async () => {
  const { hooks, calls, invalidated, pending } = installGlobals(CAN_LOG);
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
      assert.ok(button(tree, "Log call or meeting"));
      assert.ok(textContent(tree).includes("does not place a call") === false);
      (button(tree, "Log call or meeting")!.props!.onClick as () => void)();
      tree = render();
      assert.ok(textContent(tree).includes("does not place a call"));
      setValue(tree, "grow-opportunity-activity-41-type", "meeting");
      setValue(tree, "grow-opportunity-activity-41-occurred", "2026-03-15T14:30");
      setValue(tree, "grow-opportunity-activity-41-duration", "20");
      setValue(tree, "grow-opportunity-activity-41-outcome", "Booked the appraisal");
      setValue(tree, "grow-opportunity-activity-41-summary", "   ");
      tree = render();
      await (form(tree)!.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
      await Promise.all(pending);
      assert.deepEqual(calls, [], "a blank summary writes nothing");

      setValue(tree, "grow-opportunity-activity-41-summary", "Met Pat at the property");
      tree = render();
      await (form(tree)!.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
      await Promise.all(pending);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, "/grow/activities");
      assert.equal(calls[0].options?.method, "POST");
      assert.deepEqual(JSON.parse(calls[0].options!.body!), {
        activityType: "meeting",
        summary: "Met Pat at the property",
        occurredAt: new Date("2026-03-15T14:30").toISOString(),
        partyId: 12,
        propertyId: 77,
        opportunityId: 41,
        durationMinutes: 20,
        outcome: "Booked the appraisal",
      });
      assert.equal(JSON.stringify(calls).includes("callSession"), false);
      assert.ok(invalidated.some((key) => Array.isArray(key) && key[0] === "grow-today"));
      assert.ok(invalidated.some((key) => Array.isArray(key) && key[0] === "grow-activities"));
    });
  } finally {
    clearGlobals();
  }
});

test("Contact 360 logs a past call for that contact only", async () => {
  const { hooks, calls, invalidated, pending } = installGlobals(CAN_LOG);
  try {
    await withVite(async (vite) => {
      const { GrowContactActivityLog } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowContactActivityLog: (props: { partyId: number; canLog: boolean }) => unknown;
      };
      const render = () => {
        hooks.beginRender();
        return GrowContactActivityLog({ partyId: 12, canLog: true });
      };
      let tree = render();
      (button(tree, "Log call or meeting")!.props!.onClick as () => void)();
      tree = render();
      setValue(tree, "grow-contact-activity-12-occurred", "2026-03-15T09:00");
      setValue(tree, "grow-contact-activity-12-summary", "Called about the listing");
      tree = render();
      await (form(tree)!.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
      await Promise.all(pending);
      assert.equal(calls.length, 1);
      assert.deepEqual(JSON.parse(calls[0].options!.body!), {
        activityType: "call",
        summary: "Called about the listing",
        occurredAt: new Date("2026-03-15T09:00").toISOString(),
        partyId: 12,
      });
      assert.ok(invalidated.some((key) => Array.isArray(key) && key[0] === "grow-contact" && key[1] === 12));
    });
  } finally {
    clearGlobals();
  }
});

test("Contact 360's opportunity table uses the same log write", async () => {
  const { hooks, calls, pending } = installGlobals(CAN_LOG);
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
      (button(tree, "Log call or meeting")!.props!.onClick as () => void)();
      tree = render();
      setValue(tree, "grow-opportunity-activity-41-summary", "Called from the contact");
      setValue(tree, "grow-opportunity-activity-41-occurred", "2026-03-16T11:00");
      tree = render();
      await (form(tree)!.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
      await Promise.all(pending);
      assert.equal(calls.length, 1);
      const body = JSON.parse(calls[0].options!.body!) as { activityType: string; opportunityId: number; partyId: number };
      assert.equal(body.activityType, "call");
      assert.equal(body.opportunityId, 41);
      assert.equal(body.partyId, 12);
    });
  } finally {
    clearGlobals();
  }
});
