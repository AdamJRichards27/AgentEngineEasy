// Owner t181u hardening (G22): component-level behaviour tests of the Run
// financial screens, rendered through the real containers with React, React
// Query and apiFetch replaced by in-process stand-ins (same Vite SSR harness
// pattern as fundsReconciliation.behavior.test.ts; no new dependencies, no
// config change). Covers: statement view with reconciliation and the print
// flow, BA queue filters including Pending, refund-resolution form validation,
// and the Pit Crew read-only authority summary never showing card or mandate
// references. Synthetic data only; no network.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

interface El {
  type?: unknown;
  props?: Record<string, any> & { children?: unknown };
}
const text = (n: unknown): string =>
  typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(text).join("") : n && typeof n === "object" ? text((n as El).props?.children) : "";
const norm = (n: unknown) => text(n).replace(/\s+/g, " ").trim();
function findAll(n: unknown, pred: (e: El) => boolean): El[] {
  if (Array.isArray(n)) return n.flatMap((c) => findAll(c, pred));
  if (!n || typeof n !== "object") return [];
  const e = n as El;
  return (pred(e) ? [e] : []).concat(findAll(e.props?.children, pred));
}
const button = (t: unknown, label: RegExp) => findAll(t, (e) => e.type === "button" && label.test(norm(e)));
const section = (t: unknown, heading: string) => {
  const s = findAll(t, (e) => e.type === "section" && findAll(e, (c) => c.type === "h2" && norm(c) === heading).length > 0)[0];
  if (!s) throw new Error(`missing section ${heading}`);
  return s;
};
/** Every string reachable in the rendered tree, including attribute values. */
function allStrings(n: unknown, seen = new Set<unknown>()): string[] {
  if (typeof n === "string" || typeof n === "number") return [String(n)];
  if (!n || typeof n !== "object" || seen.has(n)) return [];
  seen.add(n);
  if (Array.isArray(n)) return n.flatMap((c) => allStrings(c, seen));
  const p = (n as El).props ?? {};
  return Object.entries(p).flatMap(([k, v]) => (typeof v === "function" ? [] : k === "children" ? allStrings(v, seen) : allStrings(v, seen)));
}

// ---- hook / query / api stand-ins -------------------------------------------
const g = globalThis as any;
function harness() {
  const state: unknown[] = [];
  let cur = 0;
  return {
    begin() {
      cur = 0;
    },
    useState(initial: unknown) {
      const i = cur++;
      if (!(i in state)) state[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [state[i], (next: unknown) => (state[i] = typeof next === "function" ? (next as (c: unknown) => unknown)(state[i]) : next)];
    },
  };
}
function reset(queries: Record<string, unknown> = {}) {
  g.__rfHooks = harness();
  g.__rfQueries = queries;
  g.__rfQueryCalls = [] as { key: string; enabled: unknown; queryFn: () => unknown }[];
  g.__rfApi = [] as { path: string; init?: { method?: string; body?: string } }[];
  g.__rfApiAnswer = (_p: string) => ({});
}

const mocks: Plugin = {
  name: "run-financial-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "virtual:rf-react") return "\0rf-react";
    if (source === "virtual:rf-jsx") return "\0rf-jsx";
    if (source === "virtual:rf-query") return "\0rf-query";
    if (/(^|\/)lib\/api(\.ts)?$/.test(source)) return "\0rf-api";
    return null;
  },
  load(id) {
    if (id === "\0rf-react")
      return `export const useState = (...a) => globalThis.__rfHooks.useState(...a);
        export const useEffect = () => {}; export const useRef = (v) => ({ current: v }); export const useMemo = (f) => f(); export const useCallback = (f) => f;
        export const createElement = (type, props, ...children) => (typeof type === "function" ? type({ ...props, children }) : { type, props: { ...props, children } });
        export default { useState };`;
    if (id === "\0rf-jsx")
      return `export const Fragment = Symbol.for("rf-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx; export const jsxDEV = jsx;`;
    if (id === "\0rf-query")
      return `export const useQueryClient = () => ({ invalidateQueries() {} });
        export const useQuery = (o) => { const key = JSON.stringify(o.queryKey); globalThis.__rfQueryCalls.push({ key, enabled: o.enabled, queryFn: o.queryFn });
          const t = globalThis.__rfQueries || {}; return Object.prototype.hasOwnProperty.call(t, key) ? t[key] : { isLoading: false, isError: false, data: undefined, error: null }; };
        export const useMutation = (o) => ({ isPending: false, isError: false, error: null, mutate(arg, opts) { const fn = o && o.mutationFn; const r = fn ? fn(arg) : undefined; globalThis.__rfMutations = (globalThis.__rfMutations || []).concat([{ arg, opts }]); return r; } });`;
    if (id === "\0rf-api")
      return `export const apiFetch = (path, init) => { globalThis.__rfApi.push({ path, init }); return Promise.resolve(globalThis.__rfApiAnswer(path)); };
        export const apiErrorMessage = (_e, fallback) => fallback;`;
    return null;
  },
};

