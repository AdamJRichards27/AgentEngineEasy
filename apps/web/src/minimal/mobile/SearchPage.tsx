import "./mobile.css";
import { useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useEntitlements, useSession } from "../../lib/session";
import { MINIMAL_CONTACTS_FULL_HREF } from "../minimalGrowNav";
import { minimalHasRunAccess } from "../minimalNav";
import { mobilePermissions } from "./mobilePermissions";
import { cleanSearchQuery } from "./mobileSearchModel";
import { GROW_CONTACTS_MANAGE, MOBILE_SEARCH_ROUTE, PHONE_SEARCH_SUPPORTED, searchPlaceholder } from "./mobileSearchConfig";
import { buildSearchScreen } from "./mobileSearchScreen";
import { SearchPageView } from "./SearchPageView";
import { useMobileSearch } from "./useMobileSearch";

// AE Mobile (CC Task #64, M2): the /search page. The container: it reads the session's
// entitlements (display and request planning only; the API enforces every rule), runs the search
// hook, keeps the address in step as /search?q= (replaced, so one history entry), and hands plain
// props to SearchPageView. Not wired into any route until the wiring pull request is approved.

export default function SearchPage() {
  const { entitlements, isLoading } = useEntitlements();
  const { user } = useSession();
  const perms = mobilePermissions(isLoading ? null : entitlements, user?.role);
  const runAccess = minimalHasRunAccess(entitlements);
  const canAddContact = entitlements.includes(GROW_CONTACTS_MANAGE);

  const urlSearch = useSearch();
  const [, navigate] = useLocation();
  const urlQuery = new URLSearchParams(urlSearch).get("q") ?? "";

  const search = useMobileSearch({
    initialQuery: urlQuery,
    permissions: perms,
    phoneSearchSupported: PHONE_SEARCH_SUPPORTED,
  });

  useEffect(() => {
    const q = cleanSearchQuery(search.committed) ?? "";
    if (q === (cleanSearchQuery(urlQuery) ?? "")) return;
    navigate(q ? `${MOBILE_SEARCH_ROUTE}?q=${encodeURIComponent(q)}` : MOBILE_SEARCH_ROUTE, { replace: true });
  }, [search.committed, urlQuery, navigate]);

  const screen = buildSearchScreen({
    input: search.input,
    committed: search.committed,
    plan: search.plan,
    results: search.results,
    suggestions: search.suggestions,
    phoneSearchSupported: PHONE_SEARCH_SUPPORTED,
    canAddContact,
    canAddProperty: perms.searchProperties,
  });

  return (
    <SearchPageView
      input={search.input}
      placeholder={searchPlaceholder(PHONE_SEARCH_SUPPORTED)}
      screen={screen}
      addContactHref={MINIMAL_CONTACTS_FULL_HREF}
      addPropertyHref={runAccess ? "/properties/start" : "/properties"}
      onInput={search.setInput}
      onClear={() => search.setInput("")}
      onBack={() => (window.history.length > 1 ? window.history.back() : navigate("/grow"))}
      onRetry={search.retry}
      onOpen={search.remember}
    />
  );
}
