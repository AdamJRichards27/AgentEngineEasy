import * as React from "react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode, type UIEvent } from "react";
import { GrowTableScroll } from "./GrowTableScroll";
import { apiErrorMessage } from "../lib/api";
import { showingCountLabel } from "../lib/growListQuery";

const DEFAULT_VIEWPORT_PX = 512;
/** Rows of slack on each side of the viewport, in addition to one viewport of pixels. */
const OVERSCAN_ROWS = 12;

/**
 * Memoised row component when React.memo is available. The behaviour-test
 * harness replaces React with a small mock that has no memo export; in that
 * runtime the row renders as a plain function, which is what those tests walk.
 */
export function memoRow<P extends object>(Component: (props: P) => ReactElement | null): (props: P) => ReactElement | null {
  if (typeof React.memo === "function") {
    return React.memo(Component) as (props: P) => ReactElement | null;
  }
  return Component;
}

type Page<T> = {
  items: T[];
  nextCursor?: string | null;
  total?: number;
};

/**
 * First page comes from the existing useQuery. Further pages append here so a
 * load-more click does not replace the rows already on screen. `resetKey` and
 * the first page's ids drop the appended pages when the filter or the first
 * page changes.
 */
export function useGrowCursorPages<T>(options: {
  resetKey: string;
  page: Page<T> | undefined;
  getId: (item: T) => number;
  fetchPage: (cursor: string) => Promise<Page<T>>;
}): {
  items: T[];
  total: number | undefined;
  hasMore: boolean;
  loadingMore: boolean;
  moreError: string | null;
  loadMore: () => void;
} {
  const { resetKey, page, getId, fetchPage } = options;
  const [extra, setExtra] = useState<T[]>([]);
  const [override, setOverride] = useState<{ key: string; ids: string; next: string | false } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const busy = useRef(false);

  const firstItems = page?.items ?? [];
  const ids = firstItems.map((item) => getId(item)).join(",");
  const active = override && override.key === resetKey && override.ids === ids ? override : null;
  const appended = active ? extra : [];
  const seen = new Set<number>();
  const items: T[] = [];
  for (const item of firstItems.concat(appended)) {
    const id = getId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push(item);
  }
  const nextCursor = active ? (active.next === false ? null : active.next) : (page?.nextCursor ?? null);
  const hasMore = typeof nextCursor === "string" && nextCursor.length > 0;
  const total = typeof page?.total === "number" ? page.total : undefined;

  function loadMore() {
    if (busy.current || !hasMore || nextCursor === null) return;
    const requested = nextCursor;
    const requestKey = resetKey;
    const requestIds = ids;
    const base = appended.slice();
    const seenIds = new Set(items.map((item) => getId(item)));
    busy.current = true;
    setLoadingMore(true);
    setMoreError(null);
    void fetchPage(requested)
      .then((next) => {
        const incoming = next.items.filter((item) => !seenIds.has(getId(item)));
        setExtra(base.concat(incoming));
        setOverride({ key: requestKey, ids: requestIds, next: next.nextCursor ? next.nextCursor : false });
      })
      .catch((error: unknown) => {
        setMoreError(apiErrorMessage(error, "Couldn't load more."));
      })
      .finally(() => {
        busy.current = false;
        setLoadingMore(false);
      });
  }

  return { items, total, hasMore, loadingMore, moreError, loadMore };
}

type ScrollRegion = {
  scrollTop: number;
  scrollHeight?: number;
  clientHeight?: number;
  querySelectorAll?: (selector: string) => ArrayLike<Element>;
  querySelector?: (selector: string) => Element | null;
  getBoundingClientRect?: () => { top: number; bottom: number };
};

/**
 * Which loaded rows to paint. Positions use each row's own height (measured,
 * or `sizeAt`) so a fixed estimate cannot hide the tail. `pinnedToEnd` is the
 * browser's scrollport sitting on its real bottom: rendered rows are often
 * shorter than the estimate, so the scroll range stops before the estimate
 * math would include the last indexes. Those indexes used to stay inside the
 * bottom spacer forever.
 */
