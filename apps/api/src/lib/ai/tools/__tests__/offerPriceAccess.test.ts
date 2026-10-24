// Owner t171u (5) / t165u: AI Assistant offer-price access, enforced inside
// the tool execution path. Database-backed on purpose: the decision reads
// properties.agent_id and the caller's users row, so a hand-built context
// alone could not prove the rule. Synthetic data only.
//
//   listing agent, Brokerage Administrator -> full offer prices
//   Pit Crew                               -> prices omitted + withheld marker
//   other Agent in the brokerage           -> nothing (own-property rule, same
//                                             404 as GET /properties/:id)
//   another brokerage                      -> nothing about the property
//   no run.access (Grow-only brokerage)    -> no offer data, even for the
//                                             listing agent and Brokerage Admin
//   unknown / missing / inconsistent caller -> fail closed (nothing)
//
// Also proves the prompt actually sent to the model and the ai_interactions
// audit rows carry no price for a redacted caller.
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { db, aiInteractions, aiUsage, brokerages, domainEvents, entitlementGrants, offers, properties, transactions, users } from "@aee/db";
import { TOOL_REGISTRY, redactTimelineForAi, runAllTools } from "../registry.js";
import {
  AI_PRICE_WITHHELD_INLINE,
  AI_PRICE_WITHHELD_MARKER,
  canSeeOfferPricesForAi,
  containsPriceKey,
  resolveAiOfferPriceAccess,
  scrubDollarFigures,
} from "../offerPriceAccess.js";
import { buildContext } from "../../context/contextEngine.js";
import { askCopilot } from "../../orchestrator.js";
import { setAiGatewayProviderForTests } from "../../gateway.js";
import type { AiContextPackage, AiProviderRequest, AiToolResult } from "../../types.js";
import type { TimelineItem } from "../../../timeline.js";

const PRICE_A = 87_654_300; // $876543.00
const PRICE_B = 91_234_500; // $912345.00
const COMMISSION = 2_345_600; // $23456.00
// Every rendering a price could take in a tool result or a prompt.
const PRICE_NEEDLES = ["87654300", "876543", "876,543", "91234500", "912345", "912,345"];
const COMMISSION_NEEDLES = ["2345600", "23456"];

function assertNoPrice(text: string, label: string): void {
  for (const needle of PRICE_NEEDLES) assert.equal(text.includes(needle), false, `${label}: must not contain ${needle}`);
}

const tag = randomUUID().slice(0, 8);
let brokerageA = 0;
let brokerageB = 0;
let brokerageG = 0; // Grow-only: grow.access, no run.access
const ids = { admin: 0, listingAgent: 0, otherAgent: 0, pitCrew: 0, inactiveAdmin: 0, adminB: 0, agentB: 0, adminG: 0, agentG: 0 };
const roles: Record<keyof typeof ids, string> = {
  admin: "Brokerage Administrator",
  listingAgent: "Agent",
  otherAgent: "Agent",
  pitCrew: "Pit Crew",
  inactiveAdmin: "Brokerage Administrator",
  adminB: "Brokerage Administrator",
  agentB: "Agent",
  adminG: "Brokerage Administrator",
  agentG: "Agent",
};
function brokerageOf(who: keyof typeof ids): number {
  if (who === "adminB" || who === "agentB") return brokerageB;
  if (who === "adminG" || who === "agentG") return brokerageG;
  return brokerageA;
}
let propertyId = 0;
let propertyB = 0;
let propertyG = 0;

async function ctxFor(
  who: keyof typeof ids,
  contextId = propertyId,
  contextType: "property" | "transaction" = "property",
): Promise<AiContextPackage> {
  return buildContext({
    requestId: randomUUID(),
    brokerageId: brokerageOf(who),
    userId: ids[who],
    userRole: roles[who],
    role: "copilot",
    contextType,
    contextId,
    growFocusItemId: null,
  });
}

function toolNamed(name: string) {
  const tool = TOOL_REGISTRY.find((t) => t.name === name);
  assert.ok(tool, name);
  return tool;
}

function byTool(results: AiToolResult[], name: string): AiToolResult {
  const r = results.find((x) => x.tool === name);
  assert.ok(r, name);
  return r;
}

