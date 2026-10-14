// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
// AE GROW Pilot Readiness WP6b (D6) — the shared loading/failed/empty region
// presentation, and the pure state logic behind it and the tab bar.
import { GrowDataRegionStatus } from "../components/GrowDataRegion";
import { contactsEmptyMessage, growDataRegionState, growContactPath } from "../lib/growWorkspace";
import {
  GrowVirtualTable,
  GrowVirtualTimeline,
  memoRow,
  useGrowCursorPages,
} from "../components/GrowVirtualList";
import { growListPath, listSearchEmptyMessage } from "../lib/growListQuery";
import { GrowListSearch } from "./GrowListSearch";
import { GrowNewContactForm } from "./GrowNewContactForm";
import { growActivityTypeLabel } from "./messages";
import type {
  GrowRelationship,
  GrowActivity,
  GrowContactListItem,
  GrowContactListPage,
  GrowRelationshipListPage,
  GrowActivityListPage,
} from "./types";
import { GROW_CONTACT_ROLES } from "./types";
import { useDebouncedListSearch } from "./useGrowMutations";

const GrowContactCells = memoRow(function GrowContactCells({ contact }: { contact: GrowContactListItem }) {
  return (
    <>
      <td>{contact.displayName}</td>
      <td>{contact.partyType}</td>
      <td>{contact.roles.length > 0 ? contact.roles.join(", ") : "–"}</td>
      <td>{contact.relatedPropertyCount}</td>
      <td>
        <Link href={growContactPath(contact.id)} className="btn btn-link btn-small">
          View Contact 360 &rarr;
        </Link>
      </td>
    </>
  );
});
const GrowRelationshipCells = memoRow(function GrowRelationshipCells({ relationship }: { relationship: GrowRelationship }) {
  const person = relationship.partyOrganisationName ?? `${relationship.partyFirstName ?? ""} ${relationship.partyLastName ?? ""}`.trim();
  return (
    <>
      <td>{person}</td>
      <td>{relationship.propertyAddress}</td>
      <td>{relationship.relationshipType}</td>
      <td>{relationship.role ?? "–"}</td>
      <td>
        <span className={`pill ${relationship.status === "Active" ? "pill-success" : relationship.status === "PendingReview" ? "pill-warning" : ""}`}>
          {relationship.status}
        </span>
      </td>
    </>
  );
});
const GrowActivityItem = memoRow(function GrowActivityItem({ activity }: { activity: GrowActivity }) {
  return (
    <>
      <span className="when">{new Date(activity.occurredAt).toLocaleString()}</span>
      <div className="eyebrow">{growActivityTypeLabel(activity.activityType)}</div>
      <p style={activity.activityType === "call_summary" ? { whiteSpace: "pre-wrap" } : undefined}>{activity.summary}</p>
    </>
  );
});
export function GrowContactList() {
  const [search, setSearch] = useState("");
  const [committedSearch, setCommittedSearch] = useState("");
  const [role, setRole] = useState("");
  const relationshipSearch = useDebouncedListSearch();
  const activitySearch = useDebouncedListSearch();

  const contacts = useQuery<GrowContactListPage>({
    queryKey: ["grow-contacts", committedSearch, role],
    queryFn: () => apiFetch(growListPath("/grow/contacts", { search: committedSearch, role })),
  });
  const contactPages = useGrowCursorPages({
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

  // Kept unchanged from Priority 1 (GET /grow/relationships, GET /grow/activities) — a
  // brokerage-wide "every property relationship" / "everything that happened recently" view is
  // still useful alongside the new per-contact Contact 360 below, and nothing about Contact 360
  // required removing it. Both lists are paged the same way as contacts.
  const relationships = useQuery<GrowRelationshipListPage>({
    queryKey: ["grow-relationships", relationshipSearch.query],
    queryFn: () => apiFetch(growListPath("/grow/relationships", { search: relationshipSearch.query })),
  });
  const relationshipPages = useGrowCursorPages({
    resetKey: `relationships\0${relationshipSearch.query}`,
    page: relationships.data
      ? { items: relationships.data.relationships, nextCursor: relationships.data.nextCursor, total: relationships.data.total }
      : undefined,
    getId: (relationship) => relationship.id,
    fetchPage: (cursor) =>
      apiFetch<GrowRelationshipListPage>(growListPath("/grow/relationships", { search: relationshipSearch.query, cursor })).then((page) => ({
        items: page.relationships,
        nextCursor: page.nextCursor,
        total: page.total,
      })),
  });
  const activities = useQuery<GrowActivityListPage>({
    queryKey: ["grow-activities", activitySearch.query],
    queryFn: () => apiFetch(growListPath("/grow/activities", { search: activitySearch.query })),
  });
  const activityPages = useGrowCursorPages({
    resetKey: `activities\0${activitySearch.query}`,
    page: activities.data
      ? { items: activities.data.activities, nextCursor: activities.data.nextCursor, total: activities.data.total }
      : undefined,
    getId: (activity) => activity.id,
    fetchPage: (cursor) =>
      apiFetch<GrowActivityListPage>(growListPath("/grow/activities", { search: activitySearch.query, cursor })).then((page) => ({
        items: page.activities,
        nextCursor: page.nextCursor,
        total: page.total,
      })),
  });

  const contactCount = contacts.data ? contactPages.items.length : undefined;
  const contactState = growDataRegionState(contacts, contactCount);
  const relationshipCount = relationships.data ? relationshipPages.items.length : undefined;
  const relationshipState = growDataRegionState(relationships, relationshipCount);
  const activityCount = activities.data ? activityPages.items.length : undefined;
  const activityState = growDataRegionState(activities, activityCount);

  return (
    <div>
      <section className="card">
        <h2>Contacts</h2>
        <p className="muted">Search AE's canonical contacts. Open one to see Contact 360 — everything Grow knows about that relationship.</p>
        <GrowNewContactForm />
        <form
          className="grow-inline-form-row"
          onSubmit={(e) => {
            e.preventDefault();
            setCommittedSearch(search.trim());
          }}
        >
          <input
            type="search"
            placeholder="Search by name, organisation, or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search contacts"
          />
          <label className="grow-list-filter" htmlFor="grow-contacts-role">
            Role
            <select
              id="grow-contacts-role"
              value={role}
              onChange={(event) => {
                setRole(event.target.value);
                setCommittedSearch(search.trim());
              }}
            >
              <option value="">All roles</option>
              {GROW_CONTACT_ROLES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-secondary btn-small">
            Search
          </button>
        </form>

        {/* AE GROW Pilot Readiness WP6b (D6) — an explicit failed state with a
            Try again that refetches this region's own query, plus a distinct
            "nothing matched that search" vs "no contacts at all" empty state.
            The empty sentence is the current filter only: a later result
            replaces it instead of leaving it above the rows. */}
        <GrowDataRegionStatus
          key={`${committedSearch}\0${role}`}
          query={contacts}
          itemCount={contactCount}
          errorFallback="Couldn't load contacts."
          emptyMessage={contactsEmptyMessage(committedSearch, role)}
          onRetry={() => void contacts.refetch()}
        />
        {contactState === "ready" && (
          <GrowVirtualTable
            label="Contacts"
            singular="contact"
            plural="contacts"
            colSpan={5}
            resetKey={`${committedSearch}\0${role}`}
            items={contactPages.items}
            total={contactPages.total}
            getKey={(contact) => contact.id}
            renderCells={(contact) => <GrowContactCells contact={contact} />}
            hasMore={contactPages.hasMore}
            loadingMore={contactPages.loadingMore}
            moreError={contactPages.moreError}
            onLoadMore={contactPages.loadMore}
            head={
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Roles</th>
                <th>Properties</th>
                <th></th>
              </tr>
            }
          />
        )}
      </section>

      <section className="card">
        <h2>Relationships</h2>
        <p className="muted">Every person linked to a property, with why the link exists - never just an owner field.</p>
        <GrowListSearch
          id="grow-relationships-search"
          label="Search relationships"
          placeholder="Name, organisation, or address"
          text={relationshipSearch.text}
          onText={relationshipSearch.setText}
          onCommit={relationshipSearch.commit}
        />
        <GrowDataRegionStatus
          key={relationshipSearch.query}
          query={relationships}
          itemCount={relationshipCount}
          errorFallback="Couldn't load relationships."
          emptyMessage={listSearchEmptyMessage(relationshipSearch.query, "relationships", "No relationships yet.")}
          onRetry={() => void relationships.refetch()}
        />
        {relationshipState === "ready" && (
          <GrowVirtualTable
            label="Relationships"
            singular="relationship"
            plural="relationships"
            colSpan={5}
            resetKey={`relationships\0${relationshipSearch.query}`}
            items={relationshipPages.items}
            total={relationshipPages.total}
            getKey={(relationship) => relationship.id}
            renderCells={(relationship) => <GrowRelationshipCells relationship={relationship} />}
            hasMore={relationshipPages.hasMore}
            loadingMore={relationshipPages.loadingMore}
            moreError={relationshipPages.moreError}
            onLoadMore={relationshipPages.loadMore}
            head={
              <tr>
                <th>Person</th>
                <th>Property</th>
                <th>Type</th>
                <th>Role</th>
                <th>Status</th>
              </tr>
            }
          />
        )}
      </section>

      <section className="card">
        <h2>Recent activity</h2>
        <GrowListSearch
          id="grow-activities-search"
          label="Search activity"
          placeholder="Search summaries"
          text={activitySearch.text}
          onText={activitySearch.setText}
          onCommit={activitySearch.commit}
        />
        <GrowDataRegionStatus
          key={activitySearch.query}
          query={activities}
          itemCount={activityCount}
          errorFallback="Couldn't load recent activity."
          emptyMessage={listSearchEmptyMessage(activitySearch.query, "activities", "No activity logged yet.")}
          onRetry={() => void activities.refetch()}
        />
        {activityState === "ready" && (
          <GrowVirtualTimeline
            label="Recent activity"
            singular="activity"
            plural="activities"
            resetKey={`activities\0${activitySearch.query}`}
            items={activityPages.items}
            total={activityPages.total}
            getKey={(activity) => activity.id}
            renderItem={(activity) => <GrowActivityItem activity={activity} />}
            hasMore={activityPages.hasMore}
            loadingMore={activityPages.loadingMore}
            moreError={activityPages.moreError}
            onLoadMore={activityPages.loadMore}
          />
        )}
      </section>
    </div>
  );
}
