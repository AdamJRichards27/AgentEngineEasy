import { Link } from "wouter";
import type { GrowTab } from "../../lib/growWorkspace";
import { MINIMAL_GROW_SECTIONS } from "../minimalGrowNav";

// AE Mobile (CC Task #64): the Grow section bar on the phone screens. It is the desktop bar (MinimalGrowSections) drawn from
// the same sections and addresses, minus Nurture. Nurture is a placeholder, not an operational feature ("Coming Soon" in the
// classic workspace), so the phone does not offer it. Everything else stays in step with the app because the list is the
// app's own, filtered. Presentational: no hooks, no network.

export const MOBILE_HIDDEN_GROW_SECTIONS: readonly GrowTab[] = ["nurture"];

export function mobileGrowSections() {
  return MINIMAL_GROW_SECTIONS.filter((s) => !MOBILE_HIDDEN_GROW_SECTIONS.includes(s.key));
}

export function MobileGrowSections({ current }: { current: GrowTab }) {
  return (
    <nav className="am-sections" aria-label="Grow sections">
      {mobileGrowSections().map((s) => (
        <Link key={s.key} href={s.href} className={`am-section-link${s.key === current ? " is-current" : ""}`} aria-current={s.key === current ? "page" : undefined}>
          {s.label}
        </Link>
      ))}
    </nav>
  );
}
