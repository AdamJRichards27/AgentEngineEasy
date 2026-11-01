import { Link } from "wouter";
import { roleLabel } from "./mobileLabels";

// AE Mobile (CC Task #64, M2): one person on a phone list or in search. Presentational: no hooks,
// no network. The whole row is the one tap target. Designed here and reused by the People list in M4.

export interface MobilePersonRowData {
  id: number;
  href: string;
  title: string;
  initials: string;
  contactLine: string;
  roleChips: readonly string[];
  /** What a search matched, when it was not the name. Display only. */
  matchedOn?: "name" | "email" | "phone" | null;
}

export function matchNote(matchedOn: MobilePersonRowData["matchedOn"]): string | null {
  if (matchedOn === "email") return "Matched on email";
  if (matchedOn === "phone") return "Matched on mobile";
  return null;
}

export function MobilePersonRow({ person, onOpen }: { person: MobilePersonRowData; onOpen?: () => void }) {
  const first = person.roleChips[0];
  const extra = person.roleChips.length - 1;
  const note = matchNote(person.matchedOn);
  return (
    <Link href={person.href} className="mob-row" onClick={onOpen}>
      <span className="mob-avatar" aria-hidden="true">
        {person.initials}
      </span>
      <span className="mob-row-main">
        <span className="mob-row-title">{person.title}</span>
        <span className="mob-row-sub">{person.contactLine}</span>
        {note ? <span className="mob-row-note">{note}</span> : null}
      </span>
      {first ? (
        <span className="mob-row-meta">
          <span className="mob-chip">{roleLabel(first)}</span>
          {extra > 0 ? <span className="mob-row-more">+{extra}</span> : null}
        </span>
      ) : null}
    </Link>
  );
}
