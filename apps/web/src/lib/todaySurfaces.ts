// G-3 — Grow Today and the RUN Command Centre are two Today screens.
//
// Grow Today reads GET /grow/today (relationships, follow-ups, opportunities).
// The Command Centre reads GET /command-centre (property delivery). This
// module does not fetch or merge those reads. It is the only user-facing
// name, purpose line, and cross-link, so the two pages cannot drift back
// into one "Daily Command Centre" pitch.

export const GROW_TODAY_PATH = "/grow";
export const RUN_COMMAND_CENTRE_PATH = "/today";

export const GROW_TODAY_EYEBROW = "Grow";
export const GROW_TODAY_TITLE = "Grow Today";
export const GROW_TODAY_PURPOSE =
  "Relationships, follow-ups, and opportunities that need a next step.";

export const RUN_COMMAND_CENTRE_EYEBROW = "RUN";
export const RUN_COMMAND_CENTRE_TITLE = "Today";
export const RUN_COMMAND_CENTRE_NAME = "Command Centre";
export const RUN_COMMAND_CENTRE_PURPOSE =
  "Property work you can see: what is due, overdue, or waiting on someone else.";

export interface TodaySurfaceCrossLink {
  href: string;
  label: string;
  /** What the other screen is for, shown beside the link. */
  distinction: string;
}

export const growTodayCrossLink: TodaySurfaceCrossLink = {
  href: RUN_COMMAND_CENTRE_PATH,
  label: RUN_COMMAND_CENTRE_NAME,
  distinction: "Property delivery is a different screen.",
};

export const commandCentreCrossLink: TodaySurfaceCrossLink = {
  href: GROW_TODAY_PATH,
  label: GROW_TODAY_TITLE,
  distinction: "Relationship follow-up is a different screen.",
};

export function growTodayHeading(firstName: string | null | undefined): string {
  const name = firstName?.trim();
  if (!name) return GROW_TODAY_TITLE;
  return `Hi ${name} — ${GROW_TODAY_TITLE}`;
}

export function commandCentreGreeting(firstName: string, asOf: string, timeZone: string): string {
  return `Hi ${firstName} — ${RUN_COMMAND_CENTRE_NAME} for property work, as of ${asOf} (${timeZone}).`;
}
