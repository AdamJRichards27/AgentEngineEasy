// Owner t181u phase 2b item 6: the payment authority covering the Pit Crew
// service fee is visible READ-ONLY to the assigned Pit Crew (and BAs) through
// the service fee view: status, payer, method type, fee terms, notice days and
// terms versions only. Never a mandate reference, signed-evidence reference
// or payment method id; Pit Crew cannot change an authority. Synthetic data.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { cleanupBrokerages } from "./testSupport.js";
import { activeDebitAuthority, call, cardAuthorityViaApi, confirmBoth, feeChain, makeWorld, MANDATE_REF_PREFIX, saveCard, TERMS, type World } from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "AuthView");
});

after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t181u phase 2b: read-only payment authority view", { concurrency: false }, () => {
  test("Pit Crew sees the authority summary on the service fee view, with no references", async () => {
    const dd = await activeDebitAuthority(w);
    const c = await feeChain(w, dd.id, "AuthViewDD");
    await confirmBoth(w, c);
    const v = await call(w.baseUrl, "GET", `/payments/pit-crew-service-fee/${c.transactionId}`, w.crew.cookie);
    assert.equal(v.status, 200, v.raw);
    const a = v.json.serviceFee.authority;
    assert.ok(a, v.raw);
    assert.equal(a.id, dd.id);
    assert.equal(a.status, "ACTIVE");
    assert.equal(a.payerType, "Agent");
    assert.equal(a.authorisedPaymentMethod, "GENERAL_ACCOUNT_DEBIT_MANDATE");
    assert.equal(typeof a.noticeRequiredDays, "number");
    assert.equal(a.hasSignedEvidence, true);
    for (const k of ["mandateProviderRef", "signedEvidenceRef", "paymentMethodId", "revokeReason"]) assert.ok(!(k in a), `no ${k}`);
    assert.ok(!v.raw.includes(MANDATE_REF_PREFIX), "no mandate reference anywhere");
  });

  test("card authority: terms versions and brokerage approval flag shown; Pit Crew cannot revoke or activate (403)", async () => {
    const card = await saveCard("Agent", w.X.agent.user.id);
    const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id, agreementTermsVersion: TERMS.agreementImmediate, mandateTermsVersion: TERMS.mandateImmediate });
    const c = await feeChain(w, a.id, "AuthViewCard");
    await confirmBoth(w, c);
    const v = await call(w.baseUrl, "GET", `/payments/pit-crew-service-fee/${c.transactionId}`, w.crew.cookie);
    assert.equal(v.status, 200, v.raw);
    const s = v.json.serviceFee.authority;
    assert.equal(s.authorisedPaymentMethod, "STORED_CARD");
    assert.equal(s.agreementTermsVersion, TERMS.agreementImmediate);
    assert.equal(s.mandateTermsVersion, TERMS.mandateImmediate);
    assert.equal(s.brokerageCardApproved, false);
    assert.ok(!v.raw.includes("t180u_tok_secret"));
    assert.equal((await call(w.baseUrl, "POST", `/financial/pc-fee-authorities/${a.id}/revoke`, w.crew.cookie, { reason: "synthetic" })).status, 403);
    assert.equal((await call(w.baseUrl, "POST", `/financial/pc-fee-authorities/${a.id}/activate`, w.crew.cookie, {})).status, 403);
    assert.equal((await call(w.baseUrl, "GET", `/financial/pc-fee-authorities/${a.id}`, w.crew.cookie)).status, 403, "the full authority record stays BA-only");
  });
});
