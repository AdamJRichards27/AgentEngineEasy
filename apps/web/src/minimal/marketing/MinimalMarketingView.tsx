import { Link } from "wouter";
import {
  MARKETING_CHANNEL_COPY,
  MARKETING_PAGE_LABEL,
  MARKETING_PREVIEW_NOTE,
  MARKETING_SAMPLE_NOTICE,
  MARKETING_UNAVAILABLE_NOTICE,
  betterMarketingIdeas,
  marketingChannelTabs,
  marketingHref,
  marketingOverviewSample,
  socialSampleAccounts,
  type MarketingChannel,
  type MarketingPage,
  type MarketingTab,
} from "./minimalMarketingModel";

// AE Minimal v1.0 V7 Marketing pages. Presentational only: no hooks, no
// network, no send/schedule/publish handler. The primary action on every page
// is a disabled button with its reason; Better Marketing ideas open a local
// preview of fictional sample copy.

export interface MinimalMarketingViewProps {
  page: MarketingPage;
  tab: MarketingTab;
  previewId: string | null;
  on: {
    selectTab: (tab: MarketingTab) => void;
    preview: (id: string) => void;
    closePreview: () => void;
  };
}

const UNAVAILABLE_ID = "am-mk-unavailable";

export function MinimalMarketingView(p: MinimalMarketingViewProps) {
  return (
    <div className="am-mk" data-ae-marketing={p.page}>
      <p className="am-mk-notice" role="note">
        <span className="am-mk-notice-tag">Sample data</span>
        <span>{MARKETING_SAMPLE_NOTICE}</span>
      </p>
      {p.page === "overview" ? <MarketingOverview /> : <MarketingChannelPage {...p} channel={p.page} />}
    </div>
  );
}

function PrimaryAction({ label }: { label: string }) {
  return (
    <div className="am-mk-primary">
      <button type="button" className="am-mk-primary-button" data-marketing-action="primary" disabled aria-describedby={UNAVAILABLE_ID}>
        + {label}
      </button>
      <p className="am-mk-primary-note" id={UNAVAILABLE_ID}>
        {MARKETING_UNAVAILABLE_NOTICE}
      </p>
    </div>
  );
}