export function virtualRowWindow(input: {
  count: number;
  scrollTop: number;
  viewport: number;
  estimate: number;
  header: number;
  pinnedToEnd: boolean;
  sizeAt: (index: number) => number;
}): { start: number; end: number; top: number; bottom: number } {
  const { count, scrollTop, viewport, estimate, header, pinnedToEnd, sizeAt } = input;
  if (count <= 0) return { start: 0, end: 0, top: 0, bottom: 0 };

  const offsets = new Array<number>(count + 1);
  offsets[0] = 0;
  for (let index = 0; index < count; index += 1) {
    const size = sizeAt(index);
    offsets[index + 1] = offsets[index]! + (size > 0 ? size : estimate);
  }

  const overscanPx = Math.max(viewport, estimate * OVERSCAN_ROWS);
  const viewTop = scrollTop - overscanPx;
  const viewBottom = scrollTop + Math.max(viewport, 1) + overscanPx;

  let start = 0;
  while (start < count && header + offsets[start + 1]! <= viewTop) start += 1;

  let end = start;
  while (end < count && header + offsets[end]! < viewBottom) end += 1;

  if (pinnedToEnd) {
    end = count;
    if (start >= count) {
      const tail = Math.max(1, Math.ceil(Math.max(viewport, 1) / estimate) + OVERSCAN_ROWS);
      start = Math.max(0, count - tail);
    }
  }
  if (end < start) end = start;

  return {
    start,
    end,
    top: offsets[start] ?? 0,
    bottom: (offsets[count] ?? 0) - (offsets[end] ?? 0),
  };
}

function wheelDeltaPx(event: WheelEvent, viewport: number): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * viewport;
  return event.deltaY;
}

function bindVerticalWheel(region: HTMLDivElement): () => void {
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey) return;
    const viewport = region.clientHeight || DEFAULT_VIEWPORT_PX;
    const deltaY = wheelDeltaPx(event, viewport);
    if (deltaY === 0 || Math.abs(event.deltaX) > Math.abs(deltaY)) return;
    const max = region.scrollHeight - region.clientHeight;
    if (max <= 1) return;
    const next = Math.min(max, Math.max(0, region.scrollTop + deltaY));
    if (next === region.scrollTop) return;
    region.scrollTop = next;
    event.preventDefault();
  };
  region.addEventListener("wheel", onWheel, { passive: false });
  return () => region.removeEventListener("wheel", onWheel);
}

function readHeaderOffset(region: ScrollRegion): number | null {
  if (typeof region.querySelector !== "function" || typeof region.getBoundingClientRect !== "function") return null;
  const head = region.querySelector("thead");
  if (!head || typeof (head as HTMLElement).getBoundingClientRect !== "function") return null;
  const next = Math.round((head as HTMLElement).getBoundingClientRect().bottom - region.getBoundingClientRect().top + region.scrollTop);
  return next > 0 ? next : null;
}

