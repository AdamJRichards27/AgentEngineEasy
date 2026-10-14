// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { Link, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import { AskAgentEngine } from "../components/AskAgentEngine";
import { ErrorBoundary } from "../components/ErrorBoundary";
import {
  applyGrowNavigation,
  canonicalGrowContactHref,
  growComposeChannelFromSearch,
  growContactIdFromPath,
  growContactPath,
  growNavigationMode,
  growTabHref,
  growTabLabel,
  growWorkspaceEntryState,
  isGrowContactPath,
  queueCanonicalGrowContactRedirect,
  GROW_TABS,
  type GrowTab,
} from "../lib/growWorkspace";
import { GrowContactDetail } from "./GrowContactDetail";
import { GrowContactList } from "./GrowContactList";
import { GrowOpportunitiesTab } from "./GrowOpportunitiesTab";
import { GrowToday } from "./GrowToday";
import type { GrowAccess } from "./types";

// Contact 360 is /grow/contacts/:id (App.tsx). The workspace reads that path
// on every render, so a refresh or a pasted link opens the same contact, and
// pushing the path is what makes the browser Back button return to the Grow
// view the agent was on. Older ?contact= links are rewritten to the path.
function currentGrowPath(): string {
  return typeof window === "undefined" ? "/grow" : window.location.pathname;
}
export function GrowWorkspace() {
  const search = useSearch();
  const path = currentGrowPath();
  const routedContactId = growContactIdFromPath(path);
  const invalidContactPath = isGrowContactPath(path) && routedContactId === null;
  const entry = growWorkspaceEntryState(search);
  // A legacy ?contact= link still names a contact until the address bar is
  // rewritten. An invalid /grow/contacts/:id does not fall through to it.
  const legacyContactId = invalidContactPath || routedContactId !== null ? null : entry.contactPartyId;
  const contactPartyId = routedContactId ?? legacyContactId;
  const tab: GrowTab = contactPartyId !== null || invalidContactPath ? "contacts" : entry.tab;
  // Email/SMS from Grow Today open the composer via ?compose=, which survives
  // the route change. Contact 360 clears it once the composer has started.
  const pendingComposeChannel = contactPartyId !== null ? growComposeChannelFromSearch(search) : null;

  const legacyHref = canonicalGrowContactHref(path, search);
  if (legacyHref !== null) queueCanonicalGrowContactRedirect(legacyHref);

  function openContact(partyId: number, compose?: "EMAIL" | "SMS") {
    applyGrowNavigation(window.history, growContactPath(partyId, compose), "push");
  }

  function viewContact(partyId: number) {
    openContact(partyId);
  }

  function emailContact(partyId: number) {
    openContact(partyId, "EMAIL");
  }

  function smsContact(partyId: number) {
    openContact(partyId, "SMS");
  }

  function backToContacts() {
    applyGrowNavigation(window.history, growTabHref("contacts"), "push");
  }

  // Clicking a tab goes to that tab's own landing view. From Contact 360 that
  // is a new history entry, so Back returns to the contact. From another tab
  // it replaces the current Grow address, so tab clicks do not pile up.
  function selectTab(next: GrowTab) {
    applyGrowNavigation(window.history, growTabHref(next), growNavigationMode(currentGrowPath()));
  }

  function onComposeHandled() {
    if (contactPartyId === null || pendingComposeChannel === null) return;
    applyGrowNavigation(window.history, growContactPath(contactPartyId), "replace");
  }

  // Re-uses the "grow-access" query the outer Grow() component already fetched (react-query
  // dedupes by key, so this is not a second network request) purely to read
  // billingProviderName for the sandbox-billing note below.
  const access = useQuery<GrowAccess>({
    queryKey: ["grow-access"],
    queryFn: () => apiFetch("/grow/access"),
  });

  return (
    <div>
      <h1>Grow</h1>
      <p className="muted">
        <Link href="/grow/import">Import contacts &amp; properties &rarr;</Link>
      </p>
      {access.data?.billingProviderName === "mock" && (
        <p className="muted pilot-mode-note">Sandbox billing is active — no real charge or subscription exists behind this workspace.</p>
      )}

      <nav className="pc-tabs grow-tabs" aria-label="Grow sections">
        {GROW_TABS.flatMap((t) => {
          const tabButton = (
            <button
              key={t.key}
              type="button"
              className={`pc-tab${tab === t.key ? " active" : ""}`}
              aria-current={tab === t.key ? "page" : undefined}
              onClick={() => selectTab(t.key)}
            >
              {t.label}
            </button>
          );
          if (t.key !== "opportunities") return [tabButton];
          return [
            tabButton,
            <Link key="appraisals" href="/grow/appraisals" className="pc-tab">
              Appraisals
            </Link>,
          ];
        })}
      </nav>

      {/* AE GROW Pilot Readiness WP5 — one failing tab shows a contained
          fallback; the tab bar above stays usable and switching tab resets it. */}
      <ErrorBoundary label={`the ${growTabLabel(tab)} tab`} resetKey={tab}>
        {tab === "today" && (
          <GrowToday
            onAskAE={() => selectTab("askAE")}
            onViewContact={viewContact}
            onEmailContact={emailContact}
            onSmsContact={smsContact}
            onOpenSection={selectTab}
          />
        )}
        {/* E-3: the same contact jump and Ask AE tab switch Grow Today already
            uses. Not a second navigation mechanism. */}
        {tab === "opportunities" && (
          <GrowOpportunitiesTab onViewContact={viewContact} onAskAE={() => selectTab("askAE")} />
        )}
        {tab === "contacts" && invalidContactPath && <GrowMissingContact onBack={backToContacts} />}
        {tab === "contacts" && !invalidContactPath && (
          <GrowContactsTab
            selectedPartyId={contactPartyId}
            onBack={backToContacts}
            pendingComposeChannel={pendingComposeChannel}
            onComposeHandled={onComposeHandled}
          />
        )}
        {tab === "nurture" && (
          <GrowComingSoon
            title="Nurture"
            description="Automated nurture sequences and campaigns are planned for a future Grow release. Nothing here is active yet."
          />
        )}
        {tab === "performance" && <GrowBusinessCoachTab />}
        {tab === "askAE" && <GrowAskAETab />}
      </ErrorBoundary>
    </div>
  );
}
function GrowComingSoon({ title, description }: { title: string; description: string }) {
  return (
    <section className="card grow-coming-soon">
      <h2>{title}</h2>
      <p className="muted">{description}</p>
      <span className="pill">Coming soon</span>
    </section>
  );
}
// AE GROW Pilot Readiness WP6b (P3-a): the "Voice command — coming soon" seam card that used to
// sit below AskAgentEngine here has been removed. It was Priority 1's placeholder for an entry
// point Stage E then actually shipped — the real, working mic control now lives inside
// AskAgentEngine itself (see its Stage E header comment), so the card was telling the agent that
// the control they had just successfully used did not exist yet. Nothing replaces it: voice is
// part of Ask AE's own input row, not a separate surface.
// AE GROW Priority 6 Stage B: AskAgentEngine now gets contextType="grow" here (previously
// "business" - the Grow tab's Ask AE was never actually Grow-scoped before this stage, despite
// living on this page). AskAgentEngine itself required no changes to accept this beyond its own
// Stage B extension (see that component's header comment) - it is still the exact same shared
// component, not a second Ask AE surface.
function GrowAskAETab() {
  return <AskAgentEngine contextType="grow" contextId={null} />;
}
// AE GROW Priority 6 Stage C — AI Business Coach. Replaces this tab's
// previous GrowComingSoon placeholder with the real thing: the same shared
// AskAgentEngine component GrowAskAETab (above) already uses, switched into
// mode="coach" rather than a second, bespoke coaching surface. Read-only
// analysis only, per the Stage C authorisation - AskAgentEngine's coach
// rendering never offers a button that implies AE will carry out an
// action, only questions about the agent's own already-recorded Grow data.
function GrowBusinessCoachTab() {
  return <AskAgentEngine contextType="grow" contextId={null} mode="coach" />;
}
// AE GROW Priority 2 §11 — Contact 360. Replaces Priority 1's flat, read-only stand-in (a plain
// relationships table + activity feed — see Priority 1's own completion report, which explicitly
// deferred "a dedicated View Contact screen" to a future priority) with the real thing: a
// searchable contact list, and a per-contact detail view built to answer "who is this person,
// what are they connected to, and what should I do next" in one screen. `selectedPartyId` is
// owned by GrowWorkspace (not local state here) purely so a Grow Today card's "View Contact"
// button can open this tab directly into a contact's detail rather than its list — see
// GrowWorkspace.viewContact.
function GrowContactsTab({
  selectedPartyId,
  onBack,
  pendingComposeChannel,
  onComposeHandled,
}: {
  selectedPartyId: number | null;
  onBack: () => void;
  // AE GROW Priority 3 §4 — threaded straight through to GrowContactDetail's own
  // ContactCommunicationsSection; see GrowWorkspace.pendingComposeChannel.
  pendingComposeChannel: "EMAIL" | "SMS" | null;
  onComposeHandled: () => void;
}) {
  // AE GROW Pilot Readiness WP5 — Contact 360 gets its own boundary so a
  // failing contact detail offers "Back to contacts" (and resets when a
  // different contact, or the list, is shown) without losing the Grow tabs.
  return (
    <ErrorBoundary
      label={selectedPartyId !== null ? "Contact 360" : "contacts"}
      resetKey={selectedPartyId}
      secondaryAction={selectedPartyId !== null ? { label: "Back to contacts", onClick: onBack } : undefined}
    >
      {selectedPartyId !== null ? (
        <GrowContactDetail
          partyId={selectedPartyId}
          onBack={onBack}
          pendingComposeChannel={pendingComposeChannel}
          onComposeHandled={onComposeHandled}
        />
      ) : (
        <GrowContactList />
      )}
    </ErrorBoundary>
  );
}
// A /grow/contacts/:id that is not a contact id. A real id the agent cannot
// see is handled by Contact 360's own request (404, same sentence).
function GrowMissingContact({ onBack }: { onBack: () => void }) {
  return (
    <div>
      <button type="button" className="btn btn-link btn-small" onClick={onBack}>
        &larr; Back to contacts
      </button>
      <p className="error-text" role="alert">
        That couldn't be found — it may have been removed.
      </p>
    </div>
  );
}