function MarketingOverview() {
  const sample = marketingOverviewSample();
  return (
    <>
      <header className="am-mk-head">
        <div>
          <div className="am-eyebrow">Grow · Marketing · Overview</div>
          <h1>One thoughtful plan. Every channel.</h1>
          <p className="am-mk-lede">Plan email, SMS and social from one place, then open the right channel when it is time to create.</p>
        </div>
        <PrimaryAction label="New activity" />
      </header>

      <section className="am-mk-card" aria-labelledby="am-mk-glance">
        <div className="am-eyebrow">Sample planner counts</div>
        <h2 id="am-mk-glance">Activity at a glance</h2>
        <dl className="am-mk-stats">
          {sample.stats.map((s) => (
            <div className="am-mk-stat" key={s.label}>
              <dt>{s.label}</dt>
              <dd>{s.value}</dd>
              <dd className="am-mk-stat-hint">{s.hint}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="am-mk-card" aria-labelledby="am-mk-plan">
        <div className="am-eyebrow">Sample plan</div>
        <h2 id="am-mk-plan">Planned this week</h2>
        <ul className="am-mk-plan">
          {sample.plan.map((item) => (
            <li key={item.title}>
              <span className="am-mk-plan-channel">{MARKETING_PAGE_LABEL[item.channel]}</span>
              <span className="am-mk-plan-title">{item.title}</span>
              <span className="am-mk-plan-when">{item.when}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="am-mk-card" aria-labelledby="am-mk-channels">
        <div className="am-eyebrow">Channels</div>
        <h2 id="am-mk-channels">Open a channel</h2>
        <ul className="am-mk-channels">
          {(["email", "sms", "social"] as const).map((c) => (
            <li key={c}>
              <Link href={marketingHref(c)} className="am-mk-channel-link">
                <strong>{MARKETING_CHANNEL_COPY[c].title}</strong>
                <span>{MARKETING_CHANNEL_COPY[c].lede}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function MarketingChannelPage(p: MinimalMarketingViewProps & { channel: MarketingChannel }) {
  const copy = MARKETING_CHANNEL_COPY[p.channel];
  const tabs = marketingChannelTabs(p.channel);
  const current = tabs.find((t) => t.key === p.tab) ?? tabs[0];
  const panelId = `am-mk-panel-${p.channel}`;
  return (
    <>
      <header className="am-mk-head">
        <div>
          <div className="am-eyebrow">{copy.eyebrow}</div>
          <h1>{copy.title}</h1>
          <p className="am-mk-lede">{copy.lede}</p>
        </div>
        <PrimaryAction label={copy.primaryAction} />
      </header>

      <div className="am-mk-tabs" role="tablist" aria-label={`${MARKETING_PAGE_LABEL[p.channel]} sections`}>
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`am-mk-tab-${p.channel}-${t.key}`}
            aria-selected={t.key === current.key}
            aria-controls={panelId}
            className={`am-mk-tab${t.key === current.key ? " is-current" : ""}`}
            onClick={() => p.on.selectTab(t.key)}
          >
            {t.label}
            {t.available ? null : <span className="am-mk-tab-tag"> · unavailable</span>}
          </button>
        ))}
      </div>

      <div className={`am-mk-body${p.channel === "social" ? " am-mk-body-social" : ""}`}>
        <div role="tabpanel" id={panelId} aria-labelledby={`am-mk-tab-${p.channel}-${current.key}`} className="am-mk-panel">
          {current.available ? (
            <BetterMarketing channel={p.channel} previewId={p.previewId} on={p.on} />
          ) : (
            <section className="am-mk-card am-mk-unavailable">
              <h2>{current.label}</h2>
              <p>{MARKETING_UNAVAILABLE_NOTICE}</p>
              <p className="am-mk-muted">This section opens when live marketing is approved and connected.</p>
            </section>
          )}
        </div>
        {p.channel === "social" ? <SocialRail /> : null}
      </div>
    </>
  );
}

function BetterMarketing({ channel, previewId, on }: { channel: MarketingChannel; previewId: string | null; on: MinimalMarketingViewProps["on"] }) {
  const ideas = betterMarketingIdeas(channel);
  return (
    <section className="am-mk-card" aria-labelledby={`am-mk-better-${channel}`}>
      <div className="am-mk-better-head">
        <div>
          <div className="am-eyebrow">A little inspiration</div>
          <h2 id={`am-mk-better-${channel}`}>Better Marketing</h2>
          <p className="am-mk-muted">Fresh ideas. Better conversations. More opportunities.</p>
        </div>
        <span className="am-mk-sample-pill">Sample ideas</span>
      </div>
      <ol className="am-mk-ideas">
        {ideas.map((idea) => {
          const open = previewId === idea.id;
          return (
            <li key={idea.id} className="am-mk-idea">
              <div className="am-mk-idea-row">
                <div>
                  <div className="am-mk-idea-eyebrow">{idea.eyebrow}</div>
                  <h3>{idea.title}</h3>
                  <p className="am-mk-muted">{idea.summary}</p>
                </div>
                <button
                  type="button"
                  className="am-mk-preview-button"
                  data-marketing-preview={idea.id}
                  aria-expanded={open}
                  aria-controls={`am-mk-preview-${idea.id}`}
                  onClick={() => on.preview(idea.id)}
                >
                  Preview
                </button>
              </div>
              {open ? (
                <div className="am-mk-preview" id={`am-mk-preview-${idea.id}`} role="region" aria-label={`Preview: ${idea.title}`}>
                  <p className="am-mk-preview-body">{idea.body}</p>
                  <p className="am-mk-preview-note">{MARKETING_PREVIEW_NOTE}</p>
                  <button type="button" className="am-mk-close" onClick={on.closePreview}>
                    Close preview
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="am-mk-footnote">Fictional examples for this preview. Merge fields in braces are placeholders; check local details before any real use.</p>
    </section>
  );
}

function SocialRail() {
  return (
    <aside className="am-mk-rail" aria-label="Social accounts">
      <section className="am-mk-card">
        <div className="am-eyebrow">Your channels</div>
        <h2>Accounts</h2>
        <ul className="am-mk-accounts">
          {socialSampleAccounts().map((a) => (
            <li key={a.platform}>
              <span>{a.platform}</span>
              <span className="am-mk-account-status">{a.status}</span>
            </li>
          ))}
        </ul>
        <p className="am-mk-muted">No platform connections in this preview.</p>
      </section>
    </aside>
  );
}
