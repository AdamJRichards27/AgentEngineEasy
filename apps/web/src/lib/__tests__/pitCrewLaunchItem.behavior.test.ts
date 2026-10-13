import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

// R-F23 — the Pit Crew Launch section renders LAUNCH_ITEM rows beside
// LAUNCH_CAMPAIGN exceptions when the workspace includes them, and stays
// the same when it does not. Actions post to the Pit Crew item routes with
// sourceType LAUNCH_ITEM. This page does not call /launch.
// R-F29 — Hand back and Escalate show on a LAUNCH_ITEM card when the
// responsibility signal is on and the status is CLAIMED, IN_PROGRESS, or
// WAITING_ON. They stay hidden when the signal is off and on every other
// status. Reclaim, acknowledge, resolve, and return use the same Pit Crew
// routes and send that card's sourceType and id.

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

function field(tree: unknown, name: string): ElementNode | undefined {
  return findAll(tree, (element) => element.props?.name === name)[0];
}

function formNode(tree: unknown): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "form")[0];
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

function change(element: ElementNode | undefined, value: string): void {
  const onChange = element?.props?.onChange;
  if (typeof onChange !== "function") throw new Error("missing change handler");
  onChange({ target: { value } });
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

function install(data: unknown, visible: boolean, user: { id: number; role: string } = { id: 9, role: "Pit Crew" }) {
  const hooks = createHarness();
  const pending: Promise<unknown>[] = [];
  const invalidated: unknown[] = [];
  Object.assign(globalThis, {
    __pcLaunchHooks: hooks,
    __pcLaunchPending: pending,
    __pcLaunchInvalidated: invalidated,
    __pcLaunchQueries: queries(data, visible),
    __pcLaunchUser: user,
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

function openTab(render: () => unknown, label: string): unknown {
  let tree = render();
  click(tabButton(tree, label.replace(/\s+/g, "")));
  tree = render();
  return tree;
}

async function submit(tree: unknown, pending: Promise<unknown>[]) {
  const onSubmit = formNode(tree)?.props?.onSubmit;
  if (typeof onSubmit !== "function") throw new Error("missing form");
  onSubmit({ preventDefault() {} });
  await Promise.all(pending);
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
    assert.ok(buttonExact(campaign, "Hand back…"));
    assert.ok(buttonExact(campaign, "Escalate…"));
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

const ACTIVE_LAUNCH_STATUSES = ["CLAIMED", "IN_PROGRESS", "WAITING_ON"] as const;
const OTHER_LAUNCH_STATUSES = ["UNCLAIMED", "DONE", "HANDED_BACK", "ESCALATED"] as const;

function launchStatusItem(pcStatus: string) {
  const unassigned = pcStatus === "UNCLAIMED" || pcStatus === "HANDED_BACK";
  return item({
    sourceType: "LAUNCH_ITEM",
    sourceRecordId: `launch-status-${pcStatus}`,
    title: `Launch status ${pcStatus}`,
    description: "Photography is still outstanding.",
    severity: "INFORMATION",
    category: "LAUNCH_CAMPAIGN",
    pcStatus,
    assignedToUserId: unassigned ? null : 9,
    assignedToName: unassigned ? null : "Pat Crew",
    version: 3,
    waitingOnParty: pcStatus === "WAITING_ON" ? "Photographer" : null,
    completedAt: pcStatus === "DONE" ? "2026-09-28T01:00:00.000Z" : null,
  });
}

test("campaign item hand back and escalate follow the exception status gate", async () => {
  const launchItems = [...ACTIVE_LAUNCH_STATUSES, ...OTHER_LAUNCH_STATUSES].map((pcStatus) => launchStatusItem(pcStatus));
  const exception = item({
    sourceRecordId: "exception-still-claimed",
    title: "Exception still claimed",
    pcStatus: "CLAIMED",
    assignedToUserId: 9,
    assignedToName: "Pat Crew",
    version: 4,
  });
  try {
    const on = install(workspace({ launchCoordination: [...launchItems, exception] }), true);
    const onTree = openLaunch(on.render);
    for (const pcStatus of ACTIVE_LAUNCH_STATUSES) {
      const card = itemCard(onTree, `Launch status ${pcStatus}`);
      assert.ok(buttonExact(card, "Hand back…"), `${pcStatus} shows Hand back`);
      assert.ok(buttonExact(card, "Escalate…"), `${pcStatus} shows Escalate`);
    }
    for (const pcStatus of OTHER_LAUNCH_STATUSES) {
      const card = itemCard(onTree, `Launch status ${pcStatus}`);
      assert.equal(buttonExact(card, "Hand back…"), undefined, `${pcStatus} hides Hand back`);
      assert.equal(buttonExact(card, "Escalate…"), undefined, `${pcStatus} hides Escalate`);
    }
    assert.ok(buttonExact(itemCard(onTree, "Launch status HANDED_BACK"), "Reclaim"));
    const risk = itemCard(onTree, "Exception still claimed");
    assert.ok(buttonExact(risk, "Hand back…"));
    assert.ok(buttonExact(risk, "Escalate…"));
    clearGlobals();

    const off = install(workspace({ launchCoordination: launchItems }), false);
    const offTree = openLaunch(off.render);
    assert.equal(tabButton(offTree, "Handedback"), undefined);
    assert.equal(tabButton(offTree, "Escalated"), undefined);
    for (const pcStatus of [...ACTIVE_LAUNCH_STATUSES, ...OTHER_LAUNCH_STATUSES]) {
      const card = itemCard(offTree, `Launch status ${pcStatus}`);
      assert.equal(buttonExact(card, "Hand back…"), undefined, `${pcStatus} hides Hand back when the signal is off`);
      assert.equal(buttonExact(card, "Escalate…"), undefined, `${pcStatus} hides Escalate when the signal is off`);
      assert.equal(buttonExact(card, "Reclaim"), undefined);
      assert.equal(buttonExact(card, "Acknowledge…"), undefined);
      assert.equal(buttonExact(card, "Resolve…"), undefined);
      assert.equal(buttonExact(card, "Return…"), undefined);
    }
    assert.ok(buttonExact(itemCard(offTree, "Launch status CLAIMED"), "Complete"));
    assert.ok(buttonExact(itemCard(offTree, "Launch status UNCLAIMED"), "Claim"));
  } finally {
    clearGlobals();
  }
});

const HANDED_LAUNCH_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ESCALATED_LAUNCH_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const launchHandBack = {
  eventId: 4,
  kind: "HAND_BACK",
  reasonCategory: "WORK_COMPLETE",
  severity: null,
  note: "Returned the evidence.",
  closingNote: null,
  nextAction: "UNIQUE_LAUNCH_HANDED_NEXT_ACTION",
  originatingUserId: 9,
  operatorDisplayName: "Pat Crew",
  recipientUserId: 42,
  recipientDisplayName: "Alex Agent",
  recipientRole: null,
  expectedResponseAt: null,
  eventStatus: "OPEN",
};

const launchEscalation = {
  eventId: 5,
  kind: "ESCALATION",
  reasonCategory: "MISSING_AUTHORITY",
  severity: "AT_RISK",
  note: "Outside authority.",
  closingNote: null,
  nextAction: "UNIQUE_LAUNCH_ESCALATED_NEXT_ACTION",
  originatingUserId: 9,
  operatorDisplayName: "Pat Crew",
  recipientUserId: null,
  recipientDisplayName: null,
  recipientRole: "Brokerage Administrator",
  expectedResponseAt: "2026-10-03T00:00:00.000Z",
  eventStatus: "OPEN",
};

function assertPitCrewRoute(call: FetchCall | undefined, sourceRecordId: string, action: string) {
  assert.equal(call?.url, `/api/pit-crew/items/LAUNCH_ITEM/${sourceRecordId}/${action}`);
  assert.equal(call?.url.includes("/launch"), false);
}

test("launch item follow-on actions render and post the card sourceType and id", async () => {
  const original = globalThis.fetch;
  const calls = stubFetch();
  try {
    const claimed = item({
      sourceType: "LAUNCH_ITEM",
      sourceRecordId: LAUNCH_ITEM_ID,
      title: "Book the photographer",
      description: "Photography is still outstanding.",
      severity: "INFORMATION",
      category: "LAUNCH_CAMPAIGN",
      pcStatus: "CLAIMED",
      assignedToUserId: 9,
      assignedToName: "Pat Crew",
      version: 2,
    });
    const handed = item({
      sourceType: "LAUNCH_ITEM",
      sourceRecordId: HANDED_LAUNCH_ID,
      title: "Handed campaign item",
      description: "Photography was handed back.",
      severity: "INFORMATION",
      category: "LAUNCH_CAMPAIGN",
      pcStatus: "HANDED_BACK",
      assignedToUserId: null,
      assignedToName: null,
      version: 7,
      responsibility: launchHandBack,
    });
    const escalated = item({
      sourceType: "LAUNCH_ITEM",
      sourceRecordId: ESCALATED_LAUNCH_ID,
      title: "Escalated campaign item",
      description: "Photography was escalated.",
      severity: "INFORMATION",
      category: "LAUNCH_CAMPAIGN",
      pcStatus: "ESCALATED",
      assignedToUserId: 9,
      assignedToName: "Pat Crew",
      version: 8,
      responsibility: launchEscalation,
    });

    const active = install(workspace({ launchCoordination: [claimed], handedBack: [handed], escalated: [escalated] }), true);
    let tree = openLaunch(active.render);
    let card = itemCard(tree, "Book the photographer");
    assert.ok(buttonExact(card, "Hand back…"));
    assert.ok(buttonExact(card, "Escalate…"));
    click(buttonExact(card, "Hand back…"));
    tree = active.render();
    card = itemCard(tree, "Book the photographer");
    change(field(card, "reasonCategory"), "WORK_COMPLETE");
    tree = active.render();
    card = itemCard(tree, "Book the photographer");
    change(field(card, "nextAction"), "Ask the agent to book the photographer.");
    tree = active.render();
    card = itemCard(tree, "Book the photographer");
    await submit(card, active.pending);
    assertPitCrewRoute(calls[0], LAUNCH_ITEM_ID, "hand-back");
    assert.deepEqual(calls[0]?.body, {
      propertyId: 15,
      expectedVersion: 2,
      reasonCategory: "WORK_COMPLETE",
      nextAction: "Ask the agent to book the photographer.",
    });

    tree = active.render();
    card = itemCard(tree, "Book the photographer");
    click(buttonExact(card, "Escalate…"));
    tree = active.render();
    card = itemCard(tree, "Book the photographer");
    change(field(card, "reasonCategory"), "MISSING_INFORMATION");
    tree = active.render();
    card = itemCard(tree, "Book the photographer");
    change(field(card, "severity"), "ATTENTION");
    tree = active.render();
    card = itemCard(tree, "Book the photographer");
    change(field(card, "note"), "The photographer has not confirmed.");
    tree = active.render();
    card = itemCard(tree, "Book the photographer");
    change(field(card, "nextAction"), "Confirm the booking.");
    tree = active.render();
    card = itemCard(tree, "Book the photographer");
    await submit(card, active.pending);
    assertPitCrewRoute(calls[1], LAUNCH_ITEM_ID, "escalate");
    assert.deepEqual(calls[1]?.body, {
      propertyId: 15,
      expectedVersion: 2,
      reasonCategory: "MISSING_INFORMATION",
      severity: "ATTENTION",
      note: "The photographer has not confirmed.",
      nextAction: "Confirm the booking.",
    });

    tree = openTab(active.render, "Handed back");
    card = itemCard(tree, "Handed campaign item");
    assert.match(textContent(card), /Next action: UNIQUE_LAUNCH_HANDED_NEXT_ACTION/);
    assert.ok(buttonExact(card, "Reclaim"));
    assert.equal(buttonExact(card, "Hand back…"), undefined);
    assert.equal(buttonExact(card, "Escalate…"), undefined);
    click(buttonExact(card, "Reclaim"));
    await Promise.all(active.pending);
    assertPitCrewRoute(calls[2], HANDED_LAUNCH_ID, "hand-back/reclaim");
    assert.deepEqual(calls[2]?.body, { propertyId: 15, expectedVersion: 7 });

    tree = openTab(active.render, "Escalated");
    card = itemCard(tree, "Escalated campaign item");
    assert.match(textContent(card), /Next action: UNIQUE_LAUNCH_ESCALATED_NEXT_ACTION/);
    assert.equal(buttonExact(card, "Acknowledge…"), undefined);
    assert.equal(buttonExact(card, "Resolve…"), undefined);
    assert.equal(buttonExact(card, "Return…"), undefined);
    assert.equal(buttonExact(card, "Hand back…"), undefined);
    clearGlobals();

    const adminView = install(
      workspace({ handedBack: [handed], escalated: [escalated] }),
      true,
      { id: 2, role: "Brokerage Administrator" },
    );
    tree = openTab(adminView.render, "Escalated");
    card = itemCard(tree, "Escalated campaign item");
    assert.ok(buttonExact(card, "Acknowledge…"));
    assert.ok(buttonExact(card, "Resolve…"));
    assert.ok(buttonExact(card, "Return…"));
    assert.equal(buttonExact(card, "Hand back…"), undefined);
    assert.equal(buttonExact(card, "Escalate…"), undefined);

    click(buttonExact(card, "Acknowledge…"));
    tree = adminView.render();
    card = itemCard(tree, "Escalated campaign item");
    change(field(card, "note"), "Seen.");
    tree = adminView.render();
    card = itemCard(tree, "Escalated campaign item");
    await submit(card, adminView.pending);
    assertPitCrewRoute(calls[3], ESCALATED_LAUNCH_ID, "escalation/acknowledge");
    assert.deepEqual(calls[3]?.body, { propertyId: 15, expectedVersion: 8, note: "Seen." });

    tree = adminView.render();
    card = itemCard(tree, "Escalated campaign item");
    click(buttonExact(card, "Resolve…"));
    tree = adminView.render();
    card = itemCard(tree, "Escalated campaign item");
    change(field(card, "note"), "Booking is confirmed.");
    tree = adminView.render();
    card = itemCard(tree, "Escalated campaign item");
    await submit(card, adminView.pending);
    assertPitCrewRoute(calls[4], ESCALATED_LAUNCH_ID, "escalation/resolve");
    assert.deepEqual(calls[4]?.body, { propertyId: 15, expectedVersion: 8, note: "Booking is confirmed." });

    tree = adminView.render();
    card = itemCard(tree, "Escalated campaign item");
    click(buttonExact(card, "Return…"));
    tree = adminView.render();
    card = itemCard(tree, "Escalated campaign item");
    change(field(card, "note"), "Still needs the agent.");
    tree = adminView.render();
    card = itemCard(tree, "Escalated campaign item");
    await submit(card, adminView.pending);
    assertPitCrewRoute(calls[5], ESCALATED_LAUNCH_ID, "escalation/return");
    assert.deepEqual(calls[5]?.body, { propertyId: 15, expectedVersion: 8, note: "Still needs the agent." });

    assert.equal(calls.length, 6);
    for (const call of calls) {
      assert.equal(call.url.includes("/launch"), false);
      assert.equal(call.url.startsWith("/api/pit-crew/items/LAUNCH_ITEM/"), true);
    }
  } finally {
    globalThis.fetch = original;
    clearGlobals();
  }
});

test("Blocks close shows only on an exception the server marked, and flags-off actions stay off", () => {
  const blocking = item({
    sourceRecordId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
    title: "Unowned settlement exception",
    blocksClose: true,
    ownerType: "UNASSIGNED_QUEUE",
    ownerUserId: null,
    category: "SETTLEMENT_CLOSURE",
  });
  const owned = item({
    sourceRecordId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02",
    title: "Owned settlement exception",
    ownerType: "LISTING_AGENT",
    ownerUserId: 4,
    category: "SETTLEMENT_CLOSURE",
  });
  const launch = item({
    sourceType: "LAUNCH_ITEM",
    sourceRecordId: LAUNCH_ITEM_ID,
    title: "Floor plan upload",
    blocksClose: true,
    category: "LAUNCH_CAMPAIGN",
  });
  const payload = workspace({
    transactionCoordination: [blocking, owned],
    launchCoordination: [launch],
    handedBack: [],
    escalated: [],
  });
  const before = JSON.stringify(payload);
  const flagsOff = install(payload, false);
  let tree = openTab(flagsOff.render, "Transactions");
  const blockingCard = itemCard(tree, "Unowned settlement exception");
  const ownedCard = itemCard(tree, "Owned settlement exception");
  assert.ok(blockingCard);
  assert.ok(ownedCard);
  assert.equal(normalized(blockingCard).includes("Blocks close"), true);
  assert.equal(normalized(ownedCard).includes("Blocks close"), false);
  assert.equal(buttonExact(blockingCard, "Hand back…"), undefined);
  assert.equal(buttonExact(blockingCard, "Escalate…"), undefined);
  assert.ok(buttonExact(blockingCard, "Claim"));
  assert.equal(tabButton(tree, "Handedback"), undefined);
  assert.equal(tabButton(tree, "Escalated"), undefined);

  tree = openTab(flagsOff.render, "Launch");
  const launchCard = itemCard(tree, "Floor plan upload");
  assert.ok(launchCard);
  assert.equal(normalized(launchCard).includes("Blocks close"), false);
  assert.ok(buttonExact(launchCard, "Claim"));
  assert.equal(JSON.stringify(payload), before);
});
