import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { PIT_CREW_RESPONSIBILITY_UNAVAILABLE_MESSAGE } from "../pitCrew.ts";

// R-F16 PR 5 — the Pit Crew page renders hand-back and escalate controls
// only after GET /pit-crew/responsibility-inbox returns 200. These tests
// run the real page function with React and React Query replaced, the same
// way the Grow behaviour tests do, so a flag-off workspace cannot mount
// the new controls.

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

function buttonExact(tree: unknown, label: string): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "button" && textContent(element).trim() === label)[0];
}

function buttonsExact(tree: unknown, label: string): ElementNode[] {
  return findAll(tree, (element) => element.type === "button" && textContent(element).trim() === label);
}

function tabButton(tree: unknown, label: string): ElementNode | undefined {
  return findAll(
    tree,
    (element) =>
      element.type === "button" &&
      String(element.props?.className ?? "").includes("pc-tab") &&
      textContent(element).includes(label),
  )[0];
}

function field(tree: unknown, name: string): ElementNode | undefined {
  return findAll(tree, (element) => element.props?.name === name)[0];
}

function formNode(tree: unknown): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "form")[0];
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
    reset() {
      state.length = 0;
    },
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
  name: "pit-crew-responsibility-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:pc-react") return "\0pc-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:pc-jsx") return "\0pc-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:pc-query") return "\0pc-query";
    if (source === "wouter" || source === "virtual:pc-wouter") return "\0pc-wouter";
    if (source === "../lib/session") return "\0pc-session";
    return null;
  },
  load(id) {
    if (id === "\0pc-react") {
      return `
        export const useState = (...args) => globalThis.__pcHooks.useState(...args);
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0pc-jsx") {
      return `
        export const Fragment = Symbol.for("pc-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0pc-query") {
      return `
        export const useQueryClient = () => ({
          invalidateQueries(filter) { globalThis.__pcInvalidated.push(filter && filter.queryKey); },
        });
        export const useQuery = (options) => {
          const key = JSON.stringify(options.queryKey);
          const table = globalThis.__pcQueries || {};
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
            globalThis.__pcPending.push(pending);
          },
        });
      `;
    }
    if (id === "\0pc-wouter") {
      return `export const Link = (props) => ({ type: "a", props });`;
    }
    if (id === "\0pc-session") {
      return `export const useSession = () => ({ user: globalThis.__pcUser });`;
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

function item(overrides: Record<string, unknown> = {}) {
  return {
    sourceType: "EXCEPTION",
    sourceRecordId: "11111111-1111-4111-8111-111111111111",
    propertyId: 15,
    propertyAddress: "15 Example St",
    brokerageId: 1,
    title: "Missing contract date",
    description: "The contract date is missing.",
    category: "CONTRACT_CONDITIONS",
    severity: "ATTENTION",
    exceptionStatus: "OPEN",
    ownerType: "PIT_CREW",
    ownerUserId: null,
    ownerName: null,
    dueAt: null,
    overdue: false,
    recommendedAction: "Confirm the date.",
    deepLink: "/properties/15",
    detectedAt: "2026-09-01T00:00:00.000Z",
    pcStatus: "CLAIMED",
    assignedToUserId: 9,
    assignedToName: "Pat Crew",
    claimedAt: "2026-09-01T00:00:00.000Z",
    waitingOnParty: null,
    waitingOnNote: null,
    waitingOnSince: null,
    waitingOnExpectedAt: null,
    handoffFromUserId: null,
    handoffToUserId: null,
    handoffNote: null,
    handoffAt: null,
    completedAt: null,
    version: 3,
    ...overrides,
  };
}

const handedResponsibility = {
  eventId: 4,
  kind: "HAND_BACK",
  reasonCategory: "WORK_COMPLETE",
  severity: null,
  note: "Returned the evidence.",
  closingNote: null,
  nextAction: "UNIQUE_HANDED_NEXT_ACTION",
  originatingUserId: 9,
  recipientUserId: 42,
  recipientRole: null,
  expectedResponseAt: null,
  eventStatus: "OPEN",
};

const escalatedResponsibility = {
  eventId: 5,
  kind: "ESCALATION",
  reasonCategory: "MISSING_AUTHORITY",
  severity: "AT_RISK",
  note: "Outside authority.",
  closingNote: null,
  nextAction: "UNIQUE_ESCALATED_NEXT_ACTION",
  originatingUserId: 9,
  recipientUserId: null,
  recipientRole: "Brokerage Administrator",
  expectedResponseAt: "2026-10-03T00:00:00.000Z",
  eventStatus: "OPEN",
};

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: "2026-09-27T00:00:00.000Z",
    summary: {
      unassignedCount: 1,
      myWorkCount: 3,
      teamWorkCount: 3,
      waitingOnCount: 1,
      overdueCount: 0,
      completedTodayCount: 1,
    },
    myWork: [
      item({ sourceRecordId: "claimed-item", pcStatus: "CLAIMED", version: 3 }),
      item({ sourceRecordId: "progress-item", pcStatus: "IN_PROGRESS", version: 4, title: "In progress item" }),
      item({ sourceRecordId: "waiting-item", pcStatus: "WAITING_ON", version: 5, title: "Waiting item", waitingOnParty: "Solicitor" }),
    ],
    unassignedWork: [item({ sourceRecordId: "unclaimed-item", pcStatus: "UNCLAIMED", assignedToUserId: null, assignedToName: null, version: 0, title: "Unclaimed item" })],
    teamWork: [],
    launchCoordination: [],
    transactionCoordination: [],
    waitingOn: [],
    completedToday: [item({ sourceRecordId: "done-item", pcStatus: "DONE", version: 6, title: "Done item", completedAt: "2026-09-27T01:00:00.000Z" })],
    handedBack: [
      item({
        sourceRecordId: "handed-item",
        pcStatus: "HANDED_BACK",
        assignedToUserId: null,
        assignedToName: null,
        version: 7,
        title: "Handed item",
        responsibility: handedResponsibility,
      }),
    ],
    escalated: [
      item({
        sourceRecordId: "escalated-item",
        pcStatus: "ESCALATED",
        version: 8,
        title: "Escalated item",
        responsibility: escalatedResponsibility,
      }),
    ],
    team: [{ userId: 9, firstName: "Pat", lastName: "Crew", activeItemCount: 2 }],
    ...overrides,
  };
}

function queries(data: unknown, visible: boolean | undefined) {
  return {
    '["pit-crew-workspace"]': { isLoading: false, isError: false, data, error: null },
    '["pit-crew-responsibility-actions"]': {
      isLoading: visible === undefined,
      isError: false,
      data: visible,
      error: null,
    },
  };
}

function install(user: { id: number; role: string }, data: unknown, visible: boolean | undefined) {
  const hooks = createHarness();
  const pending: Promise<unknown>[] = [];
  const invalidated: unknown[] = [];
  Object.assign(globalThis, {
    __pcHooks: hooks,
    __pcPending: pending,
    __pcInvalidated: invalidated,
    __pcQueries: queries(data, visible),
    __pcUser: user,
  });
  const render = () => {
    hooks.beginRender();
    return Page();
  };
  return { hooks, pending, invalidated, render };
}

function clearGlobals() {
  for (const key of ["__pcHooks", "__pcPending", "__pcInvalidated", "__pcQueries", "__pcUser"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

const pitCrew = { id: 9, role: "Pit Crew" };
const admin = { id: 2, role: "Brokerage Administrator" };

test("responsibility controls render nothing when the inbox probe is off or still loading", async () => {
  for (const visible of [false, undefined] as const) {
    const { render } = install(pitCrew, workspace(), visible);
    try {
      let tree = render();
      assert.equal(tabButton(tree, "Handed back"), undefined);
      assert.equal(tabButton(tree, "Escalated"), undefined);
      click(tabButton(tree, "My Work"));
      tree = render();
      assert.equal(buttonsExact(tree, "Hand back…").length, 0);
      assert.equal(buttonsExact(tree, "Escalate…").length, 0);
      assert.equal(buttonExact(tree, "Reclaim"), undefined);
      assert.equal(buttonExact(tree, "Acknowledge…"), undefined);
      assert.equal(textContent(tree).includes("UNIQUE_HANDED_NEXT_ACTION"), false);
      assert.equal(textContent(tree).includes("UNIQUE_ESCALATED_NEXT_ACTION"), false);
      assert.ok(buttonExact(tree, "Start"), "existing claim actions stay available");
    } finally {
      clearGlobals();
    }
  }
});

test("hand back and escalate appear only on CLAIMED, IN_PROGRESS, and WAITING_ON when the probe is on", async () => {
  const { render } = install(pitCrew, workspace(), true);
  try {
    let tree = render();
    assert.ok(tabButton(tree, "Handed back"));
    assert.ok(tabButton(tree, "Escalated"));
    click(tabButton(tree, "My Work"));
    tree = render();
    assert.equal(buttonsExact(tree, "Hand back…").length, 3);
    assert.equal(buttonsExact(tree, "Escalate…").length, 3);

    click(tabButton(tree, "Unassigned"));
    tree = render();
    assert.equal(buttonsExact(tree, "Hand back…").length, 0);
    assert.ok(buttonExact(tree, "Claim"));

    click(tabButton(tree, "Completed Today"));
    tree = render();
    assert.equal(buttonsExact(tree, "Hand back…").length, 0);
    assert.equal(buttonsExact(tree, "Escalate…").length, 0);
  } finally {
    clearGlobals();
  }
});

test("handed-back and escalated lists show the event, and only a valid responder sees escalation actions", async () => {
  const { render } = install(pitCrew, workspace(), true);
  try {
    let tree = render();
    click(tabButton(tree, "Handed back"));
    tree = render();
    const handed = textContent(tree);
    assert.match(handed, /Reason: Work complete/);
    assert.match(handed, /Next action: UNIQUE_HANDED_NEXT_ACTION/);
    assert.match(handed, /Recipient user 42/);
    assert.ok(buttonExact(tree, "Reclaim"));
    assert.equal(buttonExact(tree, "Hand back…"), undefined);
    assert.equal(buttonExact(tree, "Escalate…"), undefined);
    assert.equal(buttonExact(tree, "Acknowledge…"), undefined);

    click(tabButton(tree, "Escalated"));
    tree = render();
    const escalated = textContent(tree);
    assert.match(escalated, /Reason: Missing authority/);
    assert.match(escalated, /Next action: UNIQUE_ESCALATED_NEXT_ACTION/);
    assert.match(escalated, /Severity: At Risk/);
    assert.match(escalated, /Expected response:/);
    assert.match(escalated, /Recipient: Brokerage Administrator/);
    assert.equal(buttonExact(tree, "Acknowledge…"), undefined, "the originating Pit Crew user cannot respond");
    assert.equal(buttonExact(tree, "Resolve…"), undefined);
    assert.equal(buttonExact(tree, "Return…"), undefined);
    assert.equal(buttonExact(tree, "Complete"), undefined, "an escalated item is not completable from here");
  } finally {
    clearGlobals();
  }

  const adminView = install(admin, workspace(), true);
  try {
    let tree = adminView.render();
    click(tabButton(tree, "Escalated"));
    tree = adminView.render();
    assert.ok(buttonExact(tree, "Acknowledge…"));
    assert.ok(buttonExact(tree, "Resolve…"));
    assert.ok(buttonExact(tree, "Return…"));
  } finally {
    clearGlobals();
  }
});

type FetchCall = { url: string; body: Record<string, unknown> };

function stubFetch(status: number, responseBody: unknown): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return calls;
}

async function submit(tree: unknown, pending: Promise<unknown>[]) {
  const onSubmit = formNode(tree)?.props?.onSubmit;
  if (typeof onSubmit !== "function") throw new Error("missing form");
  onSubmit({ preventDefault() {} });
  await Promise.all(pending);
}

test("hand back, escalate, reclaim, and resolve submit the loaded version and the route body", async () => {
  const original = globalThis.fetch;
  const calls = stubFetch(200, { id: 1, version: 4, responsibilityEvent: { closingNote: null } });
  const { render, pending, invalidated } = install(pitCrew, workspace(), true);
  try {
    let tree = render();
    click(tabButton(tree, "My Work"));
    tree = render();
    click(buttonExact(tree, "Hand back…"));
    tree = render();
    change(field(tree, "reasonCategory"), "INFORMATION_RETURNED");
    tree = render();
    change(field(tree, "nextAction"), "Review the returned evidence.");
    tree = render();
    change(field(tree, "recipientUserId"), "42");
    tree = render();
    await submit(tree, pending);
    assert.equal(calls[0]?.url, "/api/pit-crew/items/EXCEPTION/claimed-item/hand-back");
    assert.deepEqual(calls[0]?.body, {
      propertyId: 15,
      expectedVersion: 3,
      reasonCategory: "INFORMATION_RETURNED",
      nextAction: "Review the returned evidence.",
      recipientUserId: 42,
    });
    assert.deepEqual(invalidated[0], ["pit-crew-workspace"]);

    click(buttonExact(tree, "Escalate…"));
    tree = render();
    change(field(tree, "reasonCategory"), "MISSING_AUTHORITY");
    tree = render();
    change(field(tree, "severity"), "CRITICAL");
    tree = render();
    change(field(tree, "note"), "Settlement figure is outside Pit Crew authority.");
    tree = render();
    change(field(tree, "nextAction"), "Decide the next settlement step.");
    tree = render();
    await submit(tree, pending);
    assert.equal(calls.length, 1, "AT_RISK and CRITICAL do not submit without an expected response");

    change(field(tree, "expectedResponseAt"), "2026-10-01T04:00");
    tree = render();
    await submit(tree, pending);
    assert.equal(calls[1]?.url, "/api/pit-crew/items/EXCEPTION/claimed-item/escalate");
    assert.equal(calls[1]?.body.expectedVersion, 3);
    assert.equal(calls[1]?.body.severity, "CRITICAL");
    assert.equal(calls[1]?.body.expectedResponseAt, new Date("2026-10-01T04:00").toISOString());
    assert.equal("recipientUserId" in (calls[1]?.body ?? {}), false);

    click(tabButton(tree, "Handed back"));
    tree = render();
    click(buttonExact(tree, "Reclaim"));
    await Promise.all(pending);
    assert.equal(calls[2]?.url, "/api/pit-crew/items/EXCEPTION/handed-item/hand-back/reclaim");
    assert.deepEqual(calls[2]?.body, { propertyId: 15, expectedVersion: 7 });
  } finally {
    globalThis.fetch = original;
    clearGlobals();
  }

  const adminCalls = stubFetch(200, { id: 1, version: 9, responsibilityEvent: { closingNote: "Authorised." } });
  const adminView = install(admin, workspace(), true);
  try {
    let tree = adminView.render();
    click(tabButton(tree, "Escalated"));
    tree = adminView.render();
    click(buttonExact(tree, "Resolve…"));
    tree = adminView.render();
    await submit(tree, adminView.pending);
    assert.equal(adminCalls.length, 0, "resolve does not submit without a note");
    change(field(tree, "note"), "Authorised the next step.");
    tree = adminView.render();
    await submit(tree, adminView.pending);
    assert.equal(adminCalls[0]?.url, "/api/pit-crew/items/EXCEPTION/escalated-item/escalation/resolve");
    assert.deepEqual(adminCalls[0]?.body, { propertyId: 15, expectedVersion: 8, note: "Authorised the next step." });
  } finally {
    globalThis.fetch = original;
    clearGlobals();
  }
});

test("a responsibility action shows the concurrency sentence, the transition sentence, or a neutral 404", async () => {
  const original = globalThis.fetch;
  const cases = [
    { status: 409, error: "This item was changed by someone else. Refresh and try again.", shown: "This item was changed by someone else. Refresh and try again." },
    { status: 422, error: "Cannot move a Pit Crew item from DONE to HANDED_BACK.", shown: "Cannot move a Pit Crew item from DONE to HANDED_BACK." },
    { status: 404, error: "Not found.", shown: PIT_CREW_RESPONSIBILITY_UNAVAILABLE_MESSAGE },
  ];
  try {
    for (const entry of cases) {
      stubFetch(entry.status, { error: entry.error });
      const { render, pending } = install(pitCrew, workspace(), true);
      let tree = render();
      click(tabButton(tree, "My Work"));
      tree = render();
      click(buttonExact(tree, "Hand back…"));
      tree = render();
      change(field(tree, "reasonCategory"), "WORK_COMPLETE");
      tree = render();
      change(field(tree, "nextAction"), "Review the returned evidence.");
      tree = render();
      await submit(tree, pending);
      tree = render();
      assert.match(textContent(tree), new RegExp(entry.shown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      if (entry.status === 404) {
        assert.equal(textContent(tree).includes("may have been removed"), false);
      }
      clearGlobals();
    }
  } finally {
    globalThis.fetch = original;
  }
});