let vite: ViteDevServer;
let C: { BaPaymentQueues: (p: { role: string }) => unknown; RunTransactionFinancials: (p: { transactionId: number; role: string }) => unknown };

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
        { find: /^react$/, replacement: "virtual:rf-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:rf-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:rf-query" },
      ],
    },
    plugins: [mocks],
  });
  C = (await vite.ssrLoadModule("/src/pages/runFinancial/containers.tsx")) as typeof C;
});
after(async () => {
  await vite?.close();
});

function render<P>(Comp: (p: P) => unknown, props: P) {
  g.__rfHooks.begin();
  g.__rfQueryCalls = [];
  return Comp(props);
}

// ---- synthetic data ----------------------------------------------------------
const recon = {
  status: "PARTIALLY_REFUNDED",
  asOf: "2026-10-26T00:00:00.000Z",
  entries: [
    { kind: "PAYMENT", effect: "CREDIT", receiptId: 1, receiptNumber: "RCPT-000101", amountCents: 110000, issuedAt: "2026-10-20T00:00:00.000Z" },
    { kind: "REFUND", effect: "DEBIT", receiptId: 2, receiptNumber: "RCPT-000102", amountCents: 10000, issuedAt: "2026-10-21T00:00:00.000Z" },
  ],
  totals: { itemisedServiceFeeCents: 110000, paidCents: 110000, refundedCents: 10000, netCollectedCents: 100000, balanceCents: 10000 },
  issues: [{ code: "RECEIPT_LEDGER_MISMATCH", paymentRequestId: 9 }],
};
const statement = {
  id: 10, transactionId: 5, version: 1, status: "ISSUED", supersedesId: null, supersedeReason: null, payerType: "Agent", currency: "AUD",
  creditsCents: 500000, debitsCents: 110000, netCents: 390000, pcServiceFeeCents: 110000, preparedAt: "2026-10-19T00:00:00.000Z",
  issuedAt: "2026-10-19T01:00:00.000Z", supersededAt: null,
  lines: [{ id: 1, lineNo: 1, kind: "PC_SERVICE_FEE", effect: "DEBIT", description: "AE Pit Crew service fee", amountCents: 100000, gstCents: 10000 }],
  reconciliation: recon,
};
// The server summary never carries these; they are injected here to prove the view cannot leak them even if it did.
const SECRETS = ["tok_SYNTH_SECRET_4242", "MANDATE-REF-SYNTH-77", "pcf-card-refund:1:abc", "mock-charge-ref-SYNTH", "evidence/signed/SYNTH.pdf"];
const fee = {
  serviceFee: {
    transactionId: 5, paymentRequestId: 9, status: "NOTICE_SENT", currency: "AUD", grossFeeCents: 100000, gstCents: 10000, totalFeeCents: 110000, capCents: null,
    noticeSentAt: null, noticeElapsesAt: "2026-10-30T00:00:00.000Z", scheduledAt: null, paidAt: null, paymentMethod: { type: "STORED_CARD", label: "Visa ending 4242" },
    collectionTiming: { rule: "NOTICE_PERIOD", noticeReason: "TERMS_UNVERSIONED" },
    authority: {
      id: 3, version: 2, status: "ACTIVE", payerType: "Agent", authorisedPaymentMethod: "STORED_CARD", feeBasis: "PERCENT_OF_GCI", rateBps: 150, fixedAmountCents: null,
      gstApplicable: true, maximumAmountCents: 500000, noticeRequiredDays: 7, agreementTermsVersion: null, mandateTermsVersion: null, effectiveDate: null, expiresAt: null,
      hasSignedEvidence: true, brokerageCardApproved: false,
      cardToken: SECRETS[0], mandateReference: SECRETS[1], idempotencyKey: SECRETS[2], providerChargeRef: SECRETS[3], signedEvidenceRef: SECRETS[4], paymentMethodId: 912345,
    },
  },
  collectable: false,
  settlementStatement: { issued: true },
};
const ok = (data: unknown) => ({ isLoading: false, isError: false, data, error: null });
const txQueries = (role: string) => ({
  [JSON.stringify(["run-statements", 5])]: ok({ statements: [statement] }),
  [JSON.stringify(["run-confirmations", 5])]: ok({ confirmations: [] }),
  [JSON.stringify(["run-service-fee", 5])]: ok(fee),
  [JSON.stringify(["run-receipts", 5])]: ok({ receipts: [] }),
  role,
});
const refund = (id: number, status: string) => ({ id, paymentRequestId: 9, cardChargeId: 4, amountCents: 5000, currency: "AUD", status, requestedByUserId: 1, failureMessage: null, createdAt: "2026-10-21T00:00:00.000Z", completedAt: null });

