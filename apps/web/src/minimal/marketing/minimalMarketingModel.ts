// AE Minimal v1.0 V7 (Owner t457u, gap analysis R3): the Marketing group.
// Overview, Email, SMS and Social are static sample previews. Better Marketing
// recommendations sit inside each channel page. Nothing here is sent,
// scheduled or published: there is no provider, no API call and no stored
// record. Every figure and idea below is fictional sample data and is labelled
// as such on screen. Live marketing is planned separately (SPEC-05, CC #30–#33).

export type MarketingChannel = "email" | "sms" | "social";
export type MarketingPage = "overview" | MarketingChannel;
export type MarketingTab = "recommendations" | "create" | "templates" | "campaigns" | "performance";

export const MARKETING_CHANNELS: readonly MarketingChannel[] = ["email", "sms", "social"];

export const MARKETING_HREF = "/grow/marketing";

export function marketingHref(page: MarketingPage): string {
  return `${MARKETING_HREF}/${page}`;
}

export const MARKETING_SAMPLE_NOTICE =
  "Sample preview. Nothing here is sent or published: no email, SMS or social provider is connected, and every figure and idea on this page is fictional sample data.";

export const MARKETING_UNAVAILABLE_NOTICE =
  "Not available in this preview. Sending, scheduling and publishing are switched off.";

export const MARKETING_PREVIEW_NOTE = "Preview only. Nothing has been sent, scheduled or saved.";

const GROW_ACCESS = "grow.access";

/** Marketing is a Grow surface: grow.access, fail closed while unknown. */
export function marketingAllowed(entitlements: readonly string[] | null | undefined): boolean {
  return Array.isArray(entitlements) && entitlements.includes(GROW_ACCESS);
}

/** Route param → page. No param is the Overview; anything unknown is null. */
export function parseMarketingPage(param: string | undefined | null): MarketingPage | null {
  if (param === undefined || param === null || param === "" || param === "overview") return "overview";
  return (MARKETING_CHANNELS as readonly string[]).includes(param) ? (param as MarketingChannel) : null;
}

export type MarketingRouteOutcome =
  | { kind: "loading" }
  | { kind: "redirect"; to: "/grow" | "/grow/marketing" }
  | { kind: "render"; page: MarketingPage };

/**
 * Inside the Minimal shell (App.tsx sends classic to /grow): wait while
 * entitlements load (fail closed), no grow.access → /grow, unknown page →
 * Overview, otherwise render the page.
 */
export function marketingRouteOutcome(
  entitlements: readonly string[] | null | undefined,
  isLoading: boolean,
  param: string | undefined | null,
): MarketingRouteOutcome {
  if (isLoading) return { kind: "loading" };
  if (!marketingAllowed(entitlements)) return { kind: "redirect", to: "/grow" };
  const page = parseMarketingPage(param);
  return page === null ? { kind: "redirect", to: "/grow/marketing" } : { kind: "render", page };
}

/** Minimal shell only; the classic shell has no Marketing pages. */
export function selectMarketingView(minimalShell: boolean): "minimal" | "classic" {
  return minimalShell ? "minimal" : "classic";
}

export const MARKETING_PAGE_LABEL: Record<MarketingPage, string> = {
  overview: "Overview",
  email: "Email",
  sms: "SMS",
  social: "Social",
};

export interface MarketingTabDef {
  key: MarketingTab;
  label: string;
  available: boolean;
}

const TAB_LABELS: Array<[MarketingTab, string]> = [
  ["recommendations", "Recommendations"],
  ["create", "Create"],
  ["templates", "Templates"],
  ["campaigns", "Campaigns"],
  ["performance", "Performance"],
];

/** Only Recommendations has content; every other tab shows the unavailable state. */
export function marketingChannelTabs(_channel: MarketingChannel): MarketingTabDef[] {
  return TAB_LABELS.map(([key, label]) => ({ key, label, available: key === "recommendations" }));
}

export function parseMarketingTab(value: string | null | undefined): MarketingTab {
  return TAB_LABELS.some(([k]) => k === value) ? (value as MarketingTab) : "recommendations";
}

export interface MarketingChannelCopy {
  eyebrow: string;
  title: string;
  lede: string;
  primaryAction: string;
}

export const MARKETING_CHANNEL_COPY: Record<MarketingChannel, MarketingChannelCopy> = {
  email: {
    eyebrow: "Grow · Marketing · Email",
    title: "Email recommendations",
    lede: "Keep in touch with care, using the relationships already in Grow.",
    primaryAction: "New email",
  },
  sms: {
    eyebrow: "Grow · Marketing · SMS",
    title: "SMS recommendations",
    lede: "Short, relevant messages for the people who asked to hear from you.",
    primaryAction: "New SMS",
  },
  social: {
    eyebrow: "Grow · Marketing · Social",
    title: "Social Media Studio",
    lede: "Make the next good post, then put it where your people are.",
    primaryAction: "Create post",
  },
};

export interface BetterMarketingIdea {
  id: string;
  eyebrow: string;
  title: string;
  summary: string;
  /** Sample copy shown in the local preview. Merge fields are placeholders. */
  body: string;
  sample: true;
}

