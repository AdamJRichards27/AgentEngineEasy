import type { ReactNode } from "react";
import { Link } from "wouter";
import { MobilePersonRow, type MobilePersonRowData } from "./MobilePersonRow";

// AE Mobile (CC Task #64, M4): the phone People list. Presentational: no hooks, no network. One search field,
// one role select, a count, rows that each open that person, and "Show more people". Add and Import are
// links to the existing screens, shown only when the user may use them.

export interface MobilePeopleViewProps {
  sectionsSlot: ReactNode;
  search: string;
  role: string;
  roleOptions: Array<{ value: string; label: string }>;
  countLine: string;
  rows: MobilePersonRowData[];
  emptyText: string | null;
  loading: boolean;
  error: { text: string; onRetry: () => void } | null;
  canLoadMore: boolean;
  loadingMore: boolean;
  addHref: string | null;
  importHref: string | null;
  onSearch: (text: string) => void;
  onRole: (role: string) => void;
  onLoadMore: () => void;
}

export function MobilePeopleView(p: MobilePeopleViewProps) {
  return (
    <div className="mob-p" data-ae-people="mobile">
      {p.sectionsSlot}
      <div className="mob-p-head">
        <h1 className="mob-p-title">People</h1>
        {p.addHref ? (
          <Link href={p.addHref} className="mob-p-button">
            Add a person
          </Link>
        ) : null}
      </div>

      <input
        type="search"
        className="mob-p-input"
        aria-label="Search people"
        placeholder="Search by name, organisation or email"
        autoComplete="off"
        value={p.search}
        onChange={(event: { target: { value: string } }) => p.onSearch(event.target.value)}
      />
      <select
        className="mob-p-input"
        aria-label="Filter by role"
        value={p.role}
        onChange={(event: { target: { value: string } }) => p.onRole(event.target.value)}
      >
        {p.roleOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <p className="mob-p-note" role="status">
        {p.loading ? "Loading people…" : p.countLine}
      </p>

      {p.error ? (
        <div className="mob-p-card" role="alert">
          <p className="mob-p-error">{p.error.text}</p>
          <button type="button" className="mob-p-button" onClick={p.error.onRetry}>
            Try again
          </button>
        </div>
      ) : null}

      {p.rows.length > 0 ? (
        <div className="mob-p-list">
          {p.rows.map((row) => (
            <MobilePersonRow key={row.id} person={row} />
          ))}
        </div>
      ) : null}
      {p.emptyText ? <p className="mob-p-note">{p.emptyText}</p> : null}

      {p.canLoadMore ? (
        <button type="button" className="mob-p-button mob-p-wide" disabled={p.loadingMore} onClick={p.onLoadMore}>
          {p.loadingMore ? "Loading…" : "Show more people"}
        </button>
      ) : null}
      {p.importHref ? (
        <Link href={p.importHref} className="mob-p-link">
          Import contacts
        </Link>
      ) : null}
    </div>
  );
}
