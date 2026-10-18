// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import { useSession, useEntitlements } from "../lib/session";
// AE GROW Pilot Readiness WP6b (D6) — the shared loading/failed/empty region
// presentation, and the pure state logic behind it and the tab bar.
import { GrowDataRegionStatus } from "../components/GrowDataRegion";
import {
  type GrowTodayFirstRun,
  type GrowTodaySummary,
  formatGeneratedAt,
  signalWithholdingNotice,
} from "../lib/growToday";
import { growFirstRunIncomplete, growFirstRunSteps, type GrowFirstRunSection } from "../lib/growFirstRun";
import { TodaySurfaceCrossLink } from "../components/TodaySurfaceCrossLink";
import {
  GROW_TODAY_EYEBROW,
  GROW_TODAY_PURPOSE,
  growTodayCrossLink,
  growTodayHeading,
} from "../lib/todaySurfaces";
import { DUE_TODAY_COUNT_HINT, DUE_TODAY_COUNT_LABEL } from "../lib/growTerms";
import { GrowActionCard } from "./GrowActionCard";
import { StatTile } from "./StatTile";

// AE GROW Priority 1 — Grow Today. Relationships, follow-ups, and opportunities
// (GET /grow/today). This is not the RUN Command Centre at /today. The name,
// purpose line, and cross-link are lib/todaySurfaces.ts. The screen this
// priority actually exists to build:
// a small set of headline indicators (never vanity metrics -- each one is a real, countable
// thing on this brokerage's own Grow data) plus a deterministically-prioritised action feed, each
// item explaining, in plain language, why AE is surfacing it (see
// apps/api/src/lib/growToday.ts's own header comment for the full rule set -- nothing here is
// predictive scoring). One request (GET /grow/today) renders this whole tab.
//
// AE GROW Priority 2 §12: gained one new prop (onViewContact) so a card's contact can open
// directly into Contact 360 — see GrowWorkspace.viewContact above. No other change to this
// component or to the /grow/today contract it consumes.
//
// AE GROW Priority 3 §4: gained two more (onEmailContact/onSmsContact), the same "route into
// Contact 360" precedent as onViewContact — see GrowWorkspace.emailContact/smsContact. Still no
// change to the /grow/today contract or to this component's own ranking/filtering logic; the
// only new read is the contactEmail/contactMobile/availableActions fields growToday.ts's types
// already carry.
// Exported so the E-2 behavior test can render this feed directly. The page
// still mounts it only from GrowWorkspace.
export function GrowToday({
  onAskAE,
  onViewContact,
  onEmailContact,
  onSmsContact,
  onOpenSection,
}: {
  onAskAE: () => void;
  onViewContact: (partyId: number) => void;
  onEmailContact: (partyId: number) => void;
  onSmsContact: (partyId: number) => void;
  onOpenSection?: (section: GrowFirstRunSection) => void;
}) {
  const { user } = useSession();
  const { hasEntitlement } = useEntitlements();

  const today = useQuery<GrowTodaySummary>({
    queryKey: ["grow-today"],
    queryFn: () => apiFetch("/grow/today"),
  });

  const canAddNote = hasEntitlement("grow.activities.manage");
  const canManageOpportunities = hasEntitlement("grow.opportunities.manage");
  const canViewContacts = hasEntitlement("grow.contacts.read");
  // AE GROW Priority 3 §4: Email/SMS action buttons start a contact-first communication thread
  // (POST /grow/contacts/:partyId/communications/threads), which the server gates on
  // grow.contacts.manage — see routes/communications.ts's own header comment. Gating the buttons
  // on the same entitlement here keeps a button that would just 403 from ever being shown.
  const canManageContactComms = hasEntitlement("grow.contacts.manage");

  // G-3: the relationship to the RUN Command Centre stays visible while this
  // feed is loading or has failed. The feed itself is still GET /grow/today.
  const data = today.data;
  const feedReady = !today.isLoading && !today.isError && !!data;
  const doNow = data ? data.priorityActions.filter((a) => a.priority === "DoNow") : [];
  const doToday = data ? data.priorityActions.filter((a) => a.priority === "DoToday") : [];
  const keepWarm = data ? data.priorityActions.filter((a) => a.priority === "KeepWarm") : [];

  return (
    <div>
      <div className="primary-action">
        <div className="eyebrow">{GROW_TODAY_EYEBROW}</div>
        <h2>{growTodayHeading(user?.firstName)}</h2>
        <p className="muted">{GROW_TODAY_PURPOSE}</p>
        {data ? <p className="muted">As of {formatGeneratedAt(data.generatedAt)}.</p> : null}
        <TodaySurfaceCrossLink link={growTodayCrossLink} />
      </div>

      {/* AE GROW Completion W2-B (G-4) — Today had an error branch already, but it
          was a bare sentence with no way out: an agent whose session had just expired
          saw one line of red and had to reload the whole app. It now uses the same
          region presentation (message + support reference + Try again) the four
          regions on the Contacts and Opportunities tabs have had since WP6b. */}
      {!feedReady || !data ? (
        <GrowDataRegionStatus
          query={today}
          itemCount={undefined}
          loadingMessage="Loading today's priorities…"
          errorFallback="Couldn't load Today."
          emptyMessage="Nothing to show yet."
          onRetry={() => void today.refetch()}
        />
      ) : (
        <>
      <div className="stat-tiles">
        <StatTile label="Priority Actions" value={data.counts.priorityActions} />
        <StatTile label={DUE_TODAY_COUNT_LABEL} value={data.counts.followUpsDue} hint={DUE_TODAY_COUNT_HINT} />
        <StatTile label="Open Opportunities" value={data.counts.openOpportunities} />
        <StatTile label="Contacts Needing Attention" value={data.counts.contactsNeedingAttention} />
      </div>
      <p className="muted">{DUE_TODAY_COUNT_HINT}</p>

      {/* AE GROW Signal Sweep stage 3: Today must be honest about what it is
          NOT showing. An Emerging signal held back by the daily cap, or a
          signal withheld because its contact must not be contacted, is
          reported as a count here rather than silently vanishing. */}
      {signalWithholdingNotice(data.signalSummary) && (
        <p className="muted grow-signal-withholding-notice">{signalWithholdingNotice(data.signalSummary)}</p>
      )}

      {!data.hasAnyGrowData ? (
        <section className="card">
          <h2>Let's find your next opportunity</h2>
          <p className="muted">
            Grow turns every appraisal, buyer enquiry, and past client into a tracked relationship and a visible
            next action. Get started:
          </p>
          <div className="grow-empty-actions">
            <Link href="/grow/import" className="btn btn-primary btn-small">
              Import contacts &amp; properties
            </Link>
          </div>
        </section>
      ) : null}

      {data.firstRun && growFirstRunIncomplete(data.firstRun) ? (
        <GrowFirstRunChecklist
          flags={data.firstRun}
          hasEntitlement={hasEntitlement}
          onOpenSection={onOpenSection ?? (() => {})}
        />
      ) : null}

      {!data.hasAnyGrowData ? null : data.priorityActions.length === 0 ? (
        <section className="card">
          <p className="empty-state">You're all caught up — nothing needs your attention right now.</p>
        </section>
      ) : (
        <>
          {doNow.length > 0 && (
            <section className="card">
              <h2>Do Now ({doNow.length})</h2>
              <ul className="item-list grow-action-list">
                {doNow.map((item) => (
                  <GrowActionCard
                    key={item.id}
                    item={item}
                    canAddNote={canAddNote}
                    canManageOpportunities={canManageOpportunities}
                    canViewContacts={canViewContacts}
                    canManageContactComms={canManageContactComms}
                    onAskAE={onAskAE}
                    onViewContact={onViewContact}
                    onEmailContact={onEmailContact}
                    onSmsContact={onSmsContact}
                  />
                ))}
              </ul>
            </section>
          )}

          {doToday.length > 0 && (
            <section className="card">
              <h2>Do Today ({doToday.length})</h2>
              <ul className="item-list grow-action-list">
                {doToday.map((item) => (
                  <GrowActionCard
                    key={item.id}
                    item={item}
                    canAddNote={canAddNote}
                    canManageOpportunities={canManageOpportunities}
                    canViewContacts={canViewContacts}
                    canManageContactComms={canManageContactComms}
                    onAskAE={onAskAE}
                    onViewContact={onViewContact}
                    onEmailContact={onEmailContact}
                    onSmsContact={onSmsContact}
                  />
                ))}
              </ul>
            </section>
          )}

          {keepWarm.length > 0 && (
            <details className="section" open={doNow.length === 0 && doToday.length === 0}>
              <summary>Keep Warm ({keepWarm.length})</summary>
              <ul className="item-list grow-action-list">
                {keepWarm.map((item) => (
                  <GrowActionCard
                    key={item.id}
                    item={item}
                    canAddNote={canAddNote}
                    canManageOpportunities={canManageOpportunities}
                    canViewContacts={canViewContacts}
                    canManageContactComms={canManageContactComms}
                    onAskAE={onAskAE}
                    onViewContact={onViewContact}
                    onEmailContact={onEmailContact}
                    onSmsContact={onSmsContact}
                  />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
        </>
      )}
    </div>
  );
}
// G-UAT-7 — Getting started. Done/not-done is the Today payload's firstRun
// block. Hide and show is component state only: nothing is written.
function GrowFirstRunChecklist({
  flags,
  hasEntitlement,
  onOpenSection,
}: {
  flags: GrowTodayFirstRun;
  hasEntitlement: (key: string) => boolean;
  onOpenSection: (section: GrowFirstRunSection) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const steps = growFirstRunSteps(flags, hasEntitlement);
  const doneCount = steps.filter((step) => step.done).length;

  return (
    <section className="card grow-first-run" aria-label="Getting started">
      <div className="grow-first-run-header">
        <div>
          <h2>Getting started</h2>
          <p className="muted">
            {doneCount} of {steps.length} done
          </p>
        </div>
        <button type="button" className="btn btn-link btn-small" onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? "Show checklist" : "Hide checklist"}
        </button>
      </div>
      {collapsed ? null : (
        <ul className="grow-first-run-list">
          {steps.map((step) => (
            <li key={step.id} id={`grow-first-run-${step.id}`} className="grow-first-run-step">
              <div>
                <strong>{step.title}</strong>
                <p className="muted">{step.hint}</p>
              </div>
              <span className={`pill grow-first-run-status${step.done ? " pill-success" : ""}`}>{step.done ? "Done" : "Not done"}</span>
              {!step.done && !step.available ? <span className="muted">Not available</span> : null}
              {!step.done && step.available ? (
                <div className="grow-empty-actions">
                  {step.actionLabel ? (
                    <button type="button" className="btn btn-secondary btn-small" onClick={() => onOpenSection(step.section)}>
                      {step.actionLabel}
                    </button>
                  ) : null}
                  {step.importHref ? (
                    <Link href={step.importHref} className="btn btn-link btn-small">
                      Import contacts
                    </Link>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
