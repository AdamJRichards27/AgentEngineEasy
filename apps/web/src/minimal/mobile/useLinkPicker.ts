import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import type { GrowContactListPage } from "../../lib/growContactList";
import { LINK_PICKER_ROWS } from "./mobileLinkingConfig";
import type { MobilePermissions } from "./mobilePermissions";
import { PHONE_SEARCH_SUPPORTED } from "./mobileSearchConfig";
import { SEARCH_DEBOUNCE_MS, buildSearchResults, legOutcomeFromError, mobileSearchOptions, planSearch } from "./mobileSearchModel";
import { outcomeOf } from "./mobileSearchScreen";

// AE Mobile (CC Task #64, M4 linking): the search behind "Link a property" and "Link a contact". It is the M2 search, narrowed
// to ONE source by the model's own `only` option, so it sends one existing request, GET /properties?q= or
// GET /grow/contacts?search=, planned and read by the same model the Search screen uses. Only what the authorised
// backend returns is ever listed; nothing is added from the client. Nothing is requested until the picker is open.

export interface PickerRow {
  id: number;
  title: string;
  subtitle: string;
}

export function useLinkPicker(kind: "properties" | "contacts", permissions: MobilePermissions, active: boolean) {
  const [input, setInput] = useState("");
  const [committed, setCommitted] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setCommitted(input), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  const plan = useMemo(
    () => planSearch(active ? committed : "", mobileSearchOptions(permissions, { only: kind, phoneSearchSupported: PHONE_SEARCH_SUPPORTED })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, committed, kind, permissions.searchContacts, permissions.searchProperties, permissions.run],
  );
  const contactsPath = plan.contacts?.path ?? null;
  const propertiesPath = plan.properties?.path ?? null;

  const contacts = useQuery<GrowContactListPage>({
    queryKey: ["mobile-link-picker", "contacts", contactsPath],
    queryFn: ({ signal }) => apiFetch<GrowContactListPage>(contactsPath as string, { signal }),
    enabled: contactsPath !== null,
    staleTime: 30_000,
    retry: false,
  });
  const properties = useQuery<{ properties: unknown[] }>({
    queryKey: ["mobile-link-picker", "properties", propertiesPath],
    queryFn: ({ signal }) => apiFetch<{ properties: unknown[] }>(propertiesPath as string, { signal }),
    enabled: propertiesPath !== null,
    staleTime: 30_000,
    retry: false,
  });

  const results = buildSearchResults({
    plan,
    contacts: outcomeOf(plan.contacts !== null, contacts, legOutcomeFromError),
    properties: outcomeOf(plan.properties !== null, properties, legOutcomeFromError),
  });

  const rows: PickerRow[] =
    kind === "properties"
      ? (results.properties?.items ?? []).slice(0, LINK_PICKER_ROWS).map((p) => ({ id: p.id, title: p.address, subtitle: p.location }))
      : (results.people?.items ?? []).slice(0, LINK_PICKER_ROWS).map((p) => ({ id: p.id, title: p.title, subtitle: p.contactLine }));
  const waiting = input.trim() !== committed.trim();

  return {
    input,
    setInput,
    rows,
    loading: waiting || results.state === "loading",
    // A short query, no results, or a failed search each say so in the model's own words.
    message: waiting || results.state === "idle" || results.state === "results" || results.state === "loading" ? null : results.message,
    reset: () => {
      setInput("");
      setCommitted("");
    },
  };
}
