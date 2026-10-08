import * as React from "react";
import { useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode, type UIEvent } from "react";
import { apiErrorMessage } from "../lib/api";
import { showingCountLabel } from "../lib/growListQuery";

const DEFAULT_VIEWPORT_PX = 512;
const OVERSCAN = 6;

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

function useVirtualSlice(count: number, estimate: number) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT_PX);
  const start = Math.max(0, Math.floor(scrollTop / estimate) - OVERSCAN);
  const visible = Math.ceil(viewport / estimate) + OVERSCAN * 2;
  const end = Math.min(count, start + Math.max(visible, 1));
  return {
    start,
    end,
    onScroll(event: UIEvent<HTMLDivElement>, onNearEnd?: () => void) {
      const region = event.currentTarget;
      setScrollTop(region.scrollTop);
      if (region.clientHeight > 0) setViewport(region.clientHeight);
      if (onNearEnd && region.scrollHeight - region.scrollTop - region.clientHeight < estimate * 2) onNearEnd();
    },
  };
}

function onViewportKeyDown(event: KeyboardEvent<HTMLDivElement>, estimate: number) {
  const region = event.currentTarget;
  const page = region.clientHeight || DEFAULT_VIEWPORT_PX;
  if (event.key === "ArrowDown") region.scrollTop += estimate;
  else if (event.key === "ArrowUp") region.scrollTop -= estimate;
  else if (event.key === "PageDown") region.scrollTop += page;
  else if (event.key === "PageUp") region.scrollTop -= page;
  else if (event.key === "Home") region.scrollTop = 0;
  else if (event.key === "End") region.scrollTop = region.scrollHeight;
  else return;
  event.preventDefault();
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
}) {
  const slice = useVirtualSlice(items.length, estimate);
  const rows = items.slice(slice.start, slice.end);
  return (
    <>
      <CountLine shown={items.length} total={total} singular={singular} plural={plural} />
      <div
        className="grow-table-scroll grow-virtual-viewport"
        role="region"
        aria-label={label}
        tabIndex={0}
        aria-busy={loadingMore ? true : undefined}
        onScroll={(event) => slice.onScroll(event, hasMore ? onLoadMore : undefined)}
        onKeyDown={(event) => onViewportKeyDown(event, estimate)}
      >
        <table className="grow-table">
          <thead>{head}</thead>
          <tbody>
            {slice.start > 0 ? (
              <tr aria-hidden="true" className="grow-virtual-spacer">
                <td colSpan={colSpan} style={{ height: slice.start * estimate, padding: 0, border: 0 }} />
              </tr>
            ) : null}
            {rows.map((item) => (
              <tr key={getKey(item)}>{renderCells(item)}</tr>
            ))}
            {slice.end < items.length ? (
              <tr aria-hidden="true" className="grow-virtual-spacer">
                <td colSpan={colSpan} style={{ height: (items.length - slice.end) * estimate, padding: 0, border: 0 }} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
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
}) {
  const slice = useVirtualSlice(items.length, estimate);
  const rows = items.slice(slice.start, slice.end);
  return (
    <>
      <CountLine shown={items.length} total={total} singular={singular} plural={plural} />
      <div
        className="grow-virtual-viewport"
        role="region"
        aria-label={label}
        tabIndex={0}
        aria-busy={loadingMore ? true : undefined}
        onScroll={(event) => slice.onScroll(event, hasMore ? onLoadMore : undefined)}
        onKeyDown={(event) => onViewportKeyDown(event, estimate)}
      >
        <ul className="timeline">
          {slice.start > 0 ? <li aria-hidden="true" className="grow-virtual-spacer" style={{ height: slice.start * estimate }} /> : null}
          {rows.map((item) => (
            <li key={getKey(item)}>{renderItem(item)}</li>
          ))}
          {slice.end < items.length ? (
            <li aria-hidden="true" className="grow-virtual-spacer" style={{ height: (items.length - slice.end) * estimate }} />
          ) : null}
        </ul>
      </div>
      <LoadMore plural={plural} hasMore={hasMore} loadingMore={loadingMore} moreError={moreError} onLoadMore={onLoadMore} />
    </>
  );
}
