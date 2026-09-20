import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

// AE GROW Completion W2-B (E-6) — the Communications Hub's contact-first rows.
//
// The defect: the API has returned `propertyAddress: string | null` plus
// `partyDisplayName: string | null` since Priority 3 made a message's
// propertyId nullable, but the hand-maintained web mirror declared
// `propertyAddress: string` and omitted partyDisplayName entirely. The Hub
// therefore rendered `/properties/null` (Number("null") is NaN, which the API
// answers 400) and an empty address line for exactly the contact-first rows
// Priority 3 added. These tests cover both halves: where a row goes, and what
// it says — plus a structural guard so the mirror cannot drift again silently.

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

const virtualMocks: Plugin = {
  name: "w2b-hub-behavior-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:w2b-hub-react") return "\0w2b-hub-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:w2b-hub-jsx") return "\0w2b-hub-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:w2b-hub-query") return "\0w2b-hub-query";
    if (source === "wouter" || source === "virtual:w2b-hub-wouter") return "\0w2b-hub-wouter";
    if (source === "./api") return "\0w2b-hub-api";
    return null;
  },
  load(id) {
    if (id === "\0w2b-hub-react") {
      return `
        export const useState = (initial) => [globalThis.__hubFilter ?? initial, () => {}];
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0w2b-hub-jsx") {
      return `
        export const Fragment = Symbol.for("w2b-hub-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0w2b-hub-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries: () => {} });
        export const useQuery = () => globalThis.__hubQuery;
        export const useMutation = () => ({ isPending: false, isError: false, error: null, mutate: () => {} });
      `;
    }
    if (id === "\0w2b-hub-wouter") {
      return `export const Link = (props) => ({ type: "a", props });`;
    }
    // lib/communications.ts's only import. The Hub page itself no longer
    // imports lib/api at all — its error presentation comes from the shared
    // GrowDataRegion, whose own structural error read stays real.
    if (id === "\0w2b-hub-api") {
      return `
        export const ApiError = globalThis.__hubApiError;
        export const apiFetch = () => Promise.resolve({});
        export const formatSupportReference = (id) => (typeof id === "string" && id.trim() ? "Reference: " + id.slice(0, 8) : undefined);
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
        { find: /^react$/, replacement: "virtual:w2b-hub-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:w2b-hub-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:w2b-hub-query" },
        { find: /^wouter$/, replacement: "virtual:w2b-hub-wouter" },
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

const message = (overrides: Record<string, unknown> = {}) => ({
  id: 5,
  threadId: 3,
  brokerageId: 1,
  propertyId: 77,
  partyId: null,
  direction: "OUTBOUND",
  channel: "EMAIL",
  classification: "SERVICE",
  status: "AWAITING_APPROVAL",
  subject: "Appraisal follow-up",
  bodyText: "",
  recipientDisplayName: "Jo Citizen",
  recipientDestination: "jo@example.com",
  failureDetail: null,
  createdAt: "2026-09-18T01:00:00.000Z",
  ...overrides,
});

test("E-6: a contact-first row links to Contact 360 and names the contact; /properties/null is unreachable", async () => {
  Object.assign(globalThis, { __hubApiError: FakeApiError, __hubQuery: { isLoading: false, isError: false, data: undefined } });
  try {
    await withVite(async (vite) => {
      const { hubRowDestination, hubRowContextLabel } = (await vite.ssrLoadModule("/src/pages/CommunicationsHub.tsx")) as {
        hubRowDestination: (row: unknown) => string | null;
        hubRowContextLabel: (row: unknown) => string;
      };

      // Property-first: unchanged behaviour.
      const propertyFirst = { message: message(), propertyAddress: "12 Smith St, Ashgrove", threadSubject: "Appraisal", partyDisplayName: null };
      assert.equal(hubRowDestination(propertyFirst), "/properties/77");
      assert.equal(hubRowContextLabel(propertyFirst), "12 Smith St, Ashgrove");

      // Contact-first: the shape that used to produce /properties/null and an
      // empty summary line.
      const contactFirst = {
        message: message({ propertyId: null, partyId: 12 }),
        propertyAddress: null,
        threadSubject: "Checking in",
        partyDisplayName: "Jo Citizen",
      };
      assert.equal(hubRowDestination(contactFirst), "/grow?tab=contacts&contact=12", "a contact-first row opens Contact 360");
      assert.doesNotMatch(String(hubRowDestination(contactFirst)), /null/);
      assert.equal(hubRowContextLabel(contactFirst), "Jo Citizen", "the row says who it was to");

      // A message with a party AND a property keeps going to the property,
      // where its thread already lives.
      assert.equal(
        hubRowDestination({ message: message({ partyId: 12 }), propertyAddress: "12 Smith St", threadSubject: "x", partyDisplayName: "Jo Citizen" }),
        "/properties/77",
      );

      // Neither anchor: not linked anywhere wrong, and not left blank.
      const orphan = { message: message({ propertyId: null, partyId: null }), propertyAddress: null, threadSubject: "x", partyDisplayName: null };
      assert.equal(hubRowDestination(orphan), null);
      assert.equal(hubRowContextLabel(orphan), "No property or contact on file");
    });
  } finally {
    delete (globalThis as Record<string, unknown>).__hubApiError;
    delete (globalThis as Record<string, unknown>).__hubQuery;
  }
});

test("E-6: the rendered Hub never emits a /properties/null href", async () => {
  Object.assign(globalThis, {
    __hubApiError: FakeApiError,
    __hubFilter: "all",
    __hubQuery: {
      isLoading: false,
      isError: false,
      refetch: () => {},
      data: {
        needsAttentionCount: 1,
        messages: [
          { message: message(), propertyAddress: "12 Smith St, Ashgrove", threadSubject: "Appraisal", partyDisplayName: null },
          { message: message({ id: 6, propertyId: null, partyId: 12 }), propertyAddress: null, threadSubject: "Checking in", partyDisplayName: "Jo Citizen" },
        ],
      },
    },
  });
  try {
    await withVite(async (vite) => {
      const mod = (await vite.ssrLoadModule("/src/pages/CommunicationsHub.tsx")) as { default: () => unknown };
      const tree = mod.default();
      const hrefs = links(tree);
      assert.ok(hrefs.includes("/properties/77"));
      assert.ok(hrefs.includes("/grow?tab=contacts&contact=12"));
      assert.equal(hrefs.filter((h) => h.includes("null")).length, 0, "no /properties/null is reachable");
      assert.match(textContent(tree), /Jo Citizen/);
    });
  } finally {
    for (const key of ["__hubApiError", "__hubFilter", "__hubQuery"]) delete (globalThis as Record<string, unknown>)[key];
  }
});

test("G-4: a failed Hub fetch says so and offers a retry, instead of 'nothing needs attention'", async () => {
  Object.assign(globalThis, {
    __hubApiError: FakeApiError,
    __hubFilter: "needs-attention",
    __hubQuery: {
      isLoading: false,
      isError: true,
      error: new FakeApiError(503, "Agent Engine is temporarily unavailable. Try again shortly."),
      data: undefined,
      refetch: () => {},
    },
  });
  try {
    await withVite(async (vite) => {
      const mod = (await vite.ssrLoadModule("/src/pages/CommunicationsHub.tsx")) as { default: () => unknown };
      const text = textContent(mod.default());
      assert.match(text, /temporarily unavailable/);
      assert.doesNotMatch(text, /Nothing needs attention right now/, "a failure must never read as 'you're all clear'");
      assert.ok(button(mod.default(), "Try again"));
    });
  } finally {
    for (const key of ["__hubApiError", "__hubFilter", "__hubQuery"]) delete (globalThis as Record<string, unknown>)[key];
  }
});

// ── The cheap guard against a third drift ────────────────────────────────
//
// This codebase hand-mirrors API response shapes into apps/web/src/lib/* because
// there is no shared package between apps/web and apps/api. Two of those mirrors
// have now silently gone stale in production code (lib/growToday.ts:18-20, and
// the RecentCommunicationRow fixed here). A full codegen/shared-types change is
// far outside this slice, but ONE comparison for ONE known-fragile pair costs
// almost nothing and fails loudly the next time a field is added on one side
// only. Field names and null-ability are compared; ordering and formatting are
// not.
function fieldsOf(source: string, interfaceName: string): Map<string, boolean> {
  const start = source.indexOf(`interface ${interfaceName} {`);
  assert.notEqual(start, -1, `${interfaceName} not found`);
  const open = source.indexOf("{", start);
  const end = source.indexOf("\n}", open);
  assert.notEqual(end, -1, `${interfaceName} body not terminated`);
  const fields = new Map<string, boolean>();
  for (const line of source.slice(open + 1, end).split("\n")) {
    const match = /^\s*(\w+)\s*:\s*(.+?);\s*$/.exec(line);
    if (!match) continue;
    fields.set(match[1], /\bnull\b/.test(match[2]));
  }
  return fields;
}

test("E-6 guard: the web mirror of RecentCommunicationRow still matches the API's declaration", () => {
  const root = new URL("../../../../..", import.meta.url).pathname;
  const api = readFileSync(`${root}/apps/api/src/lib/communications/messages.ts`, "utf8");
  const web = readFileSync(`${root}/apps/web/src/lib/communications.ts`, "utf8");

  const apiFields = fieldsOf(api, "RecentCommunicationRow");
  const webFields = fieldsOf(web, "RecentCommunicationRow");

  assert.deepEqual(
    [...webFields.keys()].sort(),
    [...apiFields.keys()].sort(),
    "apps/web/src/lib/communications.ts's RecentCommunicationRow must declare exactly the fields apps/api/src/lib/communications/messages.ts returns",
  );
  for (const [field, apiNullable] of apiFields) {
    assert.equal(
      webFields.get(field),
      apiNullable,
      `RecentCommunicationRow.${field}: the web mirror disagrees with the API about whether this can be null`,
    );
  }
  // The specific pair that was wrong, asserted by name so a future reader knows
  // what this guard was built from.
  assert.equal(apiFields.get("propertyAddress"), true);
  assert.equal(apiFields.get("partyDisplayName"), true);
});
