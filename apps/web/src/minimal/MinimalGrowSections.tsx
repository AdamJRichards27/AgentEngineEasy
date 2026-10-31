import { Link } from "wouter";
import type { GrowTab } from "../lib/growWorkspace";
import { MINIMAL_GROW_SECTIONS } from "./minimalGrowNav";

// Grow section nav for the Minimal shell: the same sections and addresses as
// the classic Grow tabs, so every Grow screen stays one click away.
export function MinimalGrowSections({ current }: { current: GrowTab }) {
  return (
    <nav className="am-sections" aria-label="Grow sections">
      {MINIMAL_GROW_SECTIONS.map((s) => (
        <Link
          key={s.key}
          href={s.href}
          className={`am-section-link${s.key === current ? " is-current" : ""}`}
          aria-current={s.key === current ? "page" : undefined}
        >
          {s.label}
        </Link>
      ))}
    </nav>
  );
}