function useVirtualSlice(count: number, estimate: number, rowHeight?: (index: number) => number, resetKey = "") {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT_PX);
  const [pinnedToEnd, setPinnedToEnd] = useState(false);
  const [header, setHeader] = useState(0);
  const [seenKey, setSeenKey] = useState(resetKey);
  const [measureTick, setMeasureTick] = useState(0);
  const measured = useRef<number[]>([]);
  const regionRef = useRef<HTMLDivElement | null>(null);

  const keyChanged = seenKey !== resetKey;
  if (keyChanged) {
    setSeenKey(resetKey);
    if (scrollTop !== 0) setScrollTop(0);
    if (pinnedToEnd) setPinnedToEnd(false);
    if (header !== 0) setHeader(0);
    measured.current = [];
  }

  const topScroll = keyChanged ? 0 : scrollTop;
  const topPinned = keyChanged ? false : pinnedToEnd;
  const topHeader = keyChanged ? 0 : header;
  void measureTick;

  useEffect(() => {
    const region = regionRef.current;
    if (!region || typeof region.addEventListener !== "function") return undefined;
    return bindVerticalWheel(region);
  }, []);

  function sizeAt(index: number) {
    const known = measured.current[index];
    if (typeof known === "number" && known > 0) return known;
    return rowHeight ? rowHeight(index) : estimate;
  }

  const window = virtualRowWindow({
    count,
    scrollTop: topScroll,
    viewport,
    estimate,
    header: topHeader,
    pinnedToEnd: topPinned,
    sizeAt,
  });

  function measure(region: ScrollRegion) {
    if (typeof region.querySelectorAll !== "function") return;
    let changed = false;
    const nodes = region.querySelectorAll("[data-grow-index]");
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i] as HTMLElement;
      const index = Number(node.getAttribute?.("data-grow-index"));
      const height = node.offsetHeight;
      if (!Number.isInteger(index) || index < 0 || !(height > 0)) continue;
      if (measured.current[index] !== height) {
        measured.current[index] = height;
        changed = true;
      }
    }
    const nextHeader = readHeaderOffset(region);
    if (nextHeader !== null && nextHeader !== header) {
      setHeader(nextHeader);
      changed = true;
    }
    if (changed) setMeasureTick((tick) => tick + 1);
  }

  function sync(region: ScrollRegion, onNearEnd?: () => void) {
    const nextTop = region.scrollTop || 0;
    const nextViewport = region.clientHeight && region.clientHeight > 0 ? region.clientHeight : DEFAULT_VIEWPORT_PX;
    const atEnd = typeof region.scrollHeight === "number" && region.scrollHeight - nextTop - (region.clientHeight || 0) <= 1;
    measure(region);
    setScrollTop(nextTop);
    setViewport(nextViewport);
    setPinnedToEnd(atEnd);
    if (
      onNearEnd &&
      typeof region.scrollHeight === "number" &&
      region.scrollHeight - nextTop - (region.clientHeight || 0) < estimate * 2
    ) {
      onNearEnd();
    }
  }

  return {
    ...window,
    regionRef,
    sync,
  };
}

function onViewportKeyDown(event: KeyboardEvent<HTMLDivElement>, estimate: number, sync: (region: ScrollRegion) => void) {
  const region = event.currentTarget;
  const page = region.clientHeight || DEFAULT_VIEWPORT_PX;
  if (event.key === "ArrowDown") region.scrollTop += estimate;
  else if (event.key === "ArrowUp") region.scrollTop -= estimate;
  else if (event.key === "PageDown") region.scrollTop += page;
  else if (event.key === "PageUp") region.scrollTop -= page;
  else if (event.key === "Home") region.scrollTop = 0;
  else if (event.key === "End") region.scrollTop = Math.max(0, region.scrollHeight - (region.clientHeight || 0));
  else return;
  event.preventDefault();
  sync(region);
}

function CountLine({ shown, total, singular, plural }: { shown: number; total: number | undefined; singular: string; plural: string }) {
  if (typeof total !== "number") return null;
  return (
    <p className="muted grow-list-count" role="status" aria-live="polite" aria-atomic="true">
      {showingCountLabel(shown, total, singular, plural)}
    </p>
  );
}

