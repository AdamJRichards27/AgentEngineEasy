import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiErrorMessage, apiFetch } from "../../lib/api";
import { buildLinkedContacts, linkedPartiesPath, type LinkedPartyRow } from "../properties/minimalPropertyContactsModel";
import {
  brisbaneToday,
  defaultFollowUpDescription,
  marketFollowUpBody,
  marketFollowUpPath,
  type MarketEventDetail,
} from "./minimalMarketActivityModel";
import { MarketFollowUpView, type MarketFollowUpContact } from "./MinimalMarketActivityView";

// AE Minimal v1.0 "Create Follow-Up" from a Market Activity event on an AE
// property record, shown as "Add commitment" (glossary G-6).
// Existing Grow routes only: GET /parties/by-property/:id (linked contacts) and
// POST /grow/contacts/:partyId/commitments (grow.activities.manage; the server
// re-checks brokerage, property visibility and permission). Never shown for
// agent-entered comparables (no propertyId).

export function followUpErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 403) return "You don't have permission to add commitments.";
  if (e instanceof ApiError && e.status === 404) return "That contact or property is no longer available.";
  return apiErrorMessage(e, "Couldn't save the commitment.");
}

export function MinimalMarketEventFollowUp({ detail, propertyId, propertyHref }: { detail: MarketEventDetail; propertyId: number; propertyHref: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [partyId, setPartyId] = useState<number | null>(null);
  const [description, setDescription] = useState(() => defaultFollowUpDescription(detail));
  const [dueDate, setDueDate] = useState(() => brisbaneToday());
  const [error, setError] = useState<string | null>(null);

  const parties = useQuery<{ parties?: LinkedPartyRow[] }>({
    queryKey: ["minimal-property-parties", propertyId],
    queryFn: () => apiFetch(linkedPartiesPath(propertyId)),
    enabled: open,
  });
  const save = useMutation<unknown, unknown, { partyId: number; body: { description: string; dueAt: string; propertyId: number } }>({
    mutationFn: ({ partyId: id, body }) => apiFetch(marketFollowUpPath(id), { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (_r, vars) => {
      void queryClient.invalidateQueries({ queryKey: ["grow-contact", vars.partyId] });
      void queryClient.invalidateQueries({ queryKey: ["grow-today"] });
      const who = contacts.find((c) => c.partyId === vars.partyId)?.name ?? "the contact";
      setDone(`Commitment created for ${who}.`);
      setOpen(false);
      setError(null);
    },
    onError: (e) => setError(followUpErrorText(e)),
  });

  const rows = Array.isArray(parties.data?.parties) ? parties.data.parties : [];
  const contacts: MarketFollowUpContact[] = buildLinkedContacts(rows).map((c) => ({ partyId: c.partyId, name: c.name, roleLabel: c.roleLabel }));

  if (!open) {
    return <MarketFollowUpView state={{ kind: "closed", done, onOpen: () => { setOpen(true); setDone(null); } }} />;
  }
  if (parties.isLoading) return <MarketFollowUpView state={{ kind: "loading" }} />;
  if (parties.isError) return <MarketFollowUpView state={{ kind: "error", text: apiErrorMessage(parties.error, "Couldn't load the linked contacts.") }} />;
  if (contacts.length === 0) return <MarketFollowUpView state={{ kind: "no-contacts", propertyHref }} />;
  const chosen = partyId ?? (contacts.length === 1 ? contacts[0].partyId : null);
  return (
    <MarketFollowUpView
      state={{
        kind: "form",
        contacts,
        partyId: chosen,
        description,
        dueDate,
        minDate: brisbaneToday(),
        submitting: save.isPending,
        error,
        onParty: setPartyId,
        onDescription: setDescription,
        onDueDate: setDueDate,
        onCancel: () => { setOpen(false); setError(null); },
        onSubmit: () => {
          if (chosen == null) return setError("Choose a linked contact.");
          const r = marketFollowUpBody({ description, dueDate, propertyId });
          if (!r.ok) return setError(r.error);
          save.mutate({ partyId: chosen, body: r.body });
        },
      }}
    />
  );
}