const IDEAS: Record<MarketingChannel, BetterMarketingIdea[]> = {
  email: [
    {
      id: "email-seasonal",
      eyebrow: "Featured this week",
      title: "Thinking of selling before Christmas?",
      summary: "A personal, timely note for owners who have mentioned a move.",
      body: "Subject: Thinking of selling before Christmas? Hi {first name}, a few owners in {suburb} have asked whether there is still time to sell before the holidays. If that is on your mind, I am happy to talk it through, with no obligation.",
      sample: true,
    },
    {
      id: "email-market-update",
      eyebrow: "Local market",
      title: "Your suburb this month",
      summary: "A short, factual summary of recent local activity.",
      body: "Subject: What happened in {suburb} this month. Hi {first name}, here is a short summary of recent sales and new listings near you. Reply if you would like a closer look at your own property.",
      sample: true,
    },
    {
      id: "email-thank-you",
      eyebrow: "Relationship",
      title: "Thank you after an appraisal",
      summary: "A warm note that recaps what you discussed.",
      body: "Subject: Thanks for your time. Hi {first name}, thank you for showing me through {address}. I have attached the points we covered. Let me know if any questions come up.",
      sample: true,
    },
  ],
  sms: [
    {
      id: "sms-property-update",
      eyebrow: "Quick update",
      title: "Quick property update",
      summary: "Offer homeowners a current market update.",
      body: "Hi {first name}, it's {agent name}. Prices near {address} have moved this quarter. Would a quick update on your property be useful? Reply STOP to opt out.",
      sample: true,
    },
    {
      id: "sms-recent-sales",
      eyebrow: "Local activity",
      title: "Recent sales in your area",
      summary: "Start a conversation using relevant local activity.",
      body: "Hi {first name}, two homes sold in {suburb} this month. Happy to share what they achieved if you're curious. Reply STOP to opt out.",
      sample: true,
    },
    {
      id: "sms-year-end",
      eyebrow: "Planning",
      title: "End-of-year property plans",
      summary: "Invite homeowners to talk about their plans.",
      body: "Hi {first name}, if 2027 might bring a move, I'm glad to talk timing and preparation, no pressure. Reply STOP to opt out.",
      sample: true,
    },
  ],
  social: [
    {
      id: "social-new-listing",
      eyebrow: "New listing",
      title: "Give a new listing its first look",
      summary: "A fresh listing is a natural moment to introduce the home to your local audience.",
      body: "Just listed in {suburb}: {address}. Light-filled living, a quiet street and an easy walk to the park. Inspection details coming soon.",
      sample: true,
    },
    {
      id: "social-recent-sale",
      eyebrow: "Recent sale",
      title: "Celebrate a successful sale",
      summary: "Share the result and thank the people who made it possible.",
      body: "Sold in {suburb}. Thank you to the owners of {address} for trusting us, and congratulations to the new owners.",
      sample: true,
    },
    {
      id: "social-open-home",
      eyebrow: "Open home",
      title: "Invite neighbours to the open home",
      summary: "A simple invitation, with inspection details up front.",
      body: "Open home this Saturday at {address}, {time}. Neighbours welcome, come and say hello.",
      sample: true,
    },
    {
      id: "social-local-note",
      eyebrow: "Local market",
      title: "Share a neighbourhood market note",
      summary: "Turn recent local activity into a helpful, human update.",
      body: "{suburb} this month: a few new listings, steady buyer interest and some strong results. Ask me anything about your street.",
      sample: true,
    },
  ],
};

export function betterMarketingIdeas(channel: MarketingChannel): BetterMarketingIdea[] {
  return IDEAS[channel];
}

export function findMarketingIdea(channel: MarketingChannel, id: string | null): BetterMarketingIdea | null {
  if (id === null) return null;
  return IDEAS[channel].find((i) => i.id === id) ?? null;
}

export interface MarketingSampleStat {
  label: string;
  value: string;
  hint: string;
  sample: true;
}

export interface MarketingSamplePlanItem {
  channel: MarketingChannel;
  title: string;
  when: string;
}

export function marketingOverviewSample(): { stats: MarketingSampleStat[]; plan: MarketingSamplePlanItem[] } {
  return {
    stats: [
      { label: "Planned", value: "3", hint: "Sample planner items", sample: true },
      { label: "Drafts", value: "1", hint: "Sample, not sent", sample: true },
      { label: "Published", value: "0", hint: "Nothing is published in this preview", sample: true },
      { label: "Reach", value: "2,437", hint: "Illustrative figure only", sample: true },
    ],
    plan: [
      { channel: "social", title: "Saturday open home", when: "Sample · Fri 9:30 am" },
      { channel: "sms", title: "A quick Saturday reminder", when: "Sample · Sat 8:30 am" },
      { channel: "email", title: "Your suburb this month", when: "Sample · Mon 7:00 am" },
    ],
  };
}

export interface SocialSampleAccount {
  platform: string;
  status: "Not connected";
}

/** No platform is ever shown as connected: there are no connections in this preview. */
export function socialSampleAccounts(): SocialSampleAccount[] {
  return ["Facebook", "Instagram", "LinkedIn", "YouTube"].map((platform) => ({ platform, status: "Not connected" as const }));
}
