import { Router } from "express";
import { z } from "zod";
import { and, eq, gte, lt, or } from "drizzle-orm";
import { appraisals, db, growActivities, growOpportunities } from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { requireMinimalUxAllowlisted } from "../middlewares/minimalUxAllowlistGate.js";
import {
  MOMENTUM_RULES_V1,
  isMomentumEnabled,
  monthStart,
  nextMilestone,
  scoreMomentum,
  weekStart,
  type MomentumInput,
} from "../lib/growMomentum.js";

// CC #5 / SPEC-01 — GET /grow/momentum. Private: always the signed-in agent's
// own rows inside their own brokerage. Read-only. 404 while
// GROW_MOMENTUM_ENABLED is not "true" so the feature does not exist when off.

export const growMomentumRouter = Router();

const TIME_ZONE = "Australia/Brisbane";
const ROW_CAP = 2000;
const querySchema = z.object({
  period: z.enum(["week", "month"]).default("week"),
  asOf: z.coerce.date().optional(),
});

function flagGate(_req: unknown, res: import("express").Response, next: () => void) {
  if (!isMomentumEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

function addPeriods(start: Date, period: "week" | "month", n: number): Date {
  if (period === "week") return new Date(start.getTime() + n * 7 * 86_400_000);
  // Brisbane has no DST: shift by calendar months on the local-midnight instant.
  const d = new Date(start.getTime() + 10 * 3_600_000);
  d.setUTCMonth(d.getUTCMonth() + n);
  return new Date(d.getTime() - 10 * 3_600_000);
}

growMomentumRouter.get("/", flagGate, requireAuth, requireMinimalUxAllowlisted, requireEntitlement("grow.access"), async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;
  const now = parsed.data.asOf ?? new Date();
  const period = parsed.data.period;
  const trendLength = period === "week" ? 4 : 6;
  const currentStart = period === "week" ? weekStart(now, TIME_ZONE) : monthStart(now, TIME_ZONE);
  const currentEnd = addPeriods(currentStart, period, 1);
  const earliest = addPeriods(currentStart, period, -(trendLength - 1));
  const streakFrom = new Date(now.getTime() - 30 * 86_400_000);
  const fetchFrom = earliest < streakFrom ? earliest : streakFrom;

  const [activities, opportunities, appraisalRows] = await Promise.all([
    db
      .select({
        id: growActivities.id,
        partyId: growActivities.partyId,
        activityType: growActivities.activityType,
        occurredAt: growActivities.occurredAt,
        sourceId: growActivities.sourceId,
        source: growActivities.source,
      })
      .from(growActivities)
      .where(and(
        eq(growActivities.brokerageId, user.brokerageId),
        eq(growActivities.responsibleUserId, user.id),
        gte(growActivities.occurredAt, fetchFrom),
        lt(growActivities.occurredAt, currentEnd),
      ))
      .limit(ROW_CAP),
    db
      .select({ id: growOpportunities.id, partyId: growOpportunities.partyId, createdAt: growOpportunities.createdAt })
      .from(growOpportunities)
      .where(and(
        eq(growOpportunities.brokerageId, user.brokerageId),
        eq(growOpportunities.ownerUserId, user.id),
        gte(growOpportunities.createdAt, earliest),
        lt(growOpportunities.createdAt, currentEnd),
      ))
      .limit(ROW_CAP),
    db
      .select({ id: appraisals.id, createdAt: appraisals.createdAt, updatedAt: appraisals.updatedAt, isFinalised: appraisals.isFinalised })
      .from(appraisals)
      .where(and(
        eq(appraisals.brokerageId, user.brokerageId),
        eq(appraisals.ownerUserId, user.id),
        or(
          and(gte(appraisals.createdAt, earliest), lt(appraisals.createdAt, currentEnd)),
          and(eq(appraisals.isFinalised, true), gte(appraisals.updatedAt, earliest), lt(appraisals.updatedAt, currentEnd)),
        ),
      ))
      .limit(ROW_CAP),
  ]);
  const appraisalInputs = appraisalRows.map((a) => ({ id: a.id, createdAt: a.createdAt, completedAt: a.isFinalised ? a.updatedAt : null }));

  const scoreFor = (start: Date, end: Date) =>
    scoreMomentum({ activities, opportunities, appraisals: appraisalInputs, start, end, timeZone: TIME_ZONE } satisfies MomentumInput);

  const trend = Array.from({ length: trendLength }, (_, i) => {
    const s = addPeriods(earliest, period, i);
    const e = addPeriods(earliest, period, i + 1);
    return { start: s.toISOString(), score: scoreFor(s, e).score };
  });
  const current = scoreFor(currentStart, currentEnd);
  const previous = trend.length >= 2 ? trend[trend.length - 2].score : 0;

  // Streak: consecutive local days up to today with at least one scoring conversation or outreach.
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
  const activeDays = new Set<string>();
  for (const a of activities) {
    if (a.occurredAt < streakFrom || a.occurredAt > now) continue;
    if (["call", "call_summary", "meeting", "email", "sms"].includes(a.activityType)) activeDays.add(fmt.format(a.occurredAt));
  }
  let streakDays = 0;
  for (let d = 0; d < 30; d++) {
    if (activeDays.has(fmt.format(new Date(now.getTime() - d * 86_400_000)))) streakDays++;
    else if (d > 0) break; // today may still be empty without breaking the streak
  }

  res.json({
    rulesVersion: MOMENTUM_RULES_V1.version,
    private: true,
    period,
    timeZone: TIME_ZONE,
    start: currentStart.toISOString(),
    end: currentEnd.toISOString(),
    score: current.score,
    previousScore: previous,
    change: current.score - previous,
    nextMilestone: nextMilestone(current.score),
    categories: current.categories,
    funnel: current.funnel,
    trend,
    streakDays,
    nextBestActions: [],
    truncated: activities.length >= ROW_CAP || opportunities.length >= ROW_CAP || appraisalRows.length >= ROW_CAP,
  });
});