before(async () => {
  const [a] = await db.insert(brokerages).values({ name: `AI price A ${tag}` }).returning();
  const [b] = await db.insert(brokerages).values({ name: `AI price B ${tag}` }).returning();
  const [g] = await db.insert(brokerages).values({ name: `AI price G ${tag}` }).returning();
  brokerageA = a!.id;
  brokerageB = b!.id;
  brokerageG = g!.id;
  const grant = (brokerageId: number, entitlementKey: string) => ({
    brokerageId,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "migration",
    status: "Active",
  });
  await db
    .insert(entitlementGrants)
    .values([grant(brokerageA, "run.access"), grant(brokerageB, "run.access"), grant(brokerageG, "grow.access")]);
  for (const key of Object.keys(ids) as Array<keyof typeof ids>) {
    const [u] = await db
      .insert(users)
      .values({
        authProviderId: `ai-price-${key}-${tag}`,
        email: `ai-price-${key}-${tag}@example.test`,
        firstName: "Synthetic",
        lastName: key,
        role: roles[key],
        brokerageId: brokerageOf(key),
        isActive: key !== "inactiveAdmin",
      })
      .returning();
    ids[key] = u!.id;
  }
  const [p] = await db
    .insert(properties)
    .values({ brokerageId: brokerageA, agentId: ids.listingAgent, formattedAddress: `1 Synthetic Offer St ${tag}`, workflowStage: "Under Offer" })
    .returning();
  propertyId = p!.id;
  const [pb] = await db
    .insert(properties)
    .values({ brokerageId: brokerageB, agentId: ids.agentB, formattedAddress: `2 Synthetic Other St ${tag}` })
    .returning();
  propertyB = pb!.id;
  const [pg] = await db
    .insert(properties)
    .values({ brokerageId: brokerageG, agentId: ids.agentG, formattedAddress: `3 Synthetic Grow St ${tag}`, workflowStage: "Under Offer" })
    .returning();
  propertyG = pg!.id;
  await db.insert(offers).values({ propertyId: propertyG, offerPriceCents: PRICE_A, status: "Received", shareToken: `ai-price-g-${tag}` });
  await db.insert(domainEvents).values({
    propertyId: propertyG,
    brokerageId: brokerageG,
    agentId: ids.agentG,
    actorType: "USER",
    actorId: ids.agentG,
    source: "test:ai-price",
    eventType: "OFFER_RECEIVED",
    occurredAt: new Date("2026-10-01T00:00:00Z"),
    correlationId: randomUUID(),
    payload: { offerId: 3, offerPriceCents: PRICE_A },
  });
  await db.insert(transactions).values({ propertyId, sellerPartyIds: [], buyerPartyIds: [], purchasePriceCents: PRICE_A });
  await db.insert(offers).values([
    { propertyId, offerPriceCents: PRICE_A, status: "Accepted", shareToken: `ai-price-a-${tag}` },
    { propertyId, offerPriceCents: PRICE_B, status: "Declined", shareToken: `ai-price-b-${tag}` },
  ]);
  const base = { propertyId, brokerageId: brokerageA, agentId: ids.listingAgent, actorType: "USER", actorId: ids.listingAgent, source: "test:ai-price" };
  await db.insert(domainEvents).values([
    { ...base, eventType: "OFFER_RECEIVED", occurredAt: new Date("2026-10-01T00:00:00Z"), correlationId: randomUUID(), payload: { offerId: 1, offerPriceCents: PRICE_B } },
    { ...base, eventType: "OFFER_ACCEPTED", occurredAt: new Date("2026-10-02T00:00:00Z"), correlationId: randomUUID(), payload: { offerId: 2, purchasePriceCents: PRICE_A } },
    { ...base, eventType: "COMMISSION_CALCULATED", occurredAt: new Date("2026-10-03T00:00:00Z"), correlationId: randomUUID(), payload: { grossCommissionCents: COMMISSION, gstCents: 234_560 } },
    { ...base, eventType: "SETTLEMENT_SCHEDULED", occurredAt: new Date("2026-10-04T00:00:00Z"), correlationId: randomUUID(), payload: { settlementDate: "2026-11-30", depositCents: 8_765_430 } },
  ]);
});

