import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const TTL_MS = 8 * 60 * 60 * 1000;
function signature(payload: string, secret: string): string {
  if (secret.length < 32) throw new Error("Owner context requires a strong session secret.");
  return createHmac("sha256", secret).update(`owner-context:v1:${payload}`).digest("base64url");
}
function sessionBinding(session: string): string {
  return createHash("sha256").update(session).digest("hex");
}
export function createOwnerContextToken(brokerageId: number, session: string, secret: string, now = Date.now()): string {
  if (!Number.isSafeInteger(brokerageId) || brokerageId < 1) throw new Error("Invalid brokerage.");
  const payload = Buffer.from(JSON.stringify({ brokerageId, binding: sessionBinding(session), expires: now + TTL_MS })).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}
export function verifyOwnerContextToken(token: string, session: string, secret: string, now = Date.now()): number | null {
  try {
    if (token.length > 1024) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payload, supplied] = parts;
    const expected = signature(payload!, secret);
    const a = Buffer.from(supplied!);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    if (parsed.binding !== sessionBinding(session) || !Number.isFinite(parsed.expires) ||
        parsed.expires <= now || parsed.expires > now + TTL_MS ||
        !Number.isSafeInteger(parsed.brokerageId) || parsed.brokerageId < 1) return null;
    return parsed.brokerageId;
  } catch { return null; }
}
