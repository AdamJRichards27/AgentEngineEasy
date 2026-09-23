import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { unusableSignalNotice, CONTACT_ANCHORED_SECTION_BLURB } from "../contactAnchoredSignals";

// AE GROW Completion W2-D — PropertyIntelligencePanel behaviour, same harness
// convention as growOpportunityActions.behavior.test.ts: React, React Query,
// wouter, the session/entitlement hooks and the API client are replaced with
// tiny in-memory fakes so the REAL component function runs under node without
// a DOM.
//
// =====================================================================
// WHAT THIS FILE IS FOR
// =====================================================================
//
// Decision gate 19 lets AE show a DNC-listed or fully-suppressed contact's
// signals to an authorised internal user, on conditions — and two of those
// conditions are about THIS surface rather than about the API:
//
//   - the contact/outreach restriction is displayed UNMISTAKABLY;
//   - calling, SMS and email are suppressed or disabled, and no generated
//     outreach action is offered.
//
// The API-side proof lives in
// apps/api/src/lib/propertyIntelligence/__tests__/contactabilityOutreachPathway.test.ts,
// which proves the PAYLOAD carries no destination. That is necessary and not
// sufficient: a panel could still render a `mailto:` from a contact's details
// it already had, or leave the one control that feeds the outreach funnel on
// screen. These tests render the shipped component and assert on the tree.

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

