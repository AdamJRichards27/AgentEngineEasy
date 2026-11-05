import { Link } from "wouter";
import { MobilePersonRow } from "./MobilePersonRow";
import { MobilePropertyRow } from "./MobilePropertyRow";
import { MobileSection } from "./MobileSection";
import type { SearchScreen, SearchSuggestion } from "./mobileSearchScreen";

// AE Mobile (CC Task #64, M2): the phone Search screen. Presentational: no hooks, no network.
// SearchPage supplies the data and the handlers. One field, one status line, then either the
// suggestions or the People and Properties groups. Every row is one tap target.

export interface SearchPageViewProps {
  input: string;
  placeholder: string;
  screen: SearchScreen;
  addContactHref: string;
  addPropertyHref: string;
  onInput: (text: string) => void;
  onClear: () => void;
  onBack: () => void;
  onRetry: () => void;
  /** A result was opened. The container remembers it for "Opened recently". */
  onOpen: (item: SearchSuggestion) => void;
}

function SuggestionRows({ items, onOpen }: { items: SearchSuggestion[]; onOpen: (item: SearchSuggestion) => void }) {
  return (
    <div className="mob-list">
      {items.map((item) => (
        <Link key={item.key} href={item.href} className="mob-row" onClick={() => onOpen(item)}>
          <span className="mob-row-main">
            <span className="mob-row-title">{item.title}</span>
            {item.subtitle ? <span className="mob-row-sub">{item.subtitle}</span> : null}
          </span>
        </Link>
      ))}
    </div>
  );
}

export function SearchPageView(p: SearchPageViewProps) {
  const { screen } = p;
  return (
    <div className="mob-search" data-ae-search="mobile">
      <h1 className="am-sr-only">Search</h1>
      <div className="mob-search-head">
        <button type="button" className="mob-icon-btn" aria-label="Back" onClick={p.onBack}>
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <div className="mob-search-field">
          <input
            type="search"
            className="mob-input"
            aria-label="Search people or properties"
            placeholder={p.placeholder}
            autoComplete="off"
            autoFocus
            value={p.input}
            onChange={(event: { target: { value: string } }) => p.onInput(event.target.value)}
          />
          {p.input.length > 0 ? (
            <button type="button" className="mob-icon-btn mob-clear" aria-label="Clear search" onClick={p.onClear}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      <p className="mob-status" role="status" aria-live="polite">
        {screen.statusLine}
      </p>

      {screen.mode === "suggestions" ? (
        <div className="mob-search-body">
          {screen.suggestions.today.length > 0 ? (
            <MobileSection title="On your list today">
              <SuggestionRows items={screen.suggestions.today} onOpen={p.onOpen} />
            </MobileSection>
          ) : null}
          {screen.suggestions.recent.length > 0 ? (
            <MobileSection title="Opened recently">
              <SuggestionRows items={screen.suggestions.recent} onOpen={p.onOpen} />
            </MobileSection>
          ) : null}
          <p className="mob-hint">{screen.hintLine}</p>
        </div>
      ) : null}

      {screen.mode !== "suggestions" ? (
        <div className="mob-search-body">
          {screen.groups.map((group) => (
            <MobileSection key={group.key} title={group.title}>
              <div className="mob-list">
                {group.people.map((person) => (
                  <MobilePersonRow key={person.id} person={person} onOpen={() => p.onOpen({ key: `person-${person.id}`, title: person.title, subtitle: "Person", href: person.href })} />
                ))}
                {group.properties.map((property) => (
                  <MobilePropertyRow key={property.id} property={property} onOpen={() => p.onOpen({ key: `property-${property.id}`, title: property.address, subtitle: "Property", href: property.href })} />
                ))}
              </div>
              {group.overflow ? <p className="mob-note">{group.overflow}</p> : null}
            </MobileSection>
          ))}
          {screen.showTryAgain ? (
            <button type="button" className="mob-button" onClick={p.onRetry}>
              Try again
            </button>
          ) : null}
          {screen.emptyActions.addContact || screen.emptyActions.addProperty ? (
            <div className="mob-actions">
              {screen.emptyActions.addContact ? (
                <Link href={p.addContactHref} className="mob-button">
                  Add a contact
                </Link>
              ) : null}
              {screen.emptyActions.addProperty ? (
                <Link href={p.addPropertyHref} className="mob-button">
                  Add a property
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
