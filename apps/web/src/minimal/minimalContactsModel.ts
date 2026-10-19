import type { GrowContactListItem } from "../lib/growContactList";
import { growContactPath } from "../lib/growWorkspace";

// AE Minimal A contact list rows. Reads the existing GET /grow/contacts items
// and only rearranges them: no field is inferred or invented.

export interface MinimalContactRow {
  id: number;
  href: string;
  title: string;
  initials: string;
  contactLine: string;
  roleChips: string[];
  propertiesLabel: string;
  partyType: string;
}

export function minimalContactPropertiesLabel(count: number): string {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return "No linked properties";
  return count === 1 ? "1 linked property" : `${count} linked properties`;
}

export function buildMinimalContactRows(items: readonly GrowContactListItem[]): MinimalContactRow[] {
  return items.map((c) => {
    const title = c.displayName.trim() || "Unnamed contact";
    const named = c.displayName.trim().length > 0;
    const reach = [c.email, c.mobile].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    return {
      id: c.id,
      href: growContactPath(c.id),
      title,
      initials: named
        ? title.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?"
        : "?",
      contactLine: reach.length > 0 ? reach.join(" · ") : "No email or mobile recorded",
      roleChips: [...c.roles],
      propertiesLabel: minimalContactPropertiesLabel(c.relatedPropertyCount),
      partyType: c.partyType,
    };
  });
}
