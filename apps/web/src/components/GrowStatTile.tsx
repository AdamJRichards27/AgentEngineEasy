// Grow stat tile (moved verbatim from pages/Grow.tsx, Contact 360 PR6). No behaviour change.


export function StatTile({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="stat-tile" title={hint}>
      <div className="stat-tile-label">{label}</div>
      <div className="stat-tile-value">{value}</div>
    </div>
  );
}

// ── Follow-ups on an opportunity (AE GROW Completion W2-B, E-3) ───────────
//
// PATCH /grow/opportunities/:id is the one write behind "Create follow-up".
// Grow Today's action card has offered it since Priority 1; the Opportunities
// tab and Contact 360's opportunities table offered nothing at all, so the SAME
// opportunity record was actionable on one screen and inert on the other two.
//
// The fix is deliberately not a second mutation. This hook and
// GrowNextActionForm below are the Today card's own mutation and form, lifted
// out unchanged in behaviour (same route, same method, same body shape, same
// "at least one field or don't submit" rule), and all three surfaces now call
// them. There is exactly one definition of what creating a follow-up means.
