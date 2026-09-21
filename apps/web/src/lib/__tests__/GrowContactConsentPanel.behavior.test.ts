// AE GROW Completion W3-A (A-7) — GrowContactConsentPanel behaviour.
//
// The panel is the first consent management UI in AE, so what is worth
// asserting is not "it renders" but the four rules it exists to hold:
//
//   1. It renders correctly with ZERO consent data. That is the state of every
//      contact in the pilot, and the screen has to explain the fail-closed
//      answer rather than show an error or an empty box.
//   2. Capture and withdraw are HIDDEN without grow.contacts.manage. The
//      server is still the authority — hasEntitlement() is documented in this
//      repository as a UX signal only — but offering an action that is going
//      to 403 is its own defect.
//   3. Withdrawal requires a reason, enforced before the request rather than
//      by a rejected one, and it supersedes exactly one stream.
//   4. The audit history is visible, and the superseded record is still in it.
//
// Rendering technique is the one GrowContactTranscriptPanel.behavior.test.ts
// established: vite's SSR loader with react, the JSX runtime, react-query and
// the app's own modules replaced by virtual mocks, so the component's real
// source is executed without a DOM.

import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin } from "vite";

interface ElementNode {
  type?: unknown;
  props?: {
    children?: unknown;
    onClick?: () => void;
    onSubmit?: (event: { preventDefault: () => void }) => void;
    disabled?: boolean;
    id?: string;
    value?: unknown;
    onChange?: (event: { target: { value: string } }) => void;
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

const buttons = (node: unknown, label: string) =>
  findAll(node, (e) => e.type === "button" && textContent(e).includes(label));
const forms = (node: unknown) => findAll(node, (e) => e.type === "form");
const fieldById = (node: unknown, id: string) => findAll(node, (e) => e.props?.id === id)[0];

/** A contact with nothing recorded — the pilot's normal state. */
function blankContactability() {
  const channels = ["EMAIL", "SMS", "PHONE_CALL", "VOICE_CALL", "EXTERNAL_MESSAGE"].map((channel) => ({
    channel,
    status: "REVIEW_REQUIRED",
    reasonCode: "UNKNOWN_CONSENT",
    decision: {
      recorded: false,
      decision: "REVIEW_REQUIRED",
      reasonCode: "UNKNOWN_CONSENT",
      reasonCodes: ["UNKNOWN_CONSENT"],
      jurisdiction: null,
      policyVersion: null,
      purpose: channel === "PHONE_CALL" ? "PHONE_CALL" : channel,
      scope: "OUTBOUND",
      streamRecorded: false,
      evaluatedAt: "2026-09-21T00:00:00.000Z",
    },
    lastRecordedDecision: null,
    consentState: "UNKNOWN",
    consent: null,
    streams: [],
    dncrStatus: "NOT_CHECKED",
    dncr: null,
    suppressed: false,
    suppression: null,
  }));
  return {
    evaluatedAt: "2026-09-21T00:00:00.000Z",
    status: "REVIEW_REQUIRED",
    statusReasonCode: "UNKNOWN_CONSENT",
    hasConsentRecords: false,
    awaitingPolicyApproval: true,
    policies: [],
    channels,
    activeSuppressions: [],
    history: [],
    historyTruncated: false,
  };
}

/** The same contact after an express consent was captured and superseded. */
function contactabilityWithHistory() {
  const base = blankContactability();
  const head = {
    consentId: 42,
    channel: "EMAIL",
    purpose: "MARKETING",
    scope: "BROKERAGE",
    state: "EXPRESS",
    source: "Signed appraisal authority",
    captureMethod: "WRITTEN",
    jurisdiction: "AU",
    capturedAt: "2026-09-02T00:00:00.000Z",
    expiresAt: null,
    reviewAt: null,
    evidenceReference: "authority-4471",
    hasEvidencePayload: false,
    inferredReasoning: null,
    notRequiredJustification: null,
    withdrawnAt: null,
    withdrawnByUserId: null,
    withdrawalReason: null,
    supersedesConsentId: 41,
    recordedByUserId: 7,
    recordedAt: "2026-09-02T00:00:00.000Z",
  };
  const superseded = {
    ...head,
    consentId: 41,
    state: "UNKNOWN",
    source: "Imported from spreadsheet",
    evidenceReference: null,
    supersedesConsentId: null,
    recordedAt: "2026-09-01T00:00:00.000Z",
  };
  const email = base.channels[0];
  email.consentState = "EXPRESS";
  email.consent = head as never;
  email.streams = [head] as never;
  email.reasonCode = "POLICY_NOT_FOUND";
  return {
    ...base,
    hasConsentRecords: true,
    statusReasonCode: "POLICY_NOT_FOUND",
    history: [
      { kind: "CONSENT", id: 42, occurredAt: head.recordedAt, ...head },
      { kind: "CONSENT", id: 41, occurredAt: superseded.recordedAt, ...superseded },
    ],
  };
}

interface Harness {
  render: (props: Record<string, unknown>) => unknown;
  writes: Array<{ path: string; options?: { method?: string; body?: string } }>;
  settle: () => Promise<void>;
  close: () => Promise<void>;
  setEntitlements: (keys: string[]) => void;
}

async function harness(): Promise<Harness> {
  const state: unknown[] = [];
  let stateCursor = 0;
  const writes: Array<{ path: string; options?: { method?: string; body?: string } }> = [];
  let pending: Promise<unknown>[] = [];
  let entitlements: string[] = [];

  const hooks = {
    beginRender() {
      stateCursor = 0;
    },
    useState(initial: unknown) {
      const index = stateCursor++;
      if (!(index in state)) state[index] = initial;
      return [
        state[index],
        (next: unknown) => {
          state[index] = typeof next === "function" ? (next as (current: unknown) => unknown)(state[index]) : next;
        },
      ];
    },
  };

  const virtualMocks: Plugin = {
    name: "consent-panel-behavior-mocks",
    enforce: "pre",
    resolveId(source) {
      if (source === "react" || source === "virtual:consent-react") return "\0consent-react";
      if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:consent-jsx") return "\0consent-jsx";
      if (source === "@tanstack/react-query" || source === "virtual:consent-query") return "\0consent-query";
      if (source.endsWith("/lib/api") || source === "../lib/api") return "\0consent-api";
      if (source.endsWith("/lib/session") || source === "../lib/session") return "\0consent-session";
      return null;
    },
    load(id) {
      if (id === "\0consent-react") {
        return `export const useState = (...args) => globalThis.__consentHooks.useState(...args);`;
      }
      if (id === "\0consent-jsx") {
        return `
          export const Fragment = Symbol.for("consent-test-fragment");
          export const jsx = (type, props) => ({ type, props });
          export const jsxs = jsx;
          export const jsxDEV = jsx;
        `;
      }
      if (id === "\0consent-query") {
        return `
          export const useMutation = (options) => ({
            isPending: false,
            isError: false,
            mutate(input) {
              globalThis.__consentPending.push(
                Promise.resolve(options.mutationFn(input)).then((result) => options.onSuccess && options.onSuccess(result)),
              );
            },
          });
        `;
      }
      if (id === "\0consent-api") {
        return `
          export class ApiError extends Error {}
          export const apiFetch = (path, options) => globalThis.__consentApiFetch(path, options);
        `;
      }
      if (id === "\0consent-session") {
        return `
          export const useEntitlements = () => ({
            entitlements: globalThis.__consentEntitlements,
            isLoading: false,
            hasEntitlement: (key) => globalThis.__consentEntitlements.includes(key),
          });
        `;
      }
      return null;
    },
  };

  Object.assign(globalThis, {
    __consentHooks: hooks,
    __consentPending: pending,
    __consentEntitlements: entitlements,
    __consentApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      writes.push({ path, options });
      return Promise.resolve({ consent: { id: 99 } });
    },
  });

  const vite = await createServer({
    root: new URL("../../..", import.meta.url).pathname,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: true },
    resolve: {
      alias: [
        { find: /^react$/, replacement: "virtual:consent-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:consent-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:consent-query" },
      ],
    },
    plugins: [virtualMocks],
  });

