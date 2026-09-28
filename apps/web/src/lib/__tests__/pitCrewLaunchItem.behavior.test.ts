import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

// R-F23 — the Pit Crew Launch section renders LAUNCH_ITEM rows beside
// LAUNCH_CAMPAIGN exceptions when the workspace includes them, and stays
// the same when it does not. Hand-back and escalate stay off campaign items.
// Actions post to the Pit Crew item routes with sourceType LAUNCH_ITEM.

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

function normalized(node: unknown): string {
  return textContent(node).replace(/\s+/g, " ").trim();
}

function findAll(node: unknown, predicate: (element: ElementNode) => boolean): ElementNode[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate));
  if (!node || typeof node !== "object") return [];
  const element = node as ElementNode;
  const own = predicate(element) ? [element] : [];
  return own.concat(findAll(element.props?.children, predicate));
}

function buttonExact(tree: unknown, label: string): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "button" && textContent(element).trim() === label)[0];
}

function tabButton(tree: unknown, label: string): ElementNode | undefined {
  return findAll(
    tree,
    (element) =>
      element.type === "button" &&
      String(element.props?.className ?? "").includes("pc-tab") &&
      textContent(element).replace(/\s+/g, "").includes(label),
  )[0];
}

function itemCard(tree: unknown, title: string): ElementNode | undefined {
  return findAll(
    tree,
    (element) => element.type === "li" && String(element.props?.className ?? "") === "pc-item" && textContent(element).includes(title),
  )[0];
}

function sectionCard(tree: unknown, title: string): ElementNode | undefined {
  return findAll(tree, (element) => {
    if (element.type !== "section") return false;
    const heading = findAll(element, (child) => child.type === "h2")[0];
    return normalized(heading).startsWith(title);
  })[0];
}

function click(element: ElementNode | undefined): void {
  const onClick = element?.props?.onClick;
  if (typeof onClick !== "function") throw new Error(`missing click handler for ${textContent(element)}`);
  onClick();
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

const virtualMocks: Plugin = {
  name: "pit-crew-launch-item-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:pc-react") return "\0pc-launch-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:pc-jsx") return "\0pc-launch-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:pc-query") return "\0pc-launch-query";
    if (source === "wouter" || source === "virtual:pc-wouter") return "\0pc-launch-wouter";
    if (source === "../lib/session") return "\0pc-launch-session";
    return null;
  },
  load(id) {
    if (id === "\0pc-launch-react") {
      return `
        export const useState = (...args) => globalThis.__pcLaunchHooks.useState(...args);
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0pc-launch-jsx") {
      return `
        export const Fragment = Symbol.for("pc-launch-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0pc-launch-query") {
      return `
        export const useQueryClient = () => ({
          invalidateQueries(filter) { globalThis.__pcLaunchInvalidated.push(filter && filter.queryKey); },
        });
        export const useQuery = (options) => {
          const key = JSON.stringify(options.queryKey);
          const table = globalThis.__pcLaunchQueries || {};
          if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
          return { isLoading: false, isError: false, data: undefined, error: null };
        };
        export const useMutation = (options) => ({
          isPending: false,
          variables: undefined,
          mutate(input) {
            const pending = Promise.resolve()
              .then(() => options.mutationFn(input))
              .then(
                (result) => { options.onSuccess?.(result, input); },
                (error) => { options.onError?.(error, input); },
              );
            globalThis.__pcLaunchPending.push(pending);
          },
        });
      `;
    }
    if (id === "\0pc-launch-wouter") {
      return `export const Link = (props) => ({ type: "a", props });`;
    }
    if (id === "\0pc-launch-session") {
      return `export const useSession = () => ({ user: globalThis.__pcLaunchUser });`;
    }
    return null;
  },
};

let vite: ViteDevServer;
let Page: () => unknown;

before(async () => {
  vite = await createServer({
    root: new URL("../../..", import.meta.url).pathname,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: true },
    resolve: {
      alias: [
        { find: /^react$/, replacement: "virtual:pc-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:pc-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:pc-query" },
        { find: /^wouter$/, replacement: "virtual:pc-wouter" },
      ],
    },
    plugins: [virtualMocks],
  });
  const mod = (await vite.ssrLoadModule("/src/pages/PitCrewCommandCentre.tsx")) as { default: () => unknown };
  Page = mod.default;
});

after(async () => {
  await vite?.close();
});

