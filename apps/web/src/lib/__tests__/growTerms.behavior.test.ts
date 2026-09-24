import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import {
  ASK_DUE_FOLLOW_UPS_QUESTION,
  CALL_COMMITMENT_LABEL,
  CALL_FOLLOW_UP_LABEL,
  CALL_ITEMS_HELP,
  CALL_ITEMS_TITLE,
  COMMITMENT_LABEL,
  DUE_FOLLOW_UP_FORM_HINT,
  DUE_FOLLOW_UP_LABEL,
  DUE_TODAY_COUNT_HINT,
  DUE_TODAY_COUNT_LABEL,
  NEXT_COMMITMENT_LABEL,
  NO_OPEN_COMMITMENT,
  PROPOSE_SELECTED_LABEL,
  SAVE_DUE_FOLLOW_UP_LABEL,
  SET_DUE_FOLLOW_UP_LABEL,
  showCommitmentNotFollowUp,
} from "../growTerms";

// G-6 — "follow-up" was the name of a due opportunity/appraisal step, an Open
// commitment, a call-review item, and the proposal that creates a commitment.
// These tests lock one name for each record. They do not change the writes.

test("G-6: the glossary keeps a due follow-up, a commitment, and a call item apart", () => {
  assert.equal(DUE_FOLLOW_UP_LABEL, "Due follow-up");
  assert.equal(COMMITMENT_LABEL, "Commitment");
  assert.notEqual(DUE_FOLLOW_UP_LABEL, COMMITMENT_LABEL);
  assert.equal(CALL_FOLLOW_UP_LABEL, "Call follow-up");
  assert.equal(CALL_COMMITMENT_LABEL, "Call commitment");
  assert.equal(DUE_TODAY_COUNT_LABEL, "Due follow-ups & commitments");
  assert.match(DUE_TODAY_COUNT_HINT, /due follow-up/i);
  assert.match(DUE_TODAY_COUNT_HINT, /commitment/i);
  assert.doesNotMatch(DUE_TODAY_COUNT_HINT, /follow-up commitment/i);
  assert.match(DUE_FOLLOW_UP_FORM_HINT, /does not create a commitment/);
  assert.equal(SET_DUE_FOLLOW_UP_LABEL, "Set due follow-up");
  assert.equal(SAVE_DUE_FOLLOW_UP_LABEL, "Save due follow-up");
  assert.equal(NEXT_COMMITMENT_LABEL, "Next commitment:");
  assert.equal(NO_OPEN_COMMITMENT, "No open commitment.");
  assert.equal(CALL_ITEMS_TITLE, "Call follow-ups and call commitments");
  assert.match(CALL_ITEMS_HELP, /does not set a due follow-up/);
  assert.equal(PROPOSE_SELECTED_LABEL, "Propose selected items");
  assert.equal(ASK_DUE_FOLLOW_UPS_QUESTION, "What due follow-ups are overdue?");
  assert.equal(showCommitmentNotFollowUp("Create a follow-up commitment for Jo"), "Create a commitment for Jo");
  assert.equal(showCommitmentNotFollowUp("Set a due follow-up"), "Set a due follow-up");
  assert.equal(showCommitmentNotFollowUp("Call follow-up from the review"), "Call follow-up from the review");
});

const WEB_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function productionSources(dir: string, files: string[]) {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) productionSources(full, files);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) files.push(full);
  }
}

function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  return withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: "follow-up commitment", pattern: /follow-up commitment/i },
  { name: "Follow-Ups Due", pattern: /Follow-Ups Due/ },
  { name: "Next follow-up", pattern: /Next follow-up/ },
  { name: "Proposed follow-up", pattern: /Proposed follow-up/ },
  { name: "Create follow-up", pattern: /Create follow-up/ },
  { name: "Save follow-up", pattern: /Save follow-up/ },
  { name: "No follow-up currently scheduled", pattern: /No follow-up currently scheduled/ },
  { name: "Propose selected follow-ups", pattern: /Propose selected follow-ups/ },
  { name: "What follow-ups are overdue", pattern: /What follow-ups are overdue/ },
];

test("G-6: production web copy does not call a commitment a follow-up", () => {
  const files: string[] = [];
  productionSources(WEB_SRC, files);
  const hits: string[] = [];
  for (const file of files) {
    const relative = path.relative(WEB_SRC, file);
    const stripped = stripComments(readFileSync(file, "utf8"));
    stripped.split("\n").forEach((line, index) => {
      for (const rule of FORBIDDEN) {
        if (!rule.pattern.test(line)) continue;
        // The display rewrite names the old phrase so it can remove it.
        if (rule.name === "follow-up commitment" && relative === "lib/growTerms.ts" && line.includes(".replace(")) continue;
        hits.push(`${relative}:${index + 1} ${rule.name}`);
      }
    });
  }
  assert.deepEqual(hits, []);
});

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