  const { GrowContactConsentPanel } = (await vite.ssrLoadModule("/src/components/GrowContactConsentPanel.tsx")) as {
    GrowContactConsentPanel: (props: Record<string, unknown>) => unknown;
  };

  return {
    render(props) {
      hooks.beginRender();
      return GrowContactConsentPanel(props);
    },
    writes,
    async settle() {
      await Promise.all(pending);
      pending = [];
      (globalThis as typeof globalThis & { __consentPending: Promise<unknown>[] }).__consentPending = pending;
    },
    setEntitlements(keys) {
      entitlements = keys;
      (globalThis as typeof globalThis & { __consentEntitlements: string[] }).__consentEntitlements = keys;
    },
    async close() {
      await vite.close();
      for (const key of ["__consentHooks", "__consentPending", "__consentEntitlements", "__consentApiFetch"]) {
        delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

test("with zero consent data the panel explains the fail-closed answer, and offers no action without grow.contacts.manage", async () => {
  const h = await harness();
  try {
    h.setEntitlements(["grow.contacts.read"]);
    const tree = h.render({ partyId: 12, contactability: blankContactability(), onChanged: () => {} });
    const text = textContent(tree);

    // Not an error, not an empty box, and not a fabricated eligible state.
    assert.ok(text.includes("Needs review before contacting"));
    assert.ok(text.includes("Nothing has been recorded for this contact"));
    assert.ok(text.includes("No consent policy has been approved for this brokerage yet"));
    assert.ok(text.includes("expected pilot state, not a fault"));
    assert.ok(!text.includes("Cleared to contact"));

    // Every channel is present and explained.
    for (const label of ["Email", "SMS", "Phone call", "Voice call", "External message"]) {
      assert.ok(text.includes(label), `${label} must be listed`);
    }
    assert.ok(text.includes("No consent recorded on this channel."));
    assert.ok(text.includes("Nobody has checked the Do Not Call Register"));
    assert.ok(text.includes("Viewing this screen does not record a decision."));

    // Actions are hidden, and the reason is stated rather than left blank.
    assert.equal(buttons(tree, "Record consent").length, 0);
    assert.equal(buttons(tree, "Withdraw consent").length, 0);
    assert.ok(text.includes("needs Grow contact management access"));
  } finally {
    await h.close();
  }
});

test("with grow.contacts.manage the capture action appears, and a withdrawal is refused until it carries a reason", async () => {
  const h = await harness();
  try {
    h.setEntitlements(["grow.contacts.read", "grow.contacts.manage"]);
    const data = contactabilityWithHistory();
    const props = { partyId: 12, contactability: data, onChanged: () => {} };

    let tree = h.render(props);
    assert.equal(buttons(tree, "Record consent").length, 1);
    const withdrawButtons = buttons(tree, "Withdraw consent");
    assert.equal(withdrawButtons.length, 1, "only the one recorded, non-withdrawn stream can be withdrawn");

    withdrawButtons[0]!.props!.onClick!();
    tree = h.render(props);
    const text = textContent(tree);
    assert.ok(text.includes("Withdraw Email consent — MARKETING / BROKERAGE"));
    assert.ok(text.includes("This withdraws one purpose and scope, not the whole contact"));

    // An empty reason is refused BEFORE the request: the form says what is
    // missing and the submit button is disabled.
    assert.ok(text.includes("A withdrawal reason is required"));
    const save = buttons(tree, "Save withdrawal")[0]!;
    assert.equal(save.props!.disabled, true);

    // Submitting anyway writes nothing.
    const withdrawalForm = forms(tree).find((f) => textContent(f).includes("Save withdrawal"))!;
    withdrawalForm.props!.onSubmit!({ preventDefault() {} });
    await h.settle();
    assert.equal(h.writes.length, 0, "a withdrawal without a reason must never reach the API");

    // Fill the reason and the source, and it goes through as a supersede of
    // exactly one stream.
    fieldById(tree, "grow-consent-withdraw-reason")!.props!.onChange!({ target: { value: "Asked to be removed from marketing email." } });
    tree = h.render(props);
    fieldById(tree, "grow-consent-withdraw-source")!.props!.onChange!({ target: { value: "Inbound phone call" } });
    tree = h.render(props);

    assert.equal(buttons(tree, "Save withdrawal")[0]!.props!.disabled, false);
    forms(tree).find((f) => textContent(f).includes("Save withdrawal"))!.props!.onSubmit!({ preventDefault() {} });
    await h.settle();

    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0]!.path, "/grow/contacts/12/consent");
    assert.equal(h.writes[0]!.options!.method, "POST");
    const body = JSON.parse(h.writes[0]!.options!.body!);
    assert.equal(body.state, "WITHDRAWN");
    assert.equal(body.channel, "EMAIL");
    assert.equal(body.purpose, "MARKETING");
    assert.equal(body.scope, "BROKERAGE");
    assert.equal(body.supersedesConsentId, 42);
    assert.equal(body.withdrawalReason, "Asked to be removed from marketing email.");
    assert.ok(typeof body.withdrawnAt === "string");
    assert.ok(!("withdrawnByUserId" in body), "the actor comes from the session, never from the browser");
  } finally {
    await h.close();
  }
});

test("the audit history is available and still contains the superseded record", async () => {
  const h = await harness();
  try {
    h.setEntitlements(["grow.contacts.read"]);
    const props = { partyId: 12, contactability: contactabilityWithHistory(), onChanged: () => {} };

    let tree = h.render(props);
    assert.ok(!textContent(tree).includes("Imported from spreadsheet"), "history is collapsed until asked for");

    buttons(tree, "Show full history")[0]!.props!.onClick!();
    tree = h.render(props);
    const text = textContent(tree);

    assert.ok(text.includes("Email · Express consent · MARKETING / BROKERAGE"));
    // The append-only point: the earlier record is still there, superseded
    // rather than edited away.
    assert.ok(text.includes("Email · Not recorded · MARKETING / BROKERAGE"));
    assert.ok(text.includes("Imported from spreadsheet"));
    assert.ok(text.includes("supersedes record #41"));
    assert.ok(text.includes("append-only"));
  } finally {
    await h.close();
  }
});
