import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiErrorMessage, apiFetch } from "../lib/api";
import type { GrowTodaySummary } from "../lib/growToday";
import { formatGeneratedAt } from "../lib/growToday";
import { useEntitlements, useSession } from "../lib/session";
import { GROW_TODAY_PURPOSE, growTodayCrossLink, growTodayHeading } from "../lib/todaySurfaces";
import { formatMinimalHeaderDate } from "../lib/minimalUx";
import { buildMinimalTodayModel, type MinimalTodayCard } from "./minimalTodayModel";

// AE Minimal A Today. The list is GET /grow/today. Channel buttons and the
// prototype's side cards are not part of this screen.

export default function MinimalToday() {
  const { user } = useSession();
  const { hasEntitlement } = useEntitlements();
  const today = useQuery<GrowTodaySummary>({
    queryKey: ["grow-today"],
    queryFn: () => apiFetch("/grow/today"),
  });

  const dateLabel = formatMinimalHeaderDate(new Date());

  return (
    <div className="am-today" data-ae-today="minimal">
      <div className="am-welcome">
        <div>
          <div className="am-eyebrow">{dateLabel}</div>
          <h1>{growTodayHeading(user?.firstName)}</h1>
          <p>{GROW_TODAY_PURPOSE}</p>
        </div>
      </div>

      {today.isLoading ? <p className="am-empty-note">Loading today's priorities…</p> : null}
      {today.isError ? (
        <div className="am-rail-section" role="alert">
          <p className="am-switch-error">{apiErrorMessage(today.error, "Couldn't load Today.")}</p>
          <button type="button" className="am-classic-switch" onClick={() => void today.refetch()}>
            Try again
          </button>
        </div>
      ) : null}

      {today.data ? <TodayBody summary={today.data} hasEntitlement={hasEntitlement} /> : null}
    </div>
  );
}

function TodayBody({
  summary,
  hasEntitlement,
}: {
  summary: GrowTodaySummary;
  hasEntitlement: (key: string) => boolean;
}) {
  const model = buildMinimalTodayModel(summary, new Date(), hasEntitlement);
  return (
    <>
      <p className="am-empty-note">As of {formatGeneratedAt(summary.generatedAt)}.</p>
      {model.withholding ? <p className="am-empty-note">{model.withholding}</p> : null}
      {model.noGrowData ? (
        <section className="am-rail-section">
          <h2>Let's find your next opportunity</h2>
          <p className="am-empty-note">
            Grow turns every appraisal, buyer enquiry, and past client into a tracked relationship and a visible next
            action.
          </p>
          <Link href="/grow/import" className="am-primary-action">
            Import contacts and properties
          </Link>
        </section>
      ) : null}
      {model.setupSteps.length > 0 ? (
        <section className="am-rail-section" aria-label="Getting started">
          <div className="am-rail-heading">
            <h3>Getting started</h3>
          </div>
          <ul className="am-agenda">
            {model.setupSteps.map((step) => (
              <li key={step.id} className="am-agenda-row">
                <div className="am-time">To do</div>
                <div>
                  <div className="am-agenda-title">{step.title}</div>
                  <div className="am-agenda-sub">{step.hint}</div>
                </div>
                {step.href ? (
                  <Link href={step.href} className="am-row-open">
                    Import
                  </Link>
                ) : (
                  <span className="am-row-status is-pending">Classic view</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {model.caughtUp ? (
        <section className="am-rail-section">
          <p className="am-empty-note">You're all caught up — nothing needs your attention right now.</p>
        </section>
      ) : null}
      {model.hero ? (
        <div className="am-layout">
          <section className="am-primary" aria-label="Today's actions">
            <Hero card={model.hero} queueLabel={model.queueLabel} />
            {model.alsoOnYourDay.length > 0 ? (
              <>
                <div className="am-section-head">
                  <h3>Also on your day</h3>
                  <span>{model.agendaSummary}</span>
                </div>
                <div className="am-agenda" aria-label="Other priority actions">
                  {model.alsoOnYourDay.map((item) => (
                    <AgendaRow key={item.id} card={item} />
                  ))}
                </div>
              </>
            ) : null}
            {model.signals.length > 0 ? (
              <>
                <div className="am-section-head">
                  <h3>Signals</h3>
                  <span>{model.signals.length} on this read</span>
                </div>
                <div className="am-agenda" aria-label="Signals">
                  {model.signals.map((item) => (
                    <AgendaRow key={item.id} card={item} />
                  ))}
                </div>
              </>
            ) : null}
          </section>
          <aside className="am-right" aria-label="Today at a glance">
            <section className="am-rail-section">
              <div className="am-rail-heading">
                <h3>At a glance</h3>
                <span>Today</span>
              </div>
              {model.counts.map((count) => (
                <div className="am-metric-line" key={count.label}>
                  <div className="am-metric-label">
                    <i className="am-mini-dot" /> {count.label}
                  </div>
                  <span className="am-metric-number">{count.value}</span>
                </div>
              ))}
            </section>
            {model.signals.length > 0 ? (
              <section className="am-rail-section" aria-label="Signals to notice">
                <div className="am-rail-heading">
                  <h3>Signals to notice</h3>
                  <span>{model.signals.length}</span>
                </div>
                {model.signals.map((item) => (
                  <div className="am-signal" key={item.id}>
                    <div className="am-signal-title">{item.title}</div>
                    <p className="am-signal-copy">{item.whyItMatters ?? item.reason}</p>
                  </div>
                ))}
              </section>
            ) : null}
            {model.comingUp ? (
              <section className="am-rail-section">
                <div className="am-rail-heading">
                  <h3>Coming up</h3>
                  <span>{model.comingUp.kindLabel ?? "Appraisal"}</span>
                </div>
                <RecordLink card={model.comingUp} />
              </section>
            ) : null}
            <section className="am-rail-section">
              <div className="am-rail-heading">
                <h3>Property delivery</h3>
              </div>
              <Link href={growTodayCrossLink.href} className="am-appraisal-link">
                <div>
                  <div className="am-appraisal-name">{growTodayCrossLink.label}</div>
                  <div className="am-appraisal-time">{growTodayCrossLink.distinction}</div>
                </div>
              </Link>
            </section>
          </aside>
        </div>
      ) : null}
    </>
  );
}

function Hero({ card, queueLabel }: { card: MinimalTodayCard; queueLabel: string | null }) {
  return (
    <article className="am-next-card">
      <div className="am-card-kicker">
        <span className="am-kicker-leading">
          <span className="am-kicker-dot" /> Your next valuable action
        </span>
        {queueLabel ? <span className="am-queue">{queueLabel}</span> : null}
      </div>
      <div className="am-next-content">
        <div>
          <div className="am-person-line">
            <h2>{card.title}</h2>
            <span className="am-priority-pill">{card.priorityText}</span>
          </div>
          {card.propertyLabel ? <div className="am-property">{card.propertyLabel}</div> : null}
          {card.reason ? <p className="am-reason">{card.reason}</p> : null}
          {card.whyItMatters || card.nextStep ? (
            <div className="am-value-band">
              {card.whyItMatters ? (
                <div className="am-value-item">
                  <div className="am-value-label">Why it matters</div>
                  <div className="am-value-text">{card.whyItMatters}</div>
                </div>
              ) : null}
              {card.nextStep ? (
                <div className="am-value-item">
                  <div className="am-value-label">Next step</div>
                  <div className="am-value-text">{card.nextStep}</div>
                </div>
              ) : null}
            </div>
          ) : null}
          {card.rankLine ? <p className="am-empty-note">{card.rankLine}</p> : null}
          {card.unlinkedNote ? <p className="am-empty-note">{card.unlinkedNote}</p> : null}
          {card.contactabilityNote ? <p className="am-switch-error">{card.contactabilityNote}</p> : null}
        </div>
        <div className="am-action-box">
          <div className="am-action-label">Do this next</div>
          <div className={`am-call-time${card.overdue ? " is-overdue" : ""}`}>{card.whenLabel}</div>
          {card.nextStep ? <p className="am-empty-note">{card.nextStep}</p> : null}
          {card.destination ? (
            <Link href={card.destination.href} className="am-primary-action">
              {card.destination.label}
            </Link>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function AgendaRow({ card }: { card: MinimalTodayCard }) {
  return (
    <div className="am-agenda-row">
      <div className={`am-time${card.overdue ? " is-overdue" : ""}`}>{card.whenLabel}</div>
      <div>
        <div className="am-agenda-title">
          {card.kindLabel ? `${card.kindLabel} · ` : ""}
          {card.title}
        </div>
        <div className="am-agenda-sub">{[card.propertyLabel, card.nextStep].filter(Boolean).join(" · ")}</div>
      </div>
      {card.destination ? (
        <Link href={card.destination.href} className="am-row-open" aria-label={card.destination.label}>
          {card.destination.label}
        </Link>
      ) : (
        <span className={`am-row-status${card.priority === "KeepWarm" ? " is-pending" : ""}`}>{card.priorityText}</span>
      )}
    </div>
  );
}

function RecordLink({ card }: { card: MinimalTodayCard }) {
  const body = (
    <>
      <div>
        <div className="am-appraisal-name">{card.title}</div>
        <div className="am-appraisal-time">
          {[card.whenLabel, card.propertyLabel].filter(Boolean).join(" · ")}
        </div>
      </div>
    </>
  );
  if (!card.destination) return <div className="am-appraisal-link">{body}</div>;
  return (
    <Link href={card.destination.href} className="am-appraisal-link">
      {body}
    </Link>
  );
}
