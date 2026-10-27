import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, gte, inArray, isNotNull, lt, or } from "drizzle-orm";
import { appraisalComparableSales, appraisals, db, properties } from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { restrictedPropertyIdsFor, visibleRequiredPropertySql } from "../lib/propertyVisibility.js";

// CC #26 / SPEC-02 — Market Activity from internal AE data only. Own
// brokerage only, read-only, no outbound network calls, no provider data,
// coordinates only on AE property records the caller may open (V5 map,
// Owner t525u item 4; never on public-form events or comparables). 404 unless GROW_MARKET_ACTIVITY_ENABLED=true. Events never
// assert seller intent and never earn Momentum points.

export const MARKET_ACTIVITY_FLAG_ENV = "GROW_MARKET_ACTIVITY_ENABLED";
export function isMarketActivityEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[MARKET_ACTIVITY_FLAG_ENV];
  return typeof raw === "string" && raw.toLowerCase() === "true";
}

export type MarketEventType = "justListed" | "sold" | "withdrawn" | "agentEvidence";
export const MARKET_EVENT_TYPES: MarketEventType[] = ["justListed", "sold", "withdrawn", "agentEvidence"];

// Owner t525u item 2 — privacy classification of every event type.
//   public market: justListed, sold. A listing going live and a completed sale
//     are public facts, so they stay brokerage-wide for any grow.access user.
//   private agent data: withdrawn (listing performance) and agentEvidence
//     (comparables an agent entered in a client appraisal).
// Callers scoped by restrictedPropertyIdsFor (Agents: own properties only;
// Brokerage Administrator and Pit Crew: whole brokerage) get private types only
// for properties they may see. A public event on a property they may not see is
// returned in public form: no propertyId, appraisalId, internal record date or
// id-bearing key, so no record link can be built from it.
export const PUBLIC_MARKET_EVENT_TYPES: readonly MarketEventType[] = ["justListed", "sold"];
export const PRIVATE_AGENT_EVENT_TYPES: readonly MarketEventType[] = ["withdrawn", "agentEvidence"];
export type MarketEventAccess = "record" | "public";
export const PUBLIC_EVENT_SOURCE_LABEL = "AE brokerage listing";
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
  /** "record": the caller may open the AE record. "public": public market fact only. */
  access: MarketEventAccess;
  /** WGS84 coordinates from the AE property record; null unless access is "record" on a property event. */
  lat: number | null;
  lng: number | null;
}

/**
 * Owner 28 Oct 2026 09:19 (V5 #274): other agents' public Just listed / Sold
 * events may be shown on the map as AREA pins carrying only the event type and
 * the suburb. Their exact coordinates never leave the server: one pin per
 * (suburb, event type), placed at the centre of the 0.02° grid cell
 * (about 2.2 km N-S x 2.0 km E-W at Brisbane's latitude) that contains the
 * centroid of the contributing properties. A pin therefore reveals only a
 * ~2 km cell, including when the suburb has a single property.
 */
export const AREA_PIN_GRID_DEGREES = 0.02;
export interface MarketAreaPin {
  key: string;
  type: MarketEventType;
  suburb: string;
  lat: number;
  lng: number;
}
export function snapToAreaGrid(v: number): number {
  return Number(((Math.floor(v / AREA_PIN_GRID_DEGREES) + 0.5) * AREA_PIN_GRID_DEGREES).toFixed(2));
}
export function buildAreaPins(points: readonly { type: MarketEventType; suburb: string | null; lat: number | null; lng: number | null }[]): MarketAreaPin[] {
  const groups = new Map<string, { type: MarketEventType; suburb: string; lat: number; lng: number; n: number }>();
  for (const p of points) {
    if (!PUBLIC_MARKET_EVENT_TYPES.includes(p.type) || p.lat == null || p.lng == null) continue;
    const suburb = p.suburb?.trim();
    if (!suburb) continue;
    const k = `${p.type}|${suburb.toLowerCase()}`;
    const g = groups.get(k) ?? { type: p.type, suburb, lat: 0, lng: 0, n: 0 };
    g.lat += p.lat; g.lng += p.lng; g.n += 1;
    groups.set(k, g);
  }
  return [...groups.values()]
    .sort((a, b) => a.suburb.localeCompare(b.suburb, "en-AU") || a.type.localeCompare(b.type))
    .map((g, i) => ({ key: `area-${i + 1}`, type: g.type, suburb: g.suburb, lat: snapToAreaGrid(g.lat / g.n), lng: snapToAreaGrid(g.lng / g.n) }));
}

