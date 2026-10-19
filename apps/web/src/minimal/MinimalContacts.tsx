import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch } from "../lib/api";
import { GROW_CONTACT_ROLES, type GrowContactListPage } from "../lib/growContactList";
import { growListPath, showingCountLabel } from "../lib/growListQuery";
import {
  contactsEmptyMessage,
  growDataRegionError,
  growDataRegionState,
  type GrowDataRegionState,
} from "../lib/growWorkspace";
import { useGrowCursorPages } from "../components/GrowVirtualList";
import { MinimalGrowSections } from "./MinimalGrowSections";
import { MINIMAL_CONTACTS_FULL_HREF } from "./minimalGrowNav";
import { buildMinimalContactRows, type MinimalContactRow } from "./minimalContactsModel";

// AE Minimal A Contacts. Read-only list from the existing GET /grow/contacts
// (search, role filter, cursor pages) under the same react-query key as the
// classic list, so classic writes refresh it. Adding or editing a contact stays
// in the full contacts workspace and Contact 360; nothing here writes.

export default function MinimalContacts() {
  const [search, setSearch] = useState("");
  const [committedSearch, setCommittedSearch] = useState("");
  const [role, setRole] = useState("");

  const contacts = useQuery<GrowContactListPage>({
    queryKey: ["grow-contacts", committedSearch, role],
    queryFn: () => apiFetch(growListPath("/grow/contacts", { search: committedSearch, role })),
  });
  const pages = useGrowCursorPages({
    resetKey: `${committedSearch}\0${role}`,
    page: contacts.data
      ? { items: contacts.data.contacts, nextCursor: contacts.data.nextCursor, total: contacts.data.total }
      : undefined,
    getId: (contact) => contact.id,
    fetchPage: (cursor) =>
      apiFetch<GrowContactListPage>(growListPath("/grow/contacts", { search: committedSearch, role, cursor })).then((page) => ({
        items: page.contacts,
        nextCursor: page.nextCursor,
        total: page.total,
      })),
  });

  const count = contacts.data ? pages.items.length : undefined;
  const state = growDataRegionState(contacts, count);
  const error = contacts.isError ? growDataRegionError(contacts.error, "Couldn't load contacts.") : null;

  return (
    <MinimalContactsView
      state={state}
      rows={buildMinimalContactRows(pages.items)}
      total={pages.total}
      search={search}
      role={role}
      committedSearch={committedSearch}
      errorMessage={error?.message ?? null}
      errorReference={error?.reference ?? null}
      hasMore={pages.hasMore}
      loadingMore={pages.loadingMore}
      moreError={pages.moreError}
      onSearchText={setSearch}
      onSubmitSearch={() => setCommittedSearch(search.trim())}
      onRole={(next) => {
        setRole(next);
        setCommittedSearch(search.trim());
      }}
      onRetry={() => void contacts.refetch()}
      onLoadMore={pages.loadMore}
    />
  );
}

export interface MinimalContactsViewProps {
  state: GrowDataRegionState;
  rows: MinimalContactRow[];
  total: number | undefined;
  search: string;
  role: string;
  committedSearch: string;
  errorMessage: string | null;
  errorReference: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  moreError: string | null;
  onSearchText: (text: string) => void;
  onSubmitSearch: () => void;
  onRole: (role: string) => void;
  onRetry: () => void;
  onLoadMore: () => void;
}

export function MinimalContactsView(p: MinimalContactsViewProps) {
  return (
    <div className="am-contacts" data-ae-contacts="minimal">
      <MinimalGrowSections current="contacts" />
      <div className="am-welcome">
        <div>
          <div className="am-eyebrow">Grow</div>
          <h1>Contacts</h1>
          <p>Everyone Grow knows about. Open a contact to see their Contact 360.</p>
        </div>
        <div className="am-welcome-actions">
          <Link href={MINIMAL_CONTACTS_FULL_HREF} className="am-welcome-link">
            Add or manage contacts
          </Link>
          <Link href="/grow/import" className="am-welcome-link">
            Import
          </Link>
        </div>
      </div>

      <form
        className="am-search-row"
        role="search"
        onSubmit={(event: { preventDefault: () => void }) => {
          event.preventDefault();
          p.onSubmitSearch();
        }}
      >
        <input
          type="search"
          className="am-search-input"
          placeholder="Search by name, organisation, or email"
          aria-label="Search contacts"
          autoComplete="off"
          value={p.search}
          onChange={(event: { target: { value: string } }) => p.onSearchText(event.target.value)}
        />
        <label className="am-search-filter" htmlFor="am-contacts-role">
          <span>Role</span>
          <select
            id="am-contacts-role"
            value={p.role}
            onChange={(event: { target: { value: string } }) => p.onRole(event.target.value)}
          >
            <option value="">All roles</option>
            {GROW_CONTACT_ROLES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="am-classic-switch">
          Search
        </button>
      </form>

      {p.state === "loading" ? <p className="am-empty-note" role="status">Loading contacts…</p> : null}
      {p.state === "error" ? (
        <div className="am-rail-section" role="alert">
          <p className="am-switch-error">{p.errorMessage ?? "Couldn't load contacts."}</p>
          {p.errorReference ? <p className="am-empty-note">{p.errorReference}</p> : null}
          <button type="button" className="am-classic-switch" onClick={p.onRetry}>
            Try again
          </button>
        </div>
      ) : null}
      {p.state === "empty" ? (
        <p className="am-empty-note" role="status">
          {contactsEmptyMessage(p.committedSearch, p.role)}
        </p>
      ) : null}

      {p.state === "ready" ? (
        <section className="am-rail-section am-contact-list-section" aria-labelledby="am-contacts-list">
          <h2 id="am-contacts-list" className="am-eyebrow">
            {typeof p.total === "number"
              ? showingCountLabel(p.rows.length, p.total, "contact", "contacts")
              : `${p.rows.length} ${p.rows.length === 1 ? "contact" : "contacts"}`}
          </h2>
          <ul className="am-contact-list">
            {p.rows.map((row) => (
              <li key={row.id} className="am-contact-row">
                <Link href={row.href} className="am-contact-row-link">
                  <span className="am-contact-avatar am-contact-avatar-sm" aria-hidden="true">
                    {row.initials}
                  </span>
                  <span className="am-contact-row-main">
                    <span className="am-agenda-title">{row.title}</span>
                    <span className="am-agenda-sub">{row.contactLine}</span>
                  </span>
                  <span className="am-contact-row-meta">
                    {row.roleChips.length > 0 ? (
                      <span className="am-chip-row">
                        <span className="am-sr-only">Roles: </span>
                        {row.roleChips.map((r) => (
                          <span key={r} className="am-chip">
                            {r}
                          </span>
                        ))}
                      </span>
                    ) : null}
                    <span className="am-agenda-sub">{row.propertiesLabel}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {p.moreError ? (
            <p className="am-switch-error" role="alert">
              {p.moreError}
            </p>
          ) : null}
          {p.hasMore ? (
            <button type="button" className="am-classic-switch" onClick={p.onLoadMore} disabled={p.loadingMore}>
              {p.loadingMore ? "Loading more…" : "Load more contacts"}
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
