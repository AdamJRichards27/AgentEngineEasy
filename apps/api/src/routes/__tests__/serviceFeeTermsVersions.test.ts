// Owner t183u items 4-5 / #245 S4: immediate collection only when BOTH the
// EXECUTED agreement AND the payment mandate expressly authorise collection on
// issue of the final settlement statement; executed = signed acceptance
// evidence + an effective date. Terms version identifiers are immutable; any
// change to terms is a new, independently approved authority, never an edit.
// Existing authorities keep their agreed notice periods. Synthetic data, mock
// providers only.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { db, financialPaymentOutbox, pcFeeAuthorities } from "@aee/db";
import { collectionTimingFor } from "../../lib/financial/pcFeeTerms.js";
import { createPcFeeAuthority } from "../../lib/financial/pcFeeAuthorities.js";
import { cleanupBrokerages, forceAuthorityFixture } from "./testSupport.js";
import { activeDebitAuthority, call, confirmBoth, feeChain, makeWorld, prepareAndIssue, TERMS, type Chain, type World } from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = join(here, "..", "..");
const IMMEDIATE = { agreementTermsVersion: TERMS.agreementImmediate, mandateTermsVersion: TERMS.mandateImmediate };
const EXECUTED = { signedEvidenceRef: "synthetic-signed-acceptance", effectiveDate: new Date(Date.now() - 86_400_000) };
let server: Server;
let w: World;
const outbox = (c: Chain) => db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, c.requestId));
async function issued(authorityId: number, tag: string) {
  const c = await feeChain(w, authorityId, tag);
  await confirmBoth(w, c);
  const iss = await prepareAndIssue(w, w.crew, c);
  assert.equal(iss.status, 200, iss.raw);
  return { c, collection: iss.json.collection };
}
function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "__tests__" ? [] : srcFiles(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}
const t = (over: Record<string, unknown>) =>
  collectionTimingFor({ ...IMMEDIATE, ...EXECUTED, ...over } as Parameters<typeof collectionTimingFor>[0]);

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "TermsVer");
});
after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("S4 (t183u 4-5): executed terms gate immediate collection; versions immutable", { concurrency: false }, () => {
  test("rule: immediate needs both permitting versions AND signed acceptance evidence AND an effective date", () => {
    assert.equal(t({}).rule, "IMMEDIATE_ON_STATEMENT_ISSUE");
    for (const [label, over] of [
      ["no evidence", { signedEvidenceRef: null }],
      ["blank evidence", { signedEvidenceRef: "   " }],
      ["no effective date", { effectiveDate: null }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = t(over);
      assert.equal(r.rule, "NOTICE_PERIOD", label);
      assert.equal(r.noticeReason, "TERMS_ACCEPTANCE_UNEVIDENCED", label);
    }
    assert.equal(t({ mandateTermsVersion: TERMS.mandateNotice }).noticeReason, "MANDATE_TERMS_REQUIRE_NOTICE");
    assert.equal(t({ agreementTermsVersion: null, mandateTermsVersion: null }).rule, "NOTICE_PERIOD", "existing authorities keep notice");
  });

  test("an immediate-terms authority without signed acceptance evidence cannot be drafted (422)", async () => {
    await assert.rejects(
      createPcFeeAuthority({ brokerageId: w.X.brokerageId, agentUserId: w.X.agent.user.id, feeBasis: "PERCENTAGE_OF_GCI", rateBps: 690, createdByUserId: w.X.admin.user.id, ...IMMEDIATE }),
      (e: Error & { reason?: string }) => e.reason === "TERMS_ACCEPTANCE_EVIDENCE_REQUIRED",
    );
    const r = await call(w.baseUrl, "POST", "/financial/pc-fee-authorities", w.X.admin.cookie, { agentUserId: w.X.agent.user.id, rateBps: 690, ...IMMEDIATE, signedEvidenceRef: " " });
    assert.equal(r.status, 422, r.raw);
    assert.equal(r.json.reason, "TERMS_ACCEPTANCE_EVIDENCE_REQUIRED");
  });

  test("defence in depth: a legacy row with immediate versions but no evidence keeps the notice period on issue", async () => {
    const a = await activeDebitAuthority(w, { ...IMMEDIATE });
    await forceAuthorityFixture(a.id, { signedEvidenceRef: null }); // simulates a pre-S4 row
    const { c, collection } = await issued(a.id, "NoEvidence");
    assert.equal(collection.outcome, "notice_started", JSON.stringify(collection));
    assert.equal((await outbox(c)).length, 0, "nothing collected on issue");
  });

  test("executed immediate terms still collect on issue; existing notice authorities keep their notice period", async () => {
    const imm = await activeDebitAuthority(w, { ...IMMEDIATE });
    const r1 = await issued(imm.id, "Executed");
    assert.ok(["debit_scheduled", "debit_queued"].includes(r1.collection.outcome), JSON.stringify(r1.collection));
    const legacy = await activeDebitAuthority(w);
    const r2 = await issued(legacy.id, "LegacyNotice");
    assert.equal(r2.collection.outcome, "notice_started");
  });

  test("no edit in place: there is no PATCH/PUT route for an authority", async () => {
    const a = await activeDebitAuthority(w, { ...IMMEDIATE });
    for (const method of ["PATCH", "PUT"] as const) {
      const r = await call(w.baseUrl, method, `/financial/pc-fee-authorities/${a.id}`, w.X.admin.cookie, { mandateTermsVersion: TERMS.mandateNotice, noticeRequiredDays: 0 });
      assert.equal(r.status, 404, `${method}: ${r.raw}`);
    }
    const [row] = await db.select().from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, a.id));
    assert.equal(row!.mandateTermsVersion, TERMS.mandateImmediate);
  });

  test("a terms change is a new authority: drafter cannot approve it; once approved the old row's terms are untouched (REPLACED)", async () => {
    const v1 = await activeDebitAuthority(w, { agreementTermsVersion: TERMS.agreementNotice, mandateTermsVersion: TERMS.mandateNotice });
    const [before] = await db.select().from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, v1.id));
    const draft = await call(w.baseUrl, "POST", "/financial/pc-fee-authorities", w.X.admin.cookie, { agentUserId: w.X.agent.user.id, rateBps: 690, ...IMMEDIATE, signedEvidenceRef: "synthetic-v2" });
    assert.equal(draft.status, 201, draft.raw);
    const v2 = draft.json.authority.id as number;
    const self = await call(w.baseUrl, "POST", `/financial/pc-fee-authorities/${v2}/activate`, w.X.admin.cookie, { mandateProviderRef: `mock-v2-${v2}`, mandateProvider: "sandbox" });
    assert.equal(self.status, 403, `drafter cannot approve: ${self.raw}`);
    const ok = await call(w.baseUrl, "POST", `/financial/pc-fee-authorities/${v2}/activate`, w.admin2.cookie, { mandateProviderRef: `mock-v2-${v2}`, mandateProvider: "sandbox" });
    assert.equal(ok.status, 200, ok.raw);
    const [after] = await db.select().from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, v1.id));
    assert.equal(after!.status, "REPLACED");
    for (const k of ["agreementTermsVersion", "mandateTermsVersion", "signedEvidenceRef", "effectiveDate", "noticeRequiredDays", "rateBps", "version"] as const) {
      assert.deepEqual(after![k], before![k], `v1 ${k} unchanged`);
    }
    const [v2row] = await db.select().from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, v2));
    assert.ok(v2row!.version > before!.version);
    assert.ok(v2row!.effectiveDate, "approval stamps an effective date");
  });

  test("static: no production code ever writes terms/evidence/notice fields in an UPDATE of pc_fee_authorities", () => {
    const immutable = /\b(agreementTermsVersion|mandateTermsVersion|signedEvidenceRef|noticeRequiredDays|rateBps|feeBasis|fixedAmountCents|maximumAmountCents|version)\s*:/;
    const offenders: string[] = [];
    for (const f of srcFiles(apiSrc)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\.update\(pcFeeAuthorities\)([\s\S]*?)\.where\(/g)) if (immutable.test(m[1]!)) offenders.push(f.slice(apiSrc.length));
    }
    assert.deepEqual(offenders, []);
  });
});