/** Every href the panel renders, whatever the element. */
function hrefs(tree: unknown): string[] {
  return findAll(tree, (element) => typeof element.props?.href === "string").map((element) => String(element.props!.href));
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
  name: "w2d-contact-anchored-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:w2d-react") return "\0w2d-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:w2d-jsx") return "\0w2d-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:w2d-query") return "\0w2d-query";
    if (source === "wouter" || source === "virtual:w2d-wouter") return "\0w2d-wouter";
    if (source === "../lib/api") return "\0w2d-api";
    if (source === "../lib/session") return "\0w2d-session";
    return null;
  },
  load(id) {
    if (id === "\0w2d-react") {
      return `
        export const useState = (...args) => globalThis.__w2dHooks.useState(...args);
        export const useEffect = (...args) => globalThis.__w2dHooks.useEffect(...args);
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0w2d-jsx") {
      // Function components are CALLED, not merely recorded: the restriction
      // banner and the action row are what these tests are about.
      return `
        export const Fragment = Symbol.for("w2d-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0w2d-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries: () => {} });
        export const useQuery = () => globalThis.__w2dQuery;
        export const useMutation = (options) => ({
          isPending: false,
          isError: false,
          error: null,
          mutate: (input) => { globalThis.__w2dMutations.push(input); options.mutationFn(input); },
        });
      `;
    }
    if (id === "\0w2d-wouter") {
      return `export const Link = (props) => ({ type: "a", props });`;
    }
    if (id === "\0w2d-api") {
      return `
        export const ApiError = globalThis.__w2dApiError;
        export const apiFetch = (path, options) => { globalThis.__w2dCalls.push({ path, options }); return Promise.resolve({}); };
      `;
    }
    if (id === "\0w2d-session") {
      return `
        export const useSession = () => ({ user: { id: 1, firstName: "Sam", role: "Agent" } });
        export const useEntitlements = () => ({ isLoading: false, hasEntitlement: (key) => globalThis.__w2dEntitlements.includes(key) });
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
        { find: /^react$/, replacement: "virtual:w2d-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:w2d-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:w2d-query" },
        { find: /^wouter$/, replacement: "virtual:w2d-wouter" },
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

/** The agentAction a rule authors. It must never reach a restricted contact's panel. */
const OUTREACH_SUGGESTION = "Consider a genuine, useful reason to get back in touch.";

const contactAnchoredEntry = (overrides: Record<string, unknown> = {}) => ({
  anchor: "contact",
  signal: {
    id: 9,
    partyId: 12,
    propertyId: null,
    signalType: "re_engagement_opportunity",
    title: "Worth reconnecting",
    explanation: "Recorded from AE's own records. This is not a prediction that anybody will sell.",
    source: "internal",
    sourceTimestamp: null,
    computedAt: "2026-09-21T00:00:00.000Z",
    confidenceBand: "WorthReviewing",
    expiresAt: null,
    promotedOpportunityId: null,
  },
  observations: [{ what: "An enquiry was recorded in AE.", recordType: "grow_relationship", recordId: 1, observedAt: null, source: "internal" }],
  unknowns: ["Whether their plans have changed since."],
  missingPropertyAnchor: "AE has no verified property association for this signal.",
  agentAction: OUTREACH_SUGGESTION,
  ...overrides,
});

const RESTRICTION = {
  outreachProhibited: true,
  reason: "contactability_suppressed",
  blockedChannels: ["PHONE_CALL", "SMS", "EMAIL"],
  notice: "A do-not-contact listing or a full-channel suppression is on file for this contact. AE will not present them as someone to reach out to, and no outreach action is offered here.",
  recommendedAction: "Do not contact. This contact is on a do-not-contact record or is suppressed on every channel — review the contact record before taking any action at all.",
};

function installGlobals(summary: Record<string, unknown>) {
  const hooks = createHarness();
  const calls: unknown[] = [];
  const mutations: unknown[] = [];
  Object.assign(globalThis, {
    __w2dHooks: hooks,
    __w2dApiError: FakeApiError,
    __w2dCalls: calls,
    __w2dMutations: mutations,
    // Fully entitled, deliberately — so anything missing from the tree is
    // missing because of the restriction, not because of an entitlement.
    __w2dEntitlements: ["grow.propertyIntelligence.read", "grow.propertyIntelligence.manage"],
    __w2dQuery: { isLoading: false, isError: false, data: summary, refetch: () => {} },
  });
  return { hooks, calls, mutations };
}

function clearGlobals() {
  for (const key of ["__w2dHooks", "__w2dApiError", "__w2dCalls", "__w2dMutations", "__w2dEntitlements", "__w2dQuery"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

async function renderPanel(): Promise<unknown> {
  return withVite(async (vite) => {
    const { PropertyIntelligencePanel } = (await vite.ssrLoadModule("/src/components/PropertyIntelligencePanel.tsx")) as {
      PropertyIntelligencePanel: (props: Record<string, unknown>) => unknown;
    };
    (globalThis as { __w2dHooks: { beginRender(): void } }).__w2dHooks.beginRender();
    return PropertyIntelligencePanel({ anchor: "contact", partyId: 12 });
  });
}

/* =====================================================================
 * THE RESTRICTED PANEL.
 * ===================================================================*/

test("W2-D: a restricted contact's panel shows the intelligence, states the restriction, and offers no way to contact them", async () => {
  installGlobals({
    properties: [
      {
        propertyId: 77,
        propertyAddress: "1 Example St",
        relationshipType: "owner",
        pendingMatches: [],
        activeSignals: [contactAnchoredEntry().signal],
      },
    ],
    contactAnchoredSignals: [contactAnchoredEntry({ agentAction: null })],
    unusableSignalCount: 0,
    outreachRestriction: RESTRICTION,
  });
  try {
    const tree = await renderPanel();
    const text = textContent(tree);

    // 1. THE INTELLIGENCE IS SHOWN. Without this the rest is vacuous — an
    //    empty panel trivially offers no outreach.
    assert.match(text, /Worth reconnecting/, "the signal's title is rendered");
    assert.match(text, /not a prediction that anybody will sell/, "and its explanation");
    assert.match(text, /An enquiry was recorded in AE\./, "and the evidence behind it");
    assert.match(text, /Whether their plans have changed since\./, "and what AE does not know");

    // 2. THE RESTRICTION IS UNMISTAKABLE.
    assert.match(text, /Do not contact/, "the restriction is stated in the panel's own words");
    assert.match(text, /do-not-contact listing or a full-channel suppression/, "with the API's notice, verbatim");
    assert.match(text, /Calling, SMS and email are not available/, "and says plainly which channels are closed");
    const alert = findAll(tree, (el) => el.props?.role === "alert")[0];
    assert.ok(alert, "it is an alert, not a muted footnote");

    // 3. NO OUTREACH AFFORDANCE OF ANY KIND.
    const allHrefs = hrefs(tree);
    for (const href of allHrefs) {
      assert.doesNotMatch(href, /^(?:mailto|tel|sms|callto|whatsapp):/i, `no channel URI may be rendered (found ${href})`);
    }
    assert.doesNotMatch(text, /mailto:|tel:|sms:/i, "and none appears as text either");
    for (const label of ["Email", "SMS", "Text", "Call", "Send"]) {
      assert.equal(button(tree, label), undefined, `no "${label}" control is rendered`);
    }

    // 4. NO GENERATED OUTREACH ACTION.
    assert.doesNotMatch(text, /You might consider/, "no suggested approach is offered");
    assert.equal(text.includes(OUTREACH_SUGGESTION), false, "and the rule's own sentence appears nowhere");

    // 5. THE FUNNEL ENTRANCE IS GONE — for the contact-anchored signal AND
    //    for the same contact's property-anchored one. Promotion creates an
    //    opportunity, which is how a contact enters follow-up and outreach.
    assert.equal(button(tree, "Promote to opportunity"), undefined, "the promote control is not rendered at all, for any of this contact's signals");

    // 6. WHAT REMAINS is internal record-keeping, which reaches nobody. An
    //    agent must still be able to clear a signal they may not act on.
    assert.ok(button(tree, "Mark reviewed"), "review stays — it is an internal note, not an approach");
    assert.ok(button(tree, "Dismiss"), "dismiss stays for the same reason");
  } finally {
    clearGlobals();
  }
});

test("W2-D: an unrestricted contact keeps the full panel — the restriction is doing the work, not the component", async () => {
  installGlobals({
    properties: [],
    contactAnchoredSignals: [contactAnchoredEntry()],
    unusableSignalCount: 0,
    outreachRestriction: null,
  });
  try {
    const tree = await renderPanel();
    const text = textContent(tree);

    // The exact controls and prose the restricted panel withheld are present
    // here, which is what makes their absence above meaningful rather than an
    // artefact of the harness.
    assert.ok(button(tree, "Promote to opportunity"), "promotion is available for a contactable contact");
    assert.match(text, /You might consider/, "and the rule's suggested approach is shown");
    assert.ok(text.includes(OUTREACH_SUGGESTION), "verbatim");
    assert.doesNotMatch(text, /Do not contact/, "with no restriction banner");
    assert.match(text, /Worth reconnecting/, "and the same intelligence as before");
  } finally {
    clearGlobals();
  }
});

test("W2-D: a restriction from an older API response shape is still honoured safely", async () => {
  // An API build predating W2-D omits `outreachRestriction` entirely. Absent
  // means "no restriction on file" — which is safe precisely because that
  // build withheld a suppressed contact's signals instead, so there is no
  // combination in which signals appear without either the old withholding or
  // the new restriction.
  installGlobals({
    properties: [],
    contactAnchoredSignals: [contactAnchoredEntry({ agentAction: null })],
    unusableSignalCount: 2,
  });
  try {
    const tree = await renderPanel();
    const text = textContent(tree);
    assert.match(text, /Worth reconnecting/, "the panel still renders against an older payload");
    assert.match(text, /2 other signals are recorded/, "and the withholding notice still reports the unusable rows");
    assert.doesNotMatch(text, /You might consider/, "a null agentAction is still not rendered");
  } finally {
    clearGlobals();
  }
});

/* =====================================================================
 * THE PROSE HELPERS.
 * ===================================================================*/

test("W2-D: unusableSignalNotice counts honestly, reads as a records problem, and never blames the contact", () => {
  assert.equal(unusableSignalNotice(0), null, "nothing withheld, nothing said");
  assert.equal(unusableSignalNotice(-1), null, "a nonsense count says nothing rather than something wrong");
  assert.equal(unusableSignalNotice(Number.NaN), null, "and so does a non-finite one");

  const one = unusableSignalNotice(1)!;
  assert.match(one, /^1 other signal is recorded/, "singular reads as singular");
  assert.match(one, /Nothing has been deleted/, "and says the data is intact");
  assert.match(one, /Brokerage Administrator/, "and names who can look into it");

  const many = unusableSignalNotice(4)!;
  assert.match(many, /^4 other signals are recorded/, "plural reads as plural");

  // It is about AE's records, never about the person.
  for (const notice of [one, many]) {
    assert.doesNotMatch(notice, /\b(?:refus|decline|opt(?:ed)? out|do not contact|unresponsive)\b/i, "never a judgement about the contact");
  }
});

test("W2-D: the contact-anchored blurb promises no property and no property action", () => {
  assert.match(CONTACT_ANCHORED_SECTION_BLURB, /relate to this person rather than to a property/);
  assert.match(CONTACT_ANCHORED_SECTION_BLURB, /no property to open and no property action to take/);
});

/* =====================================================================
 * THE EMPTY STATE.
 *
 * Before W2-D the summary returned [] for a contact whose only Active signal
 * was contact-anchored, and this panel rendered "No property intelligence
 * connected to this contact yet." — affirmatively false about a contact AE
 * held a signal for. The API half is asserted in
 * apps/api/.../contactAnchoredSignals.test.ts; this is the render half, since
 * the false sentence was produced HERE.
 * ===================================================================*/

const EMPTY_STATE = "No property intelligence connected to this contact yet.";

test("W2-D: a contact whose only signal is contact-anchored is never told there is nothing to see", async () => {
  installGlobals({
    properties: [],
    contactAnchoredSignals: [contactAnchoredEntry()],
    unusableSignalCount: 0,
    outreachRestriction: null,
  });
  try {
    const text = textContent(await renderPanel());
    assert.equal(text.includes(EMPTY_STATE), false, "the empty state must not appear when AE holds a signal about this person");
    assert.match(text, /Worth reconnecting/, "the signal is what is rendered instead");
    assert.match(text, /About this contact/, "under its own heading");
    assert.match(text, /No property linked/, "which says plainly that there is no property, rather than implying there is nothing");
  } finally {
    clearGlobals();
  }
});

test("E-4: withheld signals are disclosed, and the panel does not also say there is nothing", async () => {
  installGlobals({
    properties: [],
    contactAnchoredSignals: [],
    unusableSignalCount: 1,
    outreachRestriction: null,
  });
  try {
    const text = textContent(await renderPanel());
    assert.equal(text.includes(EMPTY_STATE), false, "a withheld signal is not the same as no intelligence");
    assert.match(text, /1 other signal is recorded/, "the honest notice is what the agent reads");
    assert.match(text, /not shown/);
  } finally {
    clearGlobals();
  }
});

test("E-4: a restriction still shows intelligence that can be shown, and still discloses what cannot", async () => {
  installGlobals({
    properties: [],
    contactAnchoredSignals: [contactAnchoredEntry({ agentAction: null })],
    unusableSignalCount: 1,
    outreachRestriction: RESTRICTION,
  });
  try {
    const text = textContent(await renderPanel());
    assert.match(text, /Do not contact/, "the restriction stays unmistakable");
    assert.match(text, /Worth reconnecting/, "gate 19 keeps the contact-anchored signal visible");
    assert.match(text, /1 other signal is recorded/, "the withheld count is not cleared by the restriction");
    assert.doesNotMatch(text, /You might consider/, "generated outreach stays off a restricted contact");
    assert.equal(text.includes(EMPTY_STATE), false);
  } finally {
    clearGlobals();
  }
});

test("W2-D: a contact with genuinely nothing still sees the empty state", async () => {
  // The fix must not be "never show the empty state" — that would trade one
  // false statement for another.
  installGlobals({ properties: [], contactAnchoredSignals: [], unusableSignalCount: 0, outreachRestriction: null });
  try {
    const text = textContent(await renderPanel());
    assert.ok(text.includes(EMPTY_STATE), "the empty state is still shown when it is true");
  } finally {
    clearGlobals();
  }
});
