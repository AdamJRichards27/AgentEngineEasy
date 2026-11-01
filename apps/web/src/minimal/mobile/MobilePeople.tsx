import "./mobileStyles";
import "./mobilePeople.css";
import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { apiErrorMessage, apiFetch } from "../../lib/api";
import type { GrowContactListPage } from "../../lib/growContactList";
import { useEntitlements } from "../../lib/session";
import { MobileGrowSections } from "./MobileGrowSections";
import { MINIMAL_CONTACTS_FULL_HREF } from "../minimalGrowNav";
import { MobilePeopleView } from "./MobilePeopleView";
import { GROW_IMPORT_EXECUTE, MOBILE_PEOPLE_SHOWS_GROW_SECTIONS } from "./mobilePeopleConfig";
import { buildPeopleRows, normaliseSearchParam, peopleCountLine, peopleEmptyText, peoplePath, peopleTotal, roleOptions } from "./mobilePeopleLayout";
import { GROW_CONTACTS_MANAGE } from "./mobileSearchConfig";
import { SEARCH_DEBOUNCE_MS } from "./mobileSearchModel";

// AE Mobile (CC Task #64, M4): the phone People list. The container. One existing endpoint, GET /grow/contacts,
// paged by its own cursor. Its cache key starts with "grow-contacts", as the classic list's does, so every
// existing write that invalidates ["grow-contacts"] refreshes this list too; the second element, "mobile",
// keeps it a different key from the classic list's own. Sign-out clears it with every other non-session
// query. Not wired into any route until the wiring pull request is approved.

export default function MobilePeople() {
  const { hasEntitlement } = useEntitlements();
  const urlSearch = new URLSearchParams(useSearch()).get("search");
  const [input, setInput] = useState(normaliseSearchParam(urlSearch));
  const [committed, setCommitted] = useState(normaliseSearchParam(urlSearch));
  const [role, setRole] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setCommitted(normaliseSearchParam(input)), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  const list = useInfiniteQuery<GrowContactListPage, Error, { pages: GrowContactListPage[] }, [string, string, string, string], string | null>({
    queryKey: ["grow-contacts", "mobile", committed, role],
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) => apiFetch<GrowContactListPage>(peoplePath({ search: committed, role, cursor: pageParam }), { signal }),
    getNextPageParam: (last) => (typeof last.nextCursor === "string" && last.nextCursor.length > 0 ? last.nextCursor : null),
    staleTime: 30_000,
    retry: false,
  });

  const pages = list.data?.pages ?? [];
  const rows = buildPeopleRows(pages);
  const total = peopleTotal(pages, rows.length);
  const waiting = normaliseSearchParam(input) !== committed;

  return (
    <MobilePeopleView
      sectionsSlot={MOBILE_PEOPLE_SHOWS_GROW_SECTIONS ? <MobileGrowSections current="contacts" /> : null}
      search={input}
      role={role}
      roleOptions={roleOptions()}
      countLine={peopleCountLine(rows.length, total)}
      rows={rows}
      emptyText={list.isSuccess && !waiting && rows.length === 0 ? peopleEmptyText(committed, role) : null}
      loading={list.isLoading}
      error={list.isError ? { text: apiErrorMessage(list.error, "Couldn't load people."), onRetry: () => void list.refetch() } : null}
      canLoadMore={list.hasNextPage === true}
      loadingMore={list.isFetchingNextPage}
      addHref={hasEntitlement(GROW_CONTACTS_MANAGE) ? MINIMAL_CONTACTS_FULL_HREF : null}
      importHref={hasEntitlement(GROW_IMPORT_EXECUTE) ? "/grow/import" : null}
      onSearch={setInput}
      onRole={setRole}
      onLoadMore={() => void list.fetchNextPage()}
    />
  );
}
