// GP-4 — Contact 360 disables Email/SMS when consent is already known to be
// absent, and says so in the same sentence the API returns.

import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin } from "vite";
import {
  OUTBOUND_CONSENT_REQUIRED_MESSAGE,
  OUTBOUND_DNC_BLOCKED_MESSAGE,
  knownOutboundSendBlock,
} from "../outboundSendConsent.ts";
import type { GrowContactability, GrowContactabilityChannel } from "../contactability.ts";

function channel(partial: Partial<GrowContactabilityChannel> & { channel: string }): GrowContactabilityChannel {
  return {
    status: "REVIEW_REQUIRED",
    reasonCode: "POLICY_INVALID_WINDOW",
    decision: {
      recorded: false,
      decision: "REVIEW_REQUIRED",
      reasonCode: "POLICY_INVALID_WINDOW",
      reasonCodes: ["POLICY_INVALID_WINDOW"],
      jurisdiction: null,
      policyVersion: null,
      purpose: partial.channel,
      scope: "OUTBOUND",
      streamRecorded: partial.consentState === "EXPRESS",
      evaluatedAt: "2026-10-08T00:00:00.000Z",
    },
    lastRecordedDecision: null,
    consentState: "UNKNOWN",
    consent: null,
    streams: [],
    dncrStatus: "NOT_CHECKED",
    dncr: null,
    suppressed: false,
    suppression: null,
    ...partial,
  };
}

function contactability(channels: GrowContactabilityChannel[]): GrowContactability {
  return {
    evaluatedAt: "2026-10-08T00:00:00.000Z",
    status: "REVIEW_REQUIRED",
    statusReasonCode: "POLICY_INVALID_WINDOW",
    hasConsentRecords: channels.some((row) => row.consentState === "EXPRESS"),
    awaitingPolicyApproval: true,
    policies: [],
    channels,
    activeSuppressions: [],
    history: [],
    historyTruncated: false,
  };
}

test("EXPRESS consent stays sendable while a missing or unknown state does not", () => {
  const express = contactability([
    channel({ channel: "EMAIL", consentState: "EXPRESS", status: "REVIEW_REQUIRED" }),
    channel({ channel: "SMS", consentState: "EXPRESS" }),
  ]);
  assert.equal(knownOutboundSendBlock(express, "EMAIL"), null);
  assert.equal(knownOutboundSendBlock(express, "SMS"), null);

  const absent = contactability([
    channel({ channel: "EMAIL", consentState: "UNKNOWN" }),
    channel({ channel: "SMS", consentState: "NONE" }),
  ]);
  assert.equal(knownOutboundSendBlock(absent, "EMAIL"), OUTBOUND_CONSENT_REQUIRED_MESSAGE);
  assert.equal(knownOutboundSendBlock(absent, "SMS"), OUTBOUND_CONSENT_REQUIRED_MESSAGE);
  assert.equal(knownOutboundSendBlock(undefined, "EMAIL"), null);
});

test("a do-not-contact listing blocks every send channel", () => {
  const listed = contactability([
    channel({ channel: "EMAIL", consentState: "EXPRESS" }),
    channel({ channel: "SMS", consentState: "EXPRESS", dncrStatus: "LISTED" }),
  ]);
  assert.equal(knownOutboundSendBlock(listed, "EMAIL"), OUTBOUND_DNC_BLOCKED_MESSAGE);
  assert.equal(knownOutboundSendBlock(listed, "SMS"), OUTBOUND_DNC_BLOCKED_MESSAGE);
});

interface ElementNode {
  type?: unknown;
  props?: { children?: unknown; disabled?: boolean; onClick?: () => void };
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
  findAll(node, (element) => element.type === "button" && textContent(element).trim() === label);

async function loadSection() {
  const mutations: unknown[][] = [];
  const effects: Array<() => void> = [];
  let states: unknown[] = [];
  let cursor = 0;

  const virtualMocks: Plugin = {
    name: "outbound-send-consent-mocks",
    enforce: "pre",
    resolveId(source) {
      if (source === "react" || source === "virtual:send-react") return "\0send-react";
      if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:send-jsx") return "\0send-jsx";
      if (source === "@tanstack/react-query" || source === "virtual:send-query") return "\0send-query";
      return null;
    },
    load(id) {
      if (id === "\0send-react") {
        return `
          export const useState = (initial) => globalThis.__sendHooks.useState(initial);
          export const useEffect = (fn) => { globalThis.__sendEffects.push(fn); };
        `;
      }
      if (id === "\0send-jsx") {
        return `
          export const Fragment = Symbol.for("send-consent-fragment");
          export const jsx = (type, props) => ({ type, props });
          export const jsxs = jsx;
          export const jsxDEV = jsx;
        `;
      }
      if (id === "\0send-query") {
        return `
          export const useQueryClient = () => ({ invalidateQueries() {} });
          export const useMutation = () => ({ isPending: false, mutate(...args) { globalThis.__sendMutations.push(args); } });
          export const useQuery = ({ queryKey }) => {
            const key = (queryKey || []).join(":");
            if (key.includes("recipients")) return { data: globalThis.__sendCandidates, isLoading: false, isError: false };
            return { data: { threads: [] }, isLoading: false, isError: false };
          };
        `;
      }
      return null;
    },
  };

  Object.assign(globalThis, {
    __sendMutations: mutations,
    __sendEffects: effects,
    __sendCandidates: { candidates: [{ email: "ada@example.com", mobile: "0400111222" }] },
    __sendHooks: {
      beginRender() {
        cursor = 0;
      },
      useState(initial: unknown) {
        const index = cursor++;
        if (states.length <= index) states.push(typeof initial === "function" ? (initial as () => unknown)() : initial);
        return [states[index], () => {}];
      },
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
        { find: /^react$/, replacement: "virtual:send-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:send-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:send-query" },
      ],
    },
    plugins: [virtualMocks],
  });

