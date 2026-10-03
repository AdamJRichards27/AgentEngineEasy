import type { ReactNode } from "react";

// UAT D4 — a Grow table is often wider than a phone. This box is the only
// thing that scrolls sideways. The page itself stays within the viewport
// (see .grow-table-scroll and the min-width: 0 flex chain in styles.css).
export function GrowTableScroll({ children }: { children: ReactNode }) {
  return <div className="grow-table-scroll">{children}</div>;
}
