import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import type { GrowContactListPage } from "../../lib/growContactList";
import type { GrowTodaySummary } from "../../lib/growToday";
import type { MobilePermissions } from "./mobilePermissions";
import { SEARCH_DEBOUNCE_MS, buildSearchResults, legOutcomeFromError, mobileSearchOptions, planSearch } from "./mobileSearchModel";
import { RECENT_KEY } from "./mobileSearchConfig";
import { addRecent, outcomeOf, todaySuggestions, type SearchSuggestion, type SearchSuggestions } from "./mobileSearchScreen";

// AE Mobile (CC Task #64, M2): the Search screen's data hook. It sends only the requests the M1
// plan describes, through apiFetch, and nothing else. Existing endpoints only:
//   GET /grow/contacts?search=&limit=   GET /properties?q=
// Tenancy and permissions come from the session on the server; no request carries an id,
// brokerage or role. Cancelling and out-of-order answers are handled by react-query: each search is
// its own query key, an older key's result is never shown, and a replaced request is aborted.
// Cache keys start with "mobile-search" so they never touch the Contacts or Properties list caches,
// and sign-out removes them with every other non-session query.

export interface UseMobileSearchInput {
  initialQuery: string;
  /** From mobilePermissions(entitlements, role): the only source of what may be searched. */
  permissions: MobilePermissions;
  phoneSearchSupported: boolean;
}

interface PropertiesPayload {
  properties: unknown[];
}

const TODAY_KEY = ["grow-today"] as const;

export function useMobileSearch(opts: UseMobileSearchInput) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState(opts.initialQuery);
  const [committed, setCommitted] = useState(opts.initialQuery);

  useEffect(() => {
    const timer = setTimeout(() => setCommitted(input), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  const plan = useMemo(
    () =>
      planSearch(committed, mobileSearchOptions(opts.permissions, { phoneSearchSupported: opts.phoneSearchSupported })),
    // The options are rebuilt only when what they carry changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [committed, opts.permissions.searchContacts, opts.permissions.searchProperties, opts.permissions.run, opts.phoneSearchSupported],
  );

  const contactsPath = plan.contacts?.path ?? null;
  const propertiesPath = plan.properties?.path ?? null;

  const contacts = useQuery<GrowContactListPage>({
    queryKey: ["mobile-search", "contacts", contactsPath],
    queryFn: ({ signal }) => apiFetch<GrowContactListPage>(contactsPath as string, { signal }),
    enabled: contactsPath !== null,
    staleTime: 30_000,
    retry: false,
  });
  const properties = useQuery<PropertiesPayload>({
    queryKey: ["mobile-search", "properties", propertiesPath],
    queryFn: ({ signal }) => apiFetch<PropertiesPayload>(propertiesPath as string, { signal }),
    enabled: propertiesPath !== null,
    staleTime: 30_000,
    retry: false,
  });

  const results = buildSearchResults({
    plan,
    contacts: outcomeOf(plan.contacts !== null, contacts, legOutcomeFromError),
    properties: outcomeOf(plan.properties !== null, properties, legOutcomeFromError),
  });

  // "Opened recently": held in the query cache, so sign-out clears it with everything else.
  // Nothing is written to browser storage.
  const recent = useQuery<SearchSuggestion[]>({
    queryKey: RECENT_KEY,
    queryFn: () => [],
    initialData: [],
    staleTime: Infinity,
  });
  const suggestions: SearchSuggestions = {
    today: todaySuggestions(queryClient.getQueryData<GrowTodaySummary>(TODAY_KEY)),
    recent: recent.data ?? [],
  };

  return {
    input,
    setInput,
    committed,
    plan,
    results,
    suggestions,
    remember: (item: SearchSuggestion) => {
      queryClient.setQueryData<SearchSuggestion[]>(RECENT_KEY, (old) => addRecent(old ?? [], item));
    },
    retry: () => {
      if (contacts.status === "error") void contacts.refetch();
      if (properties.status === "error") void properties.refetch();
    },
  };
}