  const loaded = (await vite.ssrLoadModule("/src/components/CommunicationsSection.tsx")) as {
    ContactCommunicationsSection: (props: Record<string, unknown>) => unknown;
    MessageRow: (props: Record<string, unknown>) => unknown;
  };

  return {
    renderSection(props: Record<string, unknown>) {
      effects.length = 0;
      (globalThis as { __sendHooks: { beginRender: () => void } }).__sendHooks.beginRender();
      const tree = loaded.ContactCommunicationsSection(props);
      for (const effect of effects) effect();
      return tree;
    },
    renderRow(props: Record<string, unknown>) {
      (globalThis as { __sendHooks: { beginRender: () => void } }).__sendHooks.beginRender();
      states = [];
      cursor = 0;
      return loaded.MessageRow(props);
    },
    mutations,
    async close() {
      await vite.close();
    },
  };
}

const draftMessage = {
  id: 7,
  version: 1,
  status: "DRAFT",
  channel: "EMAIL",
  classification: "TRANSACTIONAL",
  subject: "Hello",
  bodyText: "Secret draft body",
  recipientDisplayName: "Ada",
  recipientDestination: "ada@example.com",
  failureDetail: null,
};

test("Email and SMS are disabled with the consent sentence when no consent is recorded", async () => {
  const ui = await loadSection();
  try {
    const absent = contactability([
      channel({ channel: "EMAIL", consentState: "UNKNOWN" }),
      channel({ channel: "SMS", consentState: "UNKNOWN" }),
    ]);
    const tree = ui.renderSection({
      partyId: 4,
      canStartThread: true,
      contactability: absent,
      quickComposeChannel: "EMAIL",
    });
    assert.equal(buttons(tree, "Email")[0]?.props?.disabled, true);
    assert.equal(buttons(tree, "SMS")[0]?.props?.disabled, true);
    assert.ok(textContent(tree).includes(OUTBOUND_CONSENT_REQUIRED_MESSAGE));
    assert.equal(ui.mutations.length, 0, "a known-absent consent must not start a send");

    const express = contactability([
      channel({ channel: "EMAIL", consentState: "EXPRESS", status: "REVIEW_REQUIRED" }),
      channel({ channel: "SMS", consentState: "EXPRESS", status: "REVIEW_REQUIRED" }),
    ]);
    ui.mutations.length = 0;
    const open = ui.renderSection({ partyId: 4, canStartThread: true, contactability: express });
    assert.equal(buttons(open, "Email")[0]?.props?.disabled, false);
    assert.equal(buttons(open, "SMS")[0]?.props?.disabled, false);
    assert.equal(textContent(open).includes(OUTBOUND_CONSENT_REQUIRED_MESSAGE), false);

    const listed = contactability([
      channel({ channel: "EMAIL", consentState: "EXPRESS", dncrStatus: "LISTED" }),
      channel({ channel: "SMS", consentState: "EXPRESS" }),
    ]);
    const blocked = ui.renderSection({ partyId: 4, canStartThread: true, contactability: listed });
    assert.equal(buttons(blocked, "Email")[0]?.props?.disabled, true);
    assert.equal(buttons(blocked, "SMS")[0]?.props?.disabled, true);
    assert.ok(textContent(blocked).includes(OUTBOUND_DNC_BLOCKED_MESSAGE));

    const row = ui.renderRow({
      message: draftMessage,
      onChanged: () => {},
      knownSendBlock: OUTBOUND_CONSENT_REQUIRED_MESSAGE,
    });
    assert.equal(buttons(row, "Send Now")[0]?.props?.disabled, true);
    assert.ok(textContent(row).includes(OUTBOUND_CONSENT_REQUIRED_MESSAGE));
    assert.equal(textContent(row).includes("Secret draft body"), true);

    const openRow = ui.renderRow({ message: draftMessage, onChanged: () => {} });
    assert.equal(buttons(openRow, "Send Now")[0]?.props?.disabled, false);
  } finally {
    await ui.close();
  }
});
