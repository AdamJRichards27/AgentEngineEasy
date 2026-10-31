import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, gte, inArray, isNotNull, lt, or } from "drizzle-orm";
import { appraisalComparableSales, appraisals, db, properties } from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";

// CC #26 / SPEC-02 — Market Activity from internal AE data only. Own
// brokerage only, read-only, no outbound network calls, no provider data,
// no coordinates. 404 unless GROW_MARKET_ACTIVITY_ENABLED=true. Events never
// assert seller intent and never earn Momentum points.

export const MARKET_ACTIVITY_FLAG_ENV = "GROW_MARKET_ACTIVITY_ENABLED";
export function isMarketActivityEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[MARKET_ACTIVITY_FLAG_ENV];
  return typeof raw === "string" && raw.toLowerCase() === "true";
}

export type MarketEventType = "justListed" | "sold" | "withdrawn" | "agentEvidence";
export const MARKET_EVENT_TYPES: MarketEventType[] = ["justListed", "sold", "withdrawn", "agentEvidence"];
const EVENT_CAP = 100;

export interface MarketEvent {
  key: string;
  type: MarketEventType;
  label: string;
  /** "AE property record" or "Agent-entered comparable" — never presented as market-wide data. */
  sourceLabel: string;
  address: string;
  suburb: string | null;
  eventDate: string;
  recordDate: string;
  propertyId: number | null;
  appraisalId: number | null;
}

const querySchema = z.object({
  range: z.enum(["week", "lastweek", "30d"]).default("week"),
  suburbs: z.string().max(500).optional(),
  types: z.string().max(200).optional(),
  asOf: z.coerce.date().optional(),
});

export function resolveRange(range: "week" | "lastweek" | "30d", now: Date): { start: Date; end: Date } {
  const day = 86_400_000;
  if (range === "30d") return { start: new Date(now.getTime() - 30 * day), end: now };
  if (range === "week") return { start: new Date(now.getTime() - 7 * day), end: now };
  return { start: new Date(now.getTime() - 14 * day), end: new Date(now.getTime() - 7 * day) };
}

export const growMarketActivityRouter = Router();

growMarketActivityRouter.get(
  "/",
  (_req, res, next) => (isMarketActivityEnabled() ? next() : void res.status(404).json({ error: "Not found" })),
  requireAuth,
  requireEntitlement("grow.access"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    const user = req.authedUser!;
    const now = parsed.data.asOf ?? new Date();
    const { start, end } = resolveRange(parsed.data.range, now);
    const wanted = new Set<MarketEventType>(
      parsed.data.types
        ? parsed.data.types.split(",").map((t) => t.trim()).filter((t): t is MarketEventType => (MARKET_EVENT_TYPES as string[]).includes(t))
        : MARKET_EVENT_TYPES,
    );
    const suburbs = (parsed.data.suburbs ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const suburbOk = (s: string | null) => suburbs.length === 0 || (s != null && suburbs.includes(s.trim().toLowerCase()));

    const events: MarketEvent[] = [];
    const propertyRows = await db
      .select({
        id: properties.id,
        address: properties.formattedAddress,
        suburb: properties.suburb,
        listingStatus: properties.listingStatus,
        campaignStartDate: properties.campaignStartDate,
        campaignEndDate: properties.campaignEndDate,
        updatedAt: properties.updatedAt,
      })
      .from(properties)
      .where(and(
        eq(properties.brokerageId, user.brokerageId),
        or(
          and(isNotNull(properties.campaignStartDate), gte(properties.campaignStartDate, start), lt(properties.campaignStartDate, end)),
          and(isNotNull(properties.campaignEndDate), gte(properties.campaignEndDate, start), lt(properties.campaignEndDate, end)),
        ),
      ))
      .limit(500);
    const within = (d: Date | null): d is Date => !!d && d >= start && d < end;
    for (const p of propertyRows) {
      if (!suburbOk(p.suburb)) continue;
      const base = { sourceLabel: "AE property record", address: p.address, suburb: p.suburb, recordDate: p.updatedAt.toISOString(), propertyId: p.id, appraisalId: null };
      if (wanted.has("justListed") && p.listingStatus === "Listed" && within(p.campaignStartDate)) {
        events.push({ key: `listed-${p.id}`, type: "justListed", label: "Just listed", eventDate: p.campaignStartDate.toISOString(), ...base });
      }
      if (wanted.has("sold") && p.listingStatus === "Sold" && within(p.campaignEndDate)) {
        events.push({ key: `sold-${p.id}`, type: "sold", label: "Sold", eventDate: p.campaignEndDate.toISOString(), ...base });
      }
      if (wanted.has("withdrawn") && p.listingStatus === "Withdrawn" && within(p.campaignEndDate)) {
        events.push({ key: `withdrawn-${p.id}`, type: "withdrawn", label: "Withdrawn", eventDate: p.campaignEndDate.toISOString(), ...base });
      }
    }

    if (wanted.has("agentEvidence")) {
      const comps = await db
        .select({
          id: appraisalComparableSales.id,
          address: appraisalComparableSales.address,
          saleDate: appraisalComparableSales.saleDate,
          createdAt: appraisalComparableSales.createdAt,
          appraisalId: appraisalComparableSales.appraisalId,
          suburb: properties.suburb,
        })
        .from(appraisalComparableSales)
        .innerJoin(appraisals, eq(appraisals.id, appraisalComparableSales.appraisalId))
        .innerJoin(properties, eq(properties.id, appraisals.propertyId))
        .where(and(
          eq(appraisals.brokerageId, user.brokerageId),
          eq(properties.brokerageId, user.brokerageId),
          inArray(appraisalComparableSales.source, ["manual"]),
          gte(appraisalComparableSales.createdAt, start),
          lt(appraisalComparableSales.createdAt, end),
        ))
        .orderBy(desc(appraisalComparableSales.createdAt))
        .limit(EVENT_CAP);
      for (const c of comps) {
        if (!suburbOk(c.suburb)) continue;
        events.push({
          key: `comp-${c.id}`,
          type: "agentEvidence",
          label: "Nearby sold (agent-entered)",
          sourceLabel: "Agent-entered comparable",
          address: c.address,
          suburb: c.suburb,
          eventDate: (c.saleDate ?? c.createdAt).toISOString(),
          recordDate: c.createdAt.toISOString(),
          propertyId: null,
          appraisalId: c.appraisalId,
        });
      }
    }

    events.sort((a, b) => b.eventDate.localeCompare(a.eventDate) || a.key.localeCompare(b.key));
    const counts = { justListed: 0, sold: 0, withdrawn: 0, agentEvidence: 0 };
    for (const e of events) counts[e.type]++;
    res.json({
      asOf: now.toISOString(),
      range: parsed.data.range,
      start: start.toISOString(),
      end: end.toISOString(),
      counts,
      events: events.slice(0, EVENT_CAP),
      truncated: events.length > EVENT_CAP,
      providers: "none",
    });
  },
);