const LAUNCH_ITEM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FLOOR_PLAN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function item(overrides: Record<string, unknown> = {}) {
  return {
    sourceType: "EXCEPTION",
    sourceRecordId: "11111111-1111-4111-8111-111111111111",
    propertyId: 15,
    propertyAddress: "15 Example St",
    brokerageId: 1,
    title: "Portal copy missing",
    description: "The portal copy is missing.",
    category: "LAUNCH_CAMPAIGN",
    severity: "ATTENTION",
    exceptionStatus: "OPEN",
    ownerType: "PIT_CREW",
    ownerUserId: null,
    ownerName: null,
    dueAt: null,
    overdue: false,
    recommendedAction: "Rewrite the portal copy.",
    deepLink: "/properties/15",
    detectedAt: "2026-09-01T00:00:00.000Z",
    pcStatus: "UNCLAIMED",
    assignedToUserId: null,
    assignedToName: null,
    claimedAt: null,
    waitingOnParty: null,
    waitingOnNote: null,
    waitingOnSince: null,
    waitingOnExpectedAt: null,
    handoffFromUserId: null,
    handoffToUserId: null,
    handoffNote: null,
    handoffAt: null,
    completedAt: null,
    version: 0,
    ...overrides,
  };
}

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: "2026-09-28T00:00:00.000Z",
    summary: {
      unassignedCount: 1,
      myWorkCount: 1,
      teamWorkCount: 1,
      waitingOnCount: 0,
      overdueCount: 0,
      completedTodayCount: 0,
    },
    myWork: [],
    unassignedWork: [],
    teamWork: [],
    launchCoordination: [],
    transactionCoordination: [],
    waitingOn: [],
    completedToday: [],
    handedBack: [],
    escalated: [],
    team: [{ userId: 9, firstName: "Pat", lastName: "Crew", activeItemCount: 3 }],
    ...overrides,
  };
}

function queries(data: unknown, visible: boolean) {
  return {
    '["pit-crew-workspace"]': { isLoading: false, isError: false, data, error: null },
    '["pit-crew-responsibility-actions"]': { isLoading: false, isError: false, data: visible, error: null },
  };
}

function install(data: unknown, visible: boolean) {
  const hooks = createHarness();
  const pending: Promise<unknown>[] = [];
  const invalidated: unknown[] = [];
  Object.assign(globalThis, {
    __pcLaunchHooks: hooks,
    __pcLaunchPending: pending,
    __pcLaunchInvalidated: invalidated,
    __pcLaunchQueries: queries(data, visible),
    __pcLaunchUser: { id: 9, role: "Pit Crew" },
  });
  const render = () => {
    hooks.beginRender();
    return Page();
  };
  return { pending, render };
}