// ---- tests ---------------------------------------------------------------------
test("statement view with reconciliation, then the print flow: print view shows lines, payments/refunds, review issues and a close control", () => {
  reset(txQueries("Pit Crew"));
  let tree = render(C.RunTransactionFinancials, { transactionId: 5, role: "Pit Crew" });
  assert.ok(norm(tree).includes("RCPT-000102"), "reconciliation entries on screen");
  assert.match(norm(tree), /Partly refunded/);
  assert.match(norm(tree), /RECEIPT_LEDGER_MISMATCH/, "review issue shown on screen");
  assert.equal(findAll(tree, (e) => e.props?.["data-testid"] === "statement-print").length, 0, "no print view until asked");
  const print = button(tree, /Print \/ save as PDF/);
  assert.equal(print.length, 1);
  (print[0]!.props!.onClick as () => void)();
  tree = render(C.RunTransactionFinancials, { transactionId: 5, role: "Pit Crew" });
  const pv = findAll(tree, (e) => e.props?.["data-testid"] === "statement-print")[0];
  assert.ok(pv, "print view rendered");
  const t = norm(pv);
  for (const want of ["AE Pit Crew service fee", "Payments and refunds", "Partly refunded", "Balance $100.00", "RCPT-000101", "RCPT-000102", "Review:"]) assert.ok(t.includes(want), `print view has ${want}: ${t}`);
  assert.equal(button(pv, /Close print view/).length, 1);
  assert.equal(button(pv, /Collect|Resolve|Refund|Prepare|Issue/).length, 0, "print view carries no action controls");
  (button(pv, /Close print view/)[0]!.props!.onClick as () => void)();
  tree = render(C.RunTransactionFinancials, { transactionId: 5, role: "Pit Crew" });
  assert.equal(findAll(tree, (e) => e.props?.["data-testid"] === "statement-print").length, 0, "closed");
});