after(async () => {
  const brokerageIds = [brokerageA, brokerageB, brokerageG].filter((id) => id > 0);
  if (brokerageIds.length === 0) return;
  const rows = await db.select({ id: aiInteractions.id }).from(aiInteractions).where(inArray(aiInteractions.brokerageId, brokerageIds));
  if (rows.length > 0) await db.delete(aiUsage).where(inArray(aiUsage.interactionId, rows.map((r) => r.id)));
  await db.delete(aiInteractions).where(inArray(aiInteractions.brokerageId, brokerageIds));
  await db.delete(domainEvents).where(inArray(domainEvents.brokerageId, brokerageIds));
  await db.delete(transactions).where(inArray(transactions.propertyId, [propertyId, propertyB, propertyG].filter((id) => id > 0)));
  await db.delete(offers).where(inArray(offers.propertyId, [propertyId, propertyB, propertyG].filter((id) => id > 0)));
  await db.delete(entitlementGrants).where(inArray(entitlementGrants.brokerageId, brokerageIds));
  await db.delete(properties).where(inArray(properties.brokerageId, brokerageIds));
  await db.delete(users).where(inArray(users.brokerageId, brokerageIds));
  await db.delete(brokerages).where(inArray(brokerages.id, brokerageIds));
});

describe("AI tools: offer price access (Owner t165u / t171u)", { concurrency: false }, () => {
  test("pure rule matches #271 canSeeOfferTerms", () => {
    assert.equal(canSeeOfferPricesForAi("Brokerage Administrator", 5, 9), true);
    assert.equal(canSeeOfferPricesForAi("Agent", 9, 9), true);
    assert.equal(canSeeOfferPricesForAi("Agent", 5, 9), false);
    assert.equal(canSeeOfferPricesForAi("Agent", 9, null), false);
    assert.equal(canSeeOfferPricesForAi("Pit Crew", 9, 9), false);
    assert.equal(canSeeOfferPricesForAi("Owner", 9, 9), false);
    assert.equal(canSeeOfferPricesForAi("", 9, 9), false);
    assert.equal(scrubDollarFigures("Offer received from Sam ($876543.00)"), `Offer received from Sam (${AI_PRICE_WITHHELD_INLINE})`);
    assert.equal(containsPriceKey({ a: { purchasePriceCents: 1 } }), true);
    assert.equal(containsPriceKey({ updatedValue: '{"depositCents":1}' }), true);
    assert.equal(containsPriceKey({ settlementDate: "2026-11-30" }), false);
  });

  for (const who of ["listingAgent", "admin"] as const) {
    test(`${who}: full offer prices from get_offers_for_property and the timeline`, async () => {
      const ctx = await ctxFor(who);
      assert.ok(ctx.property, "property in context");
      const offersResult = await toolNamed("get_offers_for_property").run(ctx, {});
      assert.equal(offersResult.ok, true);
      const rows = offersResult.data as Array<Record<string, unknown>>;
      assert.deepEqual(rows.map((r) => r.offerPriceCents).sort(), [PRICE_A, PRICE_B].sort());
      assert.ok(rows.every((r) => r.offerTermsVisible === true));
      const timeline = await toolNamed("get_property_timeline").run(ctx, {});
      assert.equal(timeline.ok, true);
      const text = JSON.stringify(timeline.data);
      assert.ok(text.includes("$912345.00"), "offer received price in label");
      assert.ok(text.includes("$876543.00"), "accepted price in label");
      assert.equal(text.includes(AI_PRICE_WITHHELD_MARKER), false);
      // #131/#134 unchanged: commission stays Brokerage-Administrator-only.
      const commissionVisible = COMMISSION_NEEDLES.some((n) => text.includes(n));
      assert.equal(commissionVisible, who === "admin", "commission only for Brokerage Administrator");
    });
  }

  test("otherAgent (not the listing agent): no property context, and a forged context gets no offers or timeline", async () => {
    const ctx = await ctxFor("otherAgent");
    assert.equal(ctx.property, null, "own-property rule, same as GET /properties/:id");
    assertNoPrice(JSON.stringify(await runAllTools(ctx)), "otherAgent via buildContext");
    const forged: AiContextPackage = { ...ctx, property: { id: propertyId, address: "forged", workflowStage: "Under Offer" } };
    assert.equal((await resolveAiOfferPriceAccess(forged, propertyId)).kind, "denied");
    for (const name of ["get_offers_for_property", "get_property_timeline"]) {
      const r = await toolNamed(name).run(forged, {});
      assert.equal(r.ok, false, name);
      assert.equal(r.data, undefined);
    }
    assertNoPrice(JSON.stringify(await runAllTools(forged)), "otherAgent forged");
  });

  test("transaction context is pinned to id, propertyId and status (no purchase price)", async () => {
    for (const who of ["listingAgent", "admin", "pitCrew"] as const) {
      const ctx = await ctxFor(who, propertyId, "transaction");
      assert.ok(ctx.transaction, `${who}: transaction in context`);
      assert.deepEqual(Object.keys(ctx.transaction).sort(), ["id", "propertyId", "status"], who);
      assertNoPrice(JSON.stringify(ctx), `${who} transaction context`);
      assertNoPrice(JSON.stringify(await runAllTools(ctx)), `${who} transaction tools`);
    }
    const hidden = await ctxFor("otherAgent", propertyId, "transaction");
    assert.equal(hidden.transaction, null, "own-property rule applies to transaction context too");
    const foreign = await ctxFor("adminB", propertyId, "transaction");
    assert.equal(foreign.transaction, null);
  });

  for (const who of ["pitCrew"] as const) {
    test(`${who}: offers keep status, price omitted with a withheld marker; timeline scrubbed`, async () => {
      const ctx = await ctxFor(who);
      assert.ok(ctx.property, "same-brokerage property still in context");
      const offersResult = await toolNamed("get_offers_for_property").run(ctx, {});
      assert.equal(offersResult.ok, true);
      const rows = offersResult.data as Array<Record<string, unknown>>;
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal("offerPriceCents" in row, false, "no offerPriceCents key");
        assert.equal(row.offerTermsVisible, false);
        assert.equal(row.offerPrice, AI_PRICE_WITHHELD_MARKER);
        assert.equal(typeof row.status, "string");
      }
      const timeline = await toolNamed("get_property_timeline").run(ctx, {});
      assert.equal(timeline.ok, true);
      const items = timeline.data as Array<TimelineItem & { priceWithheld?: string }>;
      const offerItems = items.filter((i) => i.category === "Offer");
      assert.equal(offerItems.length, 2);
      for (const item of offerItems) {
        assert.equal(item.detail, undefined, "payload dropped");
        assert.equal(item.priceWithheld, AI_PRICE_WITHHELD_MARKER);
        assert.ok(item.label.includes(AI_PRICE_WITHHELD_INLINE), item.label);
      }
      const all = JSON.stringify(await runAllTools(ctx));
      assertNoPrice(all, `${who} all tools`);
      for (const n of [...COMMISSION_NEEDLES, "8765430"]) assert.equal(all.includes(n), false, `${who}: no ${n}`);
    });
  }

  test("cross-brokerage: the context engine drops the property, and a forged context gets nothing", async () => {
    const ctx = await ctxFor("adminB");
    assert.equal(ctx.property, null);
    assertNoPrice(JSON.stringify(await runAllTools(ctx)), "adminB via buildContext");
    const forged: AiContextPackage = { ...ctx, property: { id: propertyId, address: "forged", workflowStage: "Under Offer" } };
    for (const name of ["get_offers_for_property", "get_property_timeline"]) {
      const r = await toolNamed(name).run(forged, {});
      assert.equal(r.ok, false, name);
      assert.equal(r.data, undefined);
      assertNoPrice(JSON.stringify(r), `forged ${name}`);
    }
  });

  for (const who of ["agentG", "adminG"] as const) {
    test(`${who} (Grow-only, no run.access): no offer data from any AI tool, even on their own listing`, async () => {
      const ctx = await ctxFor(who, propertyG);
      assert.ok(ctx.property, "own-brokerage property in context");
      assert.equal((await resolveAiOfferPriceAccess(ctx, propertyG)).kind, "no_run_access");
      const offersResult = await toolNamed("get_offers_for_property").run(ctx, {});
      assert.equal(offersResult.ok, false);
      assert.equal(offersResult.data, undefined);
      const timeline = await toolNamed("get_property_timeline").run(ctx, {});
      assert.equal(timeline.ok, true);
      const items = timeline.data as TimelineItem[];
      assert.equal(items.filter((i) => i.category === "Offer").length, 0, "offer entries dropped");
      const all = JSON.stringify(await runAllTools(ctx));
      assertNoPrice(all, `${who} all tools`);
      assert.equal(/offer received/i.test(all), false, `${who}: no offer entry text`);
    });
  }

  test("fail closed: missing, inactive, mismatched or unknown caller and missing property", async () => {
    const good = await ctxFor("listingAgent");
    const cases: Array<[string, AiContextPackage]> = [
      ["role missing", { ...good, userRole: "" }],
      ["role claimed higher than the database", { ...good, userRole: "Brokerage Administrator" }],
      ["unknown user id", { ...good, userId: 2_000_000_000 }],
      ["user id zero", { ...good, userId: 0 }],
      ["brokerage mismatch", { ...good, brokerageId: brokerageB }],
      ["brokerage missing", { ...good, brokerageId: Number.NaN }],
    ];
    const inactive = await ctxFor("admin");
    cases.push(["inactive Brokerage Administrator", { ...inactive, userId: ids.inactiveAdmin }]);
    for (const [label, ctx] of cases) {
      const access = await resolveAiOfferPriceAccess(ctx, propertyId);
      assert.equal(access.kind, "denied", label);
      for (const name of ["get_offers_for_property", "get_property_timeline"]) {
        const r = await toolNamed(name).run(ctx, {});
        assert.equal(r.ok, false, `${label}: ${name}`);
        assertNoPrice(JSON.stringify(r), `${label}: ${name}`);
      }
    }
    assert.equal((await resolveAiOfferPriceAccess(good, null)).kind, "denied");
    assert.equal((await resolveAiOfferPriceAccess(good, 2_000_000_000)).kind, "denied");
    // A role the rule does not name, consistent in context and database:
    // own-property scoped like an Agent, so hidden unless it is the listing
    // agent, and never full even then (the listing-agent rule names Agent).
    await db.update(users).set({ role: "Conveyancer" }).where(eq(users.id, ids.otherAgent));
    try {
      const odd = { ...(await ctxFor("otherAgent")), userRole: "Conveyancer" };
      assert.equal((await resolveAiOfferPriceAccess(odd, propertyId)).kind, "denied");
      assertNoPrice(JSON.stringify(await runAllTools(odd)), "unnamed role");
    } finally {
      await db.update(users).set({ role: "Agent" }).where(eq(users.id, ids.otherAgent));
    }
  });

  test("redactTimelineForAi drops price-keyed detail even outside Offer/Transaction", () => {
    const item = (over: Partial<TimelineItem>): TimelineItem => ({
      id: "x",
      propertyId: 1,
      entryType: "X",
      category: "Property",
      occurredAt: "2026-10-01T00:00:00.000Z",
      actor: null,
      label: "Something",
      sensitivity: "STANDARD",
      refs: [],
      source: "audit_log",
      ...over,
    });
    const [plain, keyed, offer] = redactTimelineForAi([
      item({ detail: { note: "ok" } }),
      item({ detail: { updatedValue: '{"purchasePriceCents":87654300}' } }),
      item({ category: "Offer", label: "Offer received ($876543.00)", detail: { offerPriceCents: PRICE_A } }),
    ]);
    assert.deepEqual(plain!.detail, { note: "ok" });
    assert.equal(keyed!.detail, undefined);
    assert.equal(offer!.detail, undefined);
    assertNoPrice(JSON.stringify([keyed, offer]), "redacted items");
  });

  test("askCopilot: prompt sent to the model and ai_interactions rows carry no price for redacted callers", async () => {
    const prompts: Record<string, string> = {};
    let current = "";
    setAiGatewayProviderForTests(() => ({
      name: "mock",
      async generate(request: AiProviderRequest) {
        prompts[current] = request.userPrompt;
        return { provider: "mock", model: "mock-v1", text: "ok", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCostUsd: 0 }, latencyMs: 1 };
      },
    }));
    try {
      for (const who of ["listingAgent", "otherAgent", "pitCrew"] as const) {
        current = who;
        const result = await askCopilot({
          brokerageId: brokerageA,
          userId: ids[who],
          userRole: roles[who],
          question: "What offers are on this property?",
          contextType: "property",
          contextId: propertyId,
        });
        assertNoPrice(JSON.stringify(result), `${who} response`);
      }
    } finally {
      setAiGatewayProviderForTests(null);
    }
    assert.ok(prompts.listingAgent?.includes(String(PRICE_A)), "listing agent prompt carries the price");
    for (const who of ["otherAgent", "pitCrew"]) {
      assert.ok(prompts[who], `${who} prompt captured`);
      assertNoPrice(prompts[who]!, `${who} prompt`);
    }
    assert.ok(prompts.pitCrew!.includes("WITHHELD"), "Pit Crew prompt carries the withheld marker");
    assert.equal(prompts.otherAgent!.includes("Synthetic Offer St"), false, "colleague's listing not in the other agent's prompt");
    const rows = await db.select().from(aiInteractions).where(eq(aiInteractions.brokerageId, brokerageA));
    assert.ok(rows.length >= 3);
    assertNoPrice(JSON.stringify(rows), "ai_interactions rows");
  });
});
