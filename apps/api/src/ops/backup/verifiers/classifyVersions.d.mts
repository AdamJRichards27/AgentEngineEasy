export const EXIT_CODES: Readonly<Record<"absent" | "delete_marker_retained" | "versions_retained" | "governance_locked" | "compliance_locked" | "access_denied_or_incomplete" | "inconclusive", number>>;
export const DENIED: RegExp;
export type VerifierClass = keyof typeof EXIT_CODES;
export interface VerifierResult { class: VerifierClass; verified: boolean; exitCode: number; detail: string; versions?: number; deleteMarkers?: number; [k: string]: unknown }
export function classify(input: {
  listing: { complete: boolean; error?: { message: string; denied?: boolean }; entries: Array<{ versionId: string; isDeleteMarker: boolean }> } | undefined;
  locks?: Record<string, { status: "ok" | "denied" | "error"; mode?: string | null; until?: string; legalHold?: boolean; message?: string }>;
  now?: Date;
}): VerifierResult;
