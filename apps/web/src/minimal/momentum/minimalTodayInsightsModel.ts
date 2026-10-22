import { isMarketActivityResponse, marketCountLines } from "../market/minimalMarketActivityModel";
import { buildMomentumModel, isMomentumResponse } from "./minimalMomentumModel";
import type { MarketCardData, MomentumCardData } from "./MinimalTodayInsightCardsView";

// Today card data from the #248 payloads. null = not a valid payload (shown as an error, never as data).

export function momentumCardData(raw: unknown): MomentumCardData | null {
  if (!isMomentumResponse(raw)) return null;
  const m = buildMomentumModel(raw);
  return { score: m.score, changeLabel: m.changeLabel, milestoneLabel: m.milestoneLabel, unavailableCount: m.categories.filter((c) => !c.available).length };
}

export function marketCardData(raw: unknown): MarketCardData | null {
  if (!isMarketActivityResponse(raw)) return null;
  const lines = marketCountLines(raw.counts);
  return { total: lines.reduce((s, l) => s + l.value, 0), lines: lines.map(({ label, value }) => ({ label, value })) };
}

