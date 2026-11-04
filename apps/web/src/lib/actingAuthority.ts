// Owner t275u: Pit Crew acts on contacts, relationships, imports and exports only on the
// recorded authority of the contact owner (an agent). The desktop holds the current
// authority for this browser tab (sessionStorage; cleared on sign-out or tab close) and
// apiFetch sends it as X-AE-On-Behalf-Of / X-AE-Authority-Ref. The server validates and
// audits it; this module only carries it. Agents and admins never set it.
export interface ActingAuthority {
  ownerId: number;
  ownerName: string;
  authorityRef: string;
}

const KEY = "ae.pitCrew.actingAuthority";
export const ON_BEHALF_HEADER = "X-AE-On-Behalf-Of";
export const AUTHORITY_REF_HEADER = "X-AE-Authority-Ref";
export const AUTHORITY_REF_MIN = 3;
export const AUTHORITY_REF_MAX = 200;

let memory: ActingAuthority | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function validActingAuthority(a: Partial<ActingAuthority> | null | undefined): a is ActingAuthority {
  if (!a) return false;
  const ref = (a.authorityRef ?? "").trim();
  return Number.isInteger(a.ownerId) && (a.ownerId as number) > 0 && ref.length >= AUTHORITY_REF_MIN && ref.length <= AUTHORITY_REF_MAX;
}

export function getActingAuthority(): ActingAuthority | null {
  if (memory) return memory;
  const raw = storage()?.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ActingAuthority;
    memory = validActingAuthority(parsed) ? parsed : null;
  } catch {
    memory = null;
  }
  return memory;
}

export function setActingAuthority(a: ActingAuthority | null): void {
  memory = a && validActingAuthority(a) ? { ...a, authorityRef: a.authorityRef.trim() } : null;
  const s = storage();
  if (memory) s?.setItem(KEY, JSON.stringify(memory));
  else s?.removeItem(KEY);
  for (const l of listeners) l();
}

export function subscribeActingAuthority(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Headers for a request; empty when no authority is held. */
export function actingAuthorityHeaders(a: ActingAuthority | null = getActingAuthority()): Record<string, string> {
  if (!a) return {};
  return { [ON_BEHALF_HEADER]: String(a.ownerId), [AUTHORITY_REF_HEADER]: a.authorityRef };
}