test("Pit Crew read-only authority summary: no card, mandate, provider or evidence references reach the screen, and no edit controls", () => {
  reset(txQueries("Pit Crew"));
  const tree = render(C.RunTransactionFinancials, { transactionId: 5, role: "Pit Crew" });
  const auth = findAll(tree, (e) => e.props?.["data-testid"] === "authority-view")[0];
  assert.ok(auth, "authority summary shown to Pit Crew");
  assert.match(norm(auth), /Read only/);
  const strings = allStrings(tree).join("\n");
  for (const s of SECRETS) assert.ok(!strings.includes(s), `leaked ${s}`);
  assert.ok(!strings.includes("912345"), "no payment method id");
  assert.equal(findAll(auth, (e) => e.type === "input" || e.type === "button" || e.type === "select").length, 0, "authority view has no controls");
  assert.equal(button(tree, /Revoke|Activate|Edit authority/i).length, 0);
});

test("BA queues: default filters are Unknown; the refund filter offers Pending; changing filters changes the query and the request path", async () => {
  reset({});
  let tree = render(C.BaPaymentQueues, { role: "Brokerage Administrator" });
  const keys = g.__rfQueryCalls.map((q: { key: string }) => q.key);
  assert.deepEqual(keys, [JSON.stringify(["run-card-charges", "UNKNOWN"]), JSON.stringify(["run-card-refunds", "UNKNOWN"]), JSON.stringify(["run-held-debits"])]);
  // S6: the held-debit list (BA only) reads the existing held endpoint.
  await g.__rfQueryCalls.find((q: { key: string }) => q.key.includes("run-held-debits")).queryFn();
  assert.equal(g.__rfApi.at(-1).path, "/financial/payment-outbox/held");
  const refundSelect = findAll(section(tree, "Card refunds"), (e) => e.type === "select")[0]!;
  const values = findAll(refundSelect, (e) => e.type === "option").map((o) => o.props!.value);
  assert.deepEqual(values, ["UNKNOWN", "PENDING", "SUCCEEDED", "FAILED", ""]);
  (refundSelect.props!.onChange as (e: unknown) => void)({ target: { value: "PENDING" } });
  tree = render(C.BaPaymentQueues, { role: "Brokerage Administrator" });
  const rq = g.__rfQueryCalls.find((q: { key: string }) => q.key.includes("run-card-refunds"));
  assert.equal(rq.key, JSON.stringify(["run-card-refunds", "PENDING"]));
  await rq.queryFn();
  assert.equal(g.__rfApi.at(-1).path, "/financial/card-refunds?status=PENDING");
  const sel2 = findAll(section(tree, "Card refunds"), (e) => e.type === "select")[0]!;
  (sel2.props!.onChange as (e: unknown) => void)({ target: { value: "" } });
  render(C.BaPaymentQueues, { role: "Brokerage Administrator" });
  await g.__rfQueryCalls.find((q: { key: string }) => q.key.includes("run-card-refunds")).queryFn();
  assert.equal(g.__rfApi.at(-1).path, "/financial/card-refunds", "All = no status filter");
  const chargeSelect = findAll(section(tree, "Card charges"), (e) => e.type === "select")[0]!;
  assert.ok(findAll(chargeSelect, (e) => e.type === "option").some((o) => o.props!.value === "UNKNOWN"));
});

test("BA queues are not rendered or fetched for Pit Crew, agents or sellers", () => {
  for (const role of ["Pit Crew", "Agent", "Seller"]) {
    reset({});
    const tree = render(C.BaPaymentQueues, { role });
    assert.equal(tree, null, role);
    assert.ok(g.__rfQueryCalls.every((q: { enabled: unknown }) => q.enabled === false), `${role}: queries disabled`);
  }
});