function clearGlobals() {
  for (const key of ["__pcLaunchHooks", "__pcLaunchPending", "__pcLaunchInvalidated", "__pcLaunchQueries", "__pcLaunchUser"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

function openLaunch(render: () => unknown): unknown {
  let tree = render();
  click(tabButton(tree, "Launch"));
  tree = render();
  return tree;
}

type FetchCall = { url: string; body: Record<string, unknown> };

function stubFetch(): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ id: 1, version: 2 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return calls;
}

const EXCEPTION_ONLY_LAUNCH =
  "Launch Coordination (1)AttentionPortal copy missingUnclaimed15 Example St · Launch CampaignThe portal copy is missing.Recommended: Rewrite the portal copy.ClaimAssign to…Add note…";

const EMPTY_LAUNCH = "Launch Coordination (0)No launch campaign items need Pit Crew right now.";

test("the Launch section renders campaign items beside exceptions and labels both", async () => {
  const launchItem = item({
    sourceType: "LAUNCH_ITEM",
    sourceRecordId: LAUNCH_ITEM_ID,
    title: "Book the photographer",
    description: "Photography is still outstanding.",
    severity: "INFORMATION",
    exceptionStatus: "IN_PROGRESS",
    recommendedAction: "",
    pcStatus: "CLAIMED",
    assignedToUserId: 9,
    assignedToName: "Pat Crew",
    version: 2,
    cost_cents: 987654321,
    vendorName: "UNIQUE_VENDOR_ACME",
  });
  const exception = item({
    sourceRecordId: "exception-launch",
    title: "Portal copy missing",
    pcStatus: "CLAIMED",
    assignedToUserId: 9,
    assignedToName: "Pat Crew",
    version: 4,
    cost_cents: 987654321,
    vendorName: "UNIQUE_VENDOR_ACME",
  });
  const { render } = install(
    workspace({
      launchCoordination: [exception, launchItem],
      summary: {
        unassignedCount: 0,
        myWorkCount: 1,
        teamWorkCount: 2,
        waitingOnCount: 0,
        overdueCount: 0,
        completedTodayCount: 0,
      },
    }),
    true,
  );
  try {
    const tree = openLaunch(render);
    const section = sectionCard(tree, "Launch Coordination");
    assert.equal(normalized(findAll(section, (element) => element.type === "h2")[0]), "Launch Coordination (2)");
    assert.equal(textContent(tabButton(tree, "Launch")).replace(/\s+/g, ""), "Launch2");

    const campaign = itemCard(tree, "Book the photographer");
    const risk = itemCard(tree, "Portal copy missing");
    assert.match(normalized(campaign), /Campaign item · 15 Example St · Launch Campaign/);
    assert.match(normalized(risk), /Exception · 15 Example St · Launch Campaign/);
    assert.equal(buttonExact(campaign, "Hand back…"), undefined);
    assert.equal(buttonExact(campaign, "Escalate…"), undefined);
    assert.ok(buttonExact(campaign, "Complete"));
    assert.ok(buttonExact(risk, "Hand back…"));
    assert.ok(buttonExact(risk, "Escalate…"));
    assert.ok(buttonExact(risk, "Complete"));

    const campaignLink = findAll(campaign, (element) => element.type === "a")[0];
    assert.equal(campaignLink?.props?.href, "/properties/15");
    assert.equal(String(campaignLink?.props?.href).includes("/launch"), false);

    const page = textContent(tree);
    assert.equal(page.includes("987654321"), false);
    assert.equal(page.includes("UNIQUE_VENDOR_ACME"), false);
    assert.equal(page.includes("cost_cents"), false);
    assert.equal(page.includes("Campaign items"), false);
  } finally {
    clearGlobals();
  }
});

test("campaign item actions post sourceType LAUNCH_ITEM to the Pit Crew item route", async () => {
  const original = globalThis.fetch;
  const calls = stubFetch();
  const claimed = item({
    sourceType: "LAUNCH_ITEM",
    sourceRecordId: LAUNCH_ITEM_ID,
    title: "Book the photographer",
    description: "Photography is still outstanding.",
    severity: "INFORMATION",
    pcStatus: "CLAIMED",
    assignedToUserId: 9,
    assignedToName: "Pat Crew",
    version: 2,
  });
  const unclaimed = item({
    sourceType: "LAUNCH_ITEM",
    sourceRecordId: FLOOR_PLAN_ID,
    title: "Order the floor plan",
    description: "The floor plan is not ordered.",
    severity: "INFORMATION",
    pcStatus: "UNCLAIMED",
    version: 0,
  });
  const { render, pending } = install(workspace({ launchCoordination: [claimed, unclaimed] }), true);
  try {
    let tree = openLaunch(render);
    click(buttonExact(itemCard(tree, "Book the photographer"), "Complete"));
    await Promise.all(pending);
    click(buttonExact(itemCard(tree, "Order the floor plan"), "Claim"));
    await Promise.all(pending);

    assert.equal(calls[0]?.url, `/api/pit-crew/items/LAUNCH_ITEM/${LAUNCH_ITEM_ID}/complete`);
    assert.deepEqual(calls[0]?.body, { propertyId: 15, expectedVersion: 2 });
    assert.equal(calls[1]?.url, `/api/pit-crew/items/LAUNCH_ITEM/${FLOOR_PLAN_ID}/claim`);
    assert.deepEqual(calls[1]?.body, { propertyId: 15, expectedVersion: 0 });
    for (const call of calls) {
      assert.equal(call.url.includes("/launch/"), false);
      assert.equal(call.url.includes("/api/launch"), false);
    }
  } finally {
    globalThis.fetch = original;
    clearGlobals();
  }
});

test("with no campaign items the Launch section matches today's output and shows the API team count", async () => {
  const exception = item();
  const withMoney = item({ cost_cents: 987654321, vendorName: "UNIQUE_VENDOR_ACME" });
  const cases = [
    { launchCoordination: [exception], expected: EXCEPTION_ONLY_LAUNCH, tab: "Launch1" },
    { launchCoordination: [withMoney], expected: EXCEPTION_ONLY_LAUNCH, tab: "Launch1" },
    { launchCoordination: [], expected: EMPTY_LAUNCH, tab: "Launch0" },
  ];
  try {
    for (const entry of cases) {
      const { render } = install(workspace({ launchCoordination: entry.launchCoordination }), false);
      let tree = render();
      const overview = textContent(tree);
      assert.match(overview, /Pat Crew/);
      assert.match(overview, /3 active items/);
      assert.equal(overview.includes("4 active"), false);
      assert.equal(overview.includes("2 active"), false);
      click(tabButton(tree, "Launch"));
      tree = render();
      const section = sectionCard(tree, "Launch Coordination");
      assert.equal(normalized(section), entry.expected);
      assert.equal(textContent(tabButton(tree, "Launch")).replace(/\s+/g, ""), entry.tab);
      const page = textContent(tree);
      assert.equal(page.includes("Campaign item"), false);
      assert.equal(page.includes("Campaign items"), false);
      assert.equal(page.includes("987654321"), false);
      assert.equal(page.includes("UNIQUE_VENDOR_ACME"), false);
      assert.equal(page.includes("cost_cents"), false);
      clearGlobals();
    }
  } finally {
    clearGlobals();
  }
});
