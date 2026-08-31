// Agent Engine 2.0 — Property Launch & Campaign Coordination.
//
// Campaign templates: a fixed, code-defined catalogue (same "controlled
// registry, not user-authored config" discipline the Exception & Risk
// Engine's rule registry already established for this app — see
// exceptions/registry.ts's own module comment) mapping a template type to
// the campaign items it generates, each with a lead time (days before the
// target launch date the item is due) used for backward due-date
// calculation.

import type { CampaignItemType, LaunchTemplateType } from "@aee/db";

export interface CampaignTemplateItem {
  itemType: CampaignItemType;
  title: string;
  description: string;
  leadDays: number; // days before targetLaunchDate this item is due
}

export const CAMPAIGN_TEMPLATES: Record<LaunchTemplateType, CampaignTemplateItem[]> = {
  STANDARD_PRIVATE_TREATY: [
    { itemType: "PHOTOGRAPHY", title: "Professional photography", description: "Full interior/exterior photography set.", leadDays: 10 },
    { itemType: "FLOOR_PLAN", title: "Floor plan", description: "Measured floor plan for marketing materials.", leadDays: 10 },
    { itemType: "COPYWRITING", title: "Listing copy", description: "Property description for the listing and portals.", leadDays: 7 },
    { itemType: "SIGNAGE", title: "For sale signboard", description: "Order and install the signboard.", leadDays: 5 },
    { itemType: "BROCHURE", title: "Property brochure", description: "Printed/digital brochure for open homes.", leadDays: 4 },
    { itemType: "DIGITAL_AD", title: "Online portal listing preparation", description: "Prepare the listing content for portal submission.", leadDays: 3 },
  ],
  AUCTION: [
    { itemType: "PHOTOGRAPHY", title: "Professional photography", description: "Full interior/exterior photography set.", leadDays: 14 },
    { itemType: "FLOOR_PLAN", title: "Floor plan", description: "Measured floor plan for marketing materials.", leadDays: 14 },
    { itemType: "COPYWRITING", title: "Auction listing copy", description: "Property description emphasising the auction campaign.", leadDays: 10 },
    { itemType: "SIGNAGE", title: "Auction signboard", description: "Order and install the auction signboard.", leadDays: 7 },
    { itemType: "BROCHURE", title: "Auction brochure", description: "Printed/digital brochure for open homes.", leadDays: 6 },
    { itemType: "DIGITAL_AD", title: "Online portal listing preparation", description: "Prepare the listing content for portal submission.", leadDays: 5 },
    { itemType: "SOCIAL_MEDIA", title: "Auction social media campaign", description: "Social promotion in the lead-up to auction day.", leadDays: 5 },
  ],
  OFF_MARKET: [
    { itemType: "PHOTOGRAPHY", title: "Professional photography", description: "Full interior/exterior photography set.", leadDays: 7 },
    { itemType: "COPYWRITING", title: "Off-market listing summary", description: "Short property summary for private distribution.", leadDays: 5 },
    { itemType: "DIGITAL_AD", title: "Private database distribution", description: "Prepare content for distribution to the buyer database.", leadDays: 2 },
  ],
  // Custom: the agent builds the item list by hand — applying this
  // template generates nothing, matching the governing spec's "Custom"
  // template option.
  CUSTOM: [],
};

const DEFAULT_LAUNCH_TIMEZONE = "Australia/Sydney";

function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = Number(map.hour) === 24 ? 0 : Number(map.hour);
  const asUtc = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second));
  return (asUtc - date.getTime()) / 60000;
}

function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(date);
  return {
    year: Number(parts.find((p) => p.type === "year")!.value),
    month: Number(parts.find((p) => p.type === "month")!.value),
    day: Number(parts.find((p) => p.type === "day")!.value),
  };
}

/**
 * Backward-calculates a due date: `leadDays` calendar days before
 * `targetLaunchDate`, at local midnight in `timeZone` (default
 * Australia/Sydney, overridable via LAUNCH_TIMEZONE — this codebase has no
 * existing timezone-database dependency to lean on, so this uses only the
 * built-in Intl API, correctly handling AU daylight saving via the
 * offset-at-that-instant technique in getTimeZoneOffsetMinutes rather than
 * a fixed UTC+10/+11 assumption).
 */
export function calculateDueDate(targetLaunchDate: Date, leadDays: number, timeZone: string = process.env.LAUNCH_TIMEZONE || DEFAULT_LAUNCH_TIMEZONE): Date {
  const { year, month, day } = localDateParts(targetLaunchDate, timeZone);
  const naiveUtcGuess = new Date(Date.UTC(year, month - 1, day));
  const offsetMinutes = getTimeZoneOffsetMinutes(naiveUtcGuess, timeZone);
  const localMidnightUtc = new Date(naiveUtcGuess.getTime() - offsetMinutes * 60 * 1000);
  return new Date(localMidnightUtc.getTime() - leadDays * 24 * 60 * 60 * 1000);
}