test("refund resolution form: status check first; reason >= 3 chars and evidence required; only the provider's outcome; requester blocked; posts trimmed body to the refund resolve route", async () => {
  const refunds = [refund(21, "PENDING"), refund(22, "UNKNOWN")];
  reset({ [JSON.stringify(["run-card-refunds", "UNKNOWN"])]: ok({ cardRefunds: refunds }), [JSON.stringify(["run-card-charges", "UNKNOWN"])]: ok({ cardCharges: [] }) });
  const R = () => render(C.BaPaymentQueues, { role: "Brokerage Administrator" });
  const rowOf = (t: unknown, id: number) => findAll(section(t, "Card refunds"), (e) => e.type === "li" && norm(e).startsWith(`Refund #${id}`))[0]!;
  const resolveBtns = (t: unknown, id: number) => button(rowOf(t, id), /^Resolve as/);
  const setField = (t: unknown, id: string, value: string) => {
    const input = findAll(t, (e) => e.type === "input" && e.props?.id === id)[0]!;
    (input.props!.onChange as (e: unknown) => void)({ target: { value } });
  };
  let tree = R();
  assert.ok(resolveBtns(tree, 22).every((b) => b.props!.disabled === true), "disabled before the status check");
  // Status check (server says the stalled PENDING refund was never refunded).
  g.__rfApiAnswer = (p: string) =>
    p.endsWith("/21/provider-status")
      ? { providerStatus: "NotFound", suggestedOutcome: "FAILED", callerMayResolve: true, resolvable: true }
      : { providerStatus: "Succeeded", suggestedOutcome: "SUCCEEDED", callerMayResolve: false, resolvable: true };
  for (const id of [21, 22]) (button(rowOf(tree, id), /Check provider status/)[0]!.props!.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 0));
  tree = R();
  assert.ok(g.__rfApi.some((c: { path: string }) => c.path === "/financial/card-refunds/21/provider-status"));
  assert.match(norm(rowOf(tree, 21)), /Pending with no recorded outcome/);
  assert.doesNotMatch(norm(section(tree, "Card refunds")), /15 minutes|stalled|wait/i);
  assert.ok(resolveBtns(tree, 21).every((b) => b.props!.disabled === true), "evidence still missing");
  setField(tree, "cardrefund-21-reason", "  ab  ");
  tree = R();
  setField(tree, "cardrefund-21-evidence", "Synthetic provider check");
  tree = R();
  assert.ok(resolveBtns(tree, 21).every((b) => b.props!.disabled === true), "reason under 3 chars after trimming");
  setField(tree, "cardrefund-21-reason", "  Synthetic stalled refund  ");
  tree = R();
  setField(tree, "cardrefund-21-evidence", "   ");
  tree = R();
  assert.ok(resolveBtns(tree, 21).every((b) => b.props!.disabled === true), "whitespace evidence");
  setField(tree, "cardrefund-21-evidence", " Synthetic provider check ");
  tree = R();
  const [asRefunded, asNot] = resolveBtns(tree, 21);
  assert.equal(norm(asRefunded), "Resolve as refunded");
  assert.equal(asRefunded!.props!.disabled, true, "outcome that contradicts the provider stays disabled");
  assert.equal(asNot!.props!.disabled, false);
  // Requester view: definite provider answer but callerMayResolve=false -> both disabled with the reason shown.
  assert.match(norm(rowOf(tree, 22)), /another Brokerage Administrator must resolve it/);
  setField(tree, "cardrefund-22-reason", "Synthetic reason");
  tree = R();
  setField(tree, "cardrefund-22-evidence", "Synthetic evidence");
  tree = R();
  assert.ok(resolveBtns(tree, 22).every((b) => b.props!.disabled === true), "requester can never resolve");
  g.__rfApi = [];
  (resolveBtns(tree, 21)[1]!.props!.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 0));
  const posted = g.__rfApi.find((c: { path: string }) => c.path === "/financial/card-refunds/21/resolve");
  assert.ok(posted, JSON.stringify(g.__rfApi));
  assert.equal(posted.init.method, "POST");
  assert.deepEqual(JSON.parse(posted.init.body), { outcome: "FAILED", reason: "Synthetic stalled refund", evidenceNote: "Synthetic provider check" });
});
