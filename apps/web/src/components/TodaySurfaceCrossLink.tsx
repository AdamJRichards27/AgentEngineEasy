import { Link } from "wouter";
import type { TodaySurfaceCrossLink as TodaySurfaceCrossLinkModel } from "../lib/todaySurfaces";

// G-3 — one cross-link markup for Grow Today and the RUN Command Centre.
// The words and the href come from lib/todaySurfaces.ts.
export function TodaySurfaceCrossLink({ link }: { link: TodaySurfaceCrossLinkModel }) {
  return (
    <p className="muted today-surface-cross-link">
      {link.distinction}{" "}
      <Link href={link.href}>{link.label}</Link>
    </p>
  );
}