/** Parse a stored numeric coordinate; null when missing, non-finite or out of range. */
export function parseCoordinate(v: string | number | null | undefined, max: number): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
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
    const restrictTo = await restrictedPropertyIdsFor(user);
    const mayOpen = (propertyId: number) => restrictTo === null || restrictTo.includes(propertyId);
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
    // Exact points of public-form events: server-side only, coarsened by buildAreaPins.
    const publicPoints: { type: MarketEventType; suburb: string | null; lat: number | null; lng: number | null }[] = [];
    const propertyRows = await db
      .select({
        id: properties.id,
        address: properties.formattedAddress,
        suburb: properties.suburb,
        listingStatus: properties.listingStatus,
        campaignStartDate: properties.campaignStartDate,
        campaignEndDate: properties.campaignEndDate,
        updatedAt: properties.updatedAt,
        latitude: properties.latitude,
        longitude: properties.longitude,
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
      const open = mayOpen(p.id);
      const lat = parseCoordinate(p.latitude, 90);
      const lng = parseCoordinate(p.longitude, 180);
      const hasCoords = lat != null && lng != null;
      const push = (type: MarketEventType, label: string, keyPrefix: string, at: Date) => {
        if (open) {
          events.push({ key: `${keyPrefix}-${p.id}`, type, label, sourceLabel: "AE property record", address: p.address, suburb: p.suburb, eventDate: at.toISOString(), recordDate: p.updatedAt.toISOString(), propertyId: p.id, appraisalId: null, access: "record", lat: hasCoords ? lat : null, lng: hasCoords ? lng : null });
        } else if (PUBLIC_MARKET_EVENT_TYPES.includes(type)) {
          // Public form: the key is assigned after sorting and never carries the property id.
          events.push({ key: "", type, label, sourceLabel: PUBLIC_EVENT_SOURCE_LABEL, address: p.address, suburb: p.suburb, eventDate: at.toISOString(), recordDate: at.toISOString(), propertyId: null, appraisalId: null, access: "public", lat: null, lng: null });
          if (hasCoords) publicPoints.push({ type, suburb: p.suburb, lat, lng });
        }
        // Private types on a property the caller may not see are dropped (not counted).
      };
      if (wanted.has("justListed") && p.listingStatus === "Listed" && within(p.campaignStartDate)) push("justListed", "Just listed", "listed", p.campaignStartDate);
      if (wanted.has("sold") && p.listingStatus === "Sold" && within(p.campaignEndDate)) push("sold", "Sold", "sold", p.campaignEndDate);
      if (wanted.has("withdrawn") && p.listingStatus === "Withdrawn" && within(p.campaignEndDate)) push("withdrawn", "Withdrawn", "withdrawn", p.campaignEndDate);
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
          // Private agent data: only appraisals on properties the caller may see.
          visibleRequiredPropertySql(appraisals.propertyId, restrictTo),
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
          access: "record",
          lat: null,
          lng: null,
        });
      }
    }

    events.sort((a, b) => b.eventDate.localeCompare(a.eventDate) || a.key.localeCompare(b.key) || a.address.localeCompare(b.address));
    let publicN = 0;
    for (const e of events) if (e.access === "public") e.key = `public-${++publicN}`;
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
      areaPins: buildAreaPins(publicPoints),
      providers: "none",
    });
  },
);
