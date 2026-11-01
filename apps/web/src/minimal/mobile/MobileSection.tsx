import type { ReactNode } from "react";

// AE Mobile (CC Task #64, M2): a titled group on a phone screen. Presentational: no hooks, no network.
export function MobileSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mob-section" aria-label={title}>
      <h2 className="mob-section-title">{title}</h2>
      {children}
    </section>
  );
}