const virtualMocks: Plugin = {
  name: "g6-grow-term-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:g6-react") return "\0g6-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:g6-jsx") return "\0g6-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:g6-query") return "\0g6-query";
    if (source === "wouter" || source === "virtual:g6-wouter") return "\0g6-wouter";
    if (source === "../lib/api" || source === "../../lib/api") return "\0g6-api";
    if (source === "../lib/session") return "\0g6-session";
    if (
      source === "../components/AskAgentEngine" ||
      source === "../components/CommunicationsSection" ||
      source === "../components/PropertyIntelligencePanel" ||
      source === "../components/GrowContactTranscriptPanel" ||
      source === "../components/GrowPendingCommitmentProposals" ||
      source === "../components/ErrorBoundary"
    ) {
      return "\0g6-components";
    }
    return null;
  },
  load(id) {
    if (id === "\0g6-react") {
      return `
        export const useState = (initial) => [typeof initial === "function" ? initial() : initial, () => {}];
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0g6-jsx") {
      return `
        export const Fragment = Symbol.for("g6-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0g6-query") {
      return `
        export const useQueryClient = () => ({ invalidateQueries() {} });
        export const useQuery = (options) => {
          const key = JSON.stringify(options.queryKey);
          const table = globalThis.__g6Queries;
          if (table && Object.prototype.hasOwnProperty.call(table, key)) return table[key];
          return { isLoading: true, isError: false, data: undefined, refetch() {} };
        };
        export const useMutation = () => ({ isPending: false, isError: false, error: null, mutate() {} });
      `;
    }
    if (id === "\0g6-wouter") {
      return `export const Link = (props) => ({ type: "a", props }); export const useSearch = () => "";`;
    }
    if (id === "\0g6-api") {
      return `
        export class ApiError extends Error {}
        export const apiFetch = () => Promise.resolve({});
        export function apiErrorMessage(error, fallback) {
          if (error instanceof ApiError && typeof error.friendly === "string" && error.friendly.trim()) return error.friendly;
          return fallback;
        }
      `;
    }
    if (id === "\0g6-session") {
      return `
        export const useSession = () => ({ user: { firstName: "Sam" } });
        export const useEntitlements = () => ({
          isLoading: false,
          hasEntitlement: (key) => globalThis.__g6Entitlements.includes(key),
        });
      `;
    }
    if (id === "\0g6-components") {
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
        { find: /^react$/, replacement: "virtual:g6-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:g6-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:g6-query" },
        { find: /^wouter$/, replacement: "virtual:g6-wouter" },
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

function todayAction(type: "opportunity_follow_up" | "commitment") {
  const commitment = type === "commitment";
  return {
    id: commitment ? "commitment:9" : "opportunity:4",
    type,
    priority: "DoToday",
    partyId: 12,
    contactName: commitment ? "Casey Committed" : "Olive Owner",
    contactEmail: null,
    contactMobile: null,
    relationshipType: null,
    propertyId: null,
    propertyLabel: null,
    opportunityId: commitment ? null : 4,
    appraisalId: null,
    commitmentId: commitment ? 9 : null,
    reason: commitment ? "Open commitment is due today. Promised: Call Casey." : "Follow-up is due today.",
    recommendedAction: commitment ? "Call Casey." : "Call Olive back.",
    dueAt: "2026-09-24T00:00:00.000Z",
    lastActivityAt: null,
    availableActions: commitment
      ? [{ action: "add_note" }, { action: "view_contact", partyId: 12 }]
      : [{ action: "add_note" }, { action: "update_next_action", opportunityId: 4 }, { action: "view_contact", partyId: 12 }],
    rankScore: 0,
    confidenceBand: null,
    contactability: "contactable",
    contactabilityNote: null,
    whyItMatters: null,
  };
}

function todayQuery(type: "opportunity_follow_up" | "commitment") {
  return {
    isLoading: false,
    isError: false,
    refetch() {},
    data: {
      generatedAt: "2026-09-24T01:00:00.000Z",
      hasAnyGrowData: true,
      counts: { priorityActions: 1, followUpsDue: 3, openOpportunities: 1, contactsNeedingAttention: 1 },
      priorityActions: [todayAction(type)],
      signalSummary: { surfaced: 0, emergingSurfaced: 0, emergingWithheld: 0, withheldDoNotContact: 0 },
    },
  };
}

test("G-6: Grow Today names a due follow-up and a commitment as different cards", async () => {
  Object.assign(globalThis, { __g6Entitlements: ["grow.opportunities.manage", "grow.activities.manage", "grow.contacts.read"] });
  try {
    await withVite(async (vite) => {
      const { GrowToday } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as {
        GrowToday: (props: Record<string, unknown>) => unknown;
      };
      const props = {
        onAskAE: () => {},
        onViewContact: () => {},
        onEmailContact: () => {},
        onSmsContact: () => {},
      };

      (globalThis as { __g6Queries: Record<string, unknown> }).__g6Queries = { '["grow-today"]': todayQuery("opportunity_follow_up") };
      const due = GrowToday(props);
      const dueText = textContent(due);
      assert.match(dueText, /Due follow-ups & commitments/);
      assert.match(dueText, /A due follow-up is a next step on that record/);
      assert.equal(dueText.includes("Follow-Ups Due"), false);
      const duePills = findAll(due, (element) => element.props?.className === "pill").map(textContent);
      assert.deepEqual(duePills, ["Due follow-up"]);
      assert.ok(button(due, "Set due follow-up"), "the opportunity card sets a due follow-up");
      assert.equal(button(due, "Create follow-up"), undefined);

      (globalThis as { __g6Queries: Record<string, unknown> }).__g6Queries = { '["grow-today"]': todayQuery("commitment") };
      const commitment = GrowToday(props);
      const commitmentPills = findAll(commitment, (element) => element.props?.className === "pill").map(textContent);
      assert.deepEqual(commitmentPills, ["Commitment"]);
      assert.equal(button(commitment, "Set due follow-up"), undefined, "an open commitment is not edited as a due follow-up");
      assert.match(textContent(commitment), /Open commitment is due today/);
    });
  } finally {
    delete (globalThis as { __g6Queries?: unknown }).__g6Queries;
    delete (globalThis as { __g6Entitlements?: unknown }).__g6Entitlements;
  }
});
