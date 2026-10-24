// V3 responsive (AE Minimal v1.0): keep the current mobile-bar item in view.
// Pure geometry so it can be unit-tested; the shell applies it with scrollTo on
// the bar only (never scrollIntoView, which would also scroll the page).
export type MobileNavGeometry = {
  barWidth: number; // clientWidth of the scrollable bar
  scrollWidth: number; // scrollWidth of the bar
  scrollLeft: number; // current scrollLeft
  itemLeft: number; // offsetLeft of the current item within the bar
  itemWidth: number;
};

/** Returns the scrollLeft that centres the item, or null when no scroll is needed. */
export function mobileNavScrollTarget(g: MobileNavGeometry, edge = 8): number | null {
  if (g.scrollWidth <= g.barWidth) return null; // everything fits
  const visibleStart = g.scrollLeft + edge;
  const visibleEnd = g.scrollLeft + g.barWidth - edge;
  if (g.itemLeft >= visibleStart && g.itemLeft + g.itemWidth <= visibleEnd) return null; // already fully visible
  const centred = g.itemLeft + g.itemWidth / 2 - g.barWidth / 2;
  const max = g.scrollWidth - g.barWidth;
  return Math.round(Math.min(Math.max(centred, 0), max));
}

/** Which edges of the bar have hidden items, for the scroll-hint fades. */
export function mobileNavOverflowEdges(g: Pick<MobileNavGeometry, "barWidth" | "scrollWidth" | "scrollLeft">) {
  const max = g.scrollWidth - g.barWidth;
  return { start: max > 1 && g.scrollLeft > 1, end: max > 1 && g.scrollLeft < max - 1 };
}
