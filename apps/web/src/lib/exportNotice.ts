// t277u: pure text for the export-ready notice (counts and dates only, never contact data).
export type ExportNotification = {
  id: string;
  kind: "export_ready";
  exportId: number;
  rows: number;
  preparedAt: string;
  expiresAt: string;
  preparedBy: string;
  downloadPath: string;
};

export function formatExpiry(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone });
}

export function exportNoticeText(n: ExportNotification, timeZone?: string): string {
  const who = n.preparedBy === "you" ? "you" : n.preparedBy;
  return `Your contact export (${n.rows} contact${n.rows === 1 ? "" : "s"}, prepared by ${who}) is ready. Download it before ${formatExpiry(n.expiresAt, timeZone)} — after that it expires and is deleted.`;
}