function LoadMore({
  plural,
  hasMore,
  loadingMore,
  moreError,
  onLoadMore,
}: {
  plural: string;
  hasMore: boolean;
  loadingMore: boolean;
  moreError: string | null;
  onLoadMore: () => void;
}) {
  return (
    <>
      {moreError ? (
        <p className="error-text" role="alert">
          {moreError}
        </p>
      ) : null}
      {hasMore ? (
        <button
          type="button"
          className="btn btn-secondary btn-small grow-load-more"
          onClick={onLoadMore}
          disabled={loadingMore}
          aria-label={`Load more ${plural}`}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </>
  );
}

export function GrowVirtualTable<T>({
  label,
  singular,
  plural,
  head,
  colSpan,
  items,
  total,
  getKey,
  renderCells,
  hasMore,
  loadingMore,
  moreError,
  onLoadMore,
  estimate = 84,
  rowHeight,
  resetKey = "",
}: {
  label: string;
  singular: string;
  plural: string;
  head: ReactNode;
  colSpan: number;
  items: T[];
  total: number | undefined;
  getKey: (item: T) => number;
  renderCells: (item: T) => ReactNode;
  hasMore: boolean;
  loadingMore: boolean;
  moreError: string | null;
  onLoadMore: () => void;
  estimate?: number;
  /** Per-row height when the caller already knows it. Measured DOM heights win. */
  rowHeight?: (index: number) => number;
  /** Drops the scroll window when the filter changes. */
  resetKey?: string;
}) {
  const slice = useVirtualSlice(items.length, estimate, rowHeight, resetKey);
  const rows = items.slice(slice.start, slice.end);
  function onRegionScroll(event: UIEvent<HTMLDivElement>) {
    slice.sync(event.currentTarget, hasMore ? onLoadMore : undefined);
  }
  function onRegionKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    onViewportKeyDown(event, estimate, (region) => slice.sync(region, hasMore ? onLoadMore : undefined));
  }
  return (
    <>
      <CountLine shown={items.length} total={total} singular={singular} plural={plural} />
      <GrowTableScroll
        viewportRef={slice.regionRef}
        className="grow-virtual-viewport"
        role="region"
        aria-label={label}
        tabIndex={0}
        aria-busy={loadingMore ? true : undefined}
        onScroll={onRegionScroll}
        onKeyDown={onRegionKeyDown}
      >
        <table className="grow-table">
          <thead>{head}</thead>
          <tbody>
            {slice.start > 0 ? (
              <tr aria-hidden="true" className="grow-virtual-spacer">
                <td colSpan={colSpan} style={{ height: slice.top, padding: 0, border: 0 }} />
              </tr>
            ) : null}
            {rows.map((item, offset) => (
              <tr key={getKey(item)} data-grow-index={slice.start + offset}>
                {renderCells(item)}
              </tr>
            ))}
            {slice.end < items.length ? (
              <tr aria-hidden="true" className="grow-virtual-spacer">
                <td colSpan={colSpan} style={{ height: slice.bottom, padding: 0, border: 0 }} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </GrowTableScroll>
      <LoadMore plural={plural} hasMore={hasMore} loadingMore={loadingMore} moreError={moreError} onLoadMore={onLoadMore} />
    </>
  );
}

export function GrowVirtualTimeline<T>({
  label,
  singular,
  plural,
  items,
  total,
  getKey,
  renderItem,
  hasMore,
  loadingMore,
  moreError,
  onLoadMore,
  estimate = 96,
  rowHeight,
  resetKey = "",
}: {
  label: string;
  singular: string;
  plural: string;
  items: T[];
  total: number | undefined;
  getKey: (item: T) => number;
  renderItem: (item: T) => ReactNode;
  hasMore: boolean;
  loadingMore: boolean;
  moreError: string | null;
  onLoadMore: () => void;
  estimate?: number;
  rowHeight?: (index: number) => number;
  resetKey?: string;
}) {
  const slice = useVirtualSlice(items.length, estimate, rowHeight, resetKey);
  const rows = items.slice(slice.start, slice.end);
  return (
    <>
      <CountLine shown={items.length} total={total} singular={singular} plural={plural} />
      <div
        ref={slice.regionRef}
        className="grow-virtual-viewport"
        role="region"
        aria-label={label}
        tabIndex={0}
        aria-busy={loadingMore ? true : undefined}
        onScroll={(event) => slice.sync(event.currentTarget, hasMore ? onLoadMore : undefined)}
        onKeyDown={(event) => onViewportKeyDown(event, estimate, (region) => slice.sync(region, hasMore ? onLoadMore : undefined))}
      >
        <ul className="timeline">
          {slice.start > 0 ? <li aria-hidden="true" className="grow-virtual-spacer" style={{ height: slice.top }} /> : null}
          {rows.map((item, offset) => (
            <li key={getKey(item)} data-grow-index={slice.start + offset}>
              {renderItem(item)}
            </li>
          ))}
          {slice.end < items.length ? (
            <li aria-hidden="true" className="grow-virtual-spacer" style={{ height: slice.bottom }} />
          ) : null}
        </ul>
      </div>
      <LoadMore plural={plural} hasMore={hasMore} loadingMore={loadingMore} moreError={moreError} onLoadMore={onLoadMore} />
    </>
  );
}
