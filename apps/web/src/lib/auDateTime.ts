// t274u item 5: desktop timeline dates in en-AU DD/MM/YYYY (was the browser
// default, e.g. en-US "11/5/2026, 4:31:16 AM"). Local time zone of the viewer
// unless one is given (tests pin it).
export function formatAuDateTime(value: string | number | Date, timeZone?: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}
