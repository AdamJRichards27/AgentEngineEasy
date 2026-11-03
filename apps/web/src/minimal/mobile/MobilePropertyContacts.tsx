import "./mobileStyles";
import "./mobilePeople.css";
import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiErrorMessage, apiFetch } from "../../lib/api";
import type { GrowContact360 } from "../../lib/growContact360";
import { useEntitlements, useSession } from "../../lib/session";
import { builderPath } from "../appraisal/appraisalBuilderModel";
import { resolveStartFailure, startAppraisalBody } from "../properties/minimalPropertiesModel";
import { appraisalCandidates, linkedPartiesPath, type LinkedPartyRow } from "../properties/minimalPropertyContactsModel";
import { MobilePropertyContactsView, type PropertyLinkPanel } from "./MobilePropertyContactsView";
import { callPlan, mayCallFromProperty, numbersOf } from "./mobileCalling";
import { mobileLinkedContacts, type ContactCallState } from "./mobilePropertyContactRows";
import { useCallReturn } from "./useCallReturn";
import { changeRoleRequest, linkRequest, duplicateContactWarning, linkingCapabilities, linkingFailureText, roleChoices, setPrimaryRequest, unlinkRequest, type KnownLink, type LinkRequest } from "./mobileLinking";
import { mobilePermissions } from "./mobilePermissions";
import { useLinkPicker } from "./useLinkPicker";
import { canManageRelationships } from "../../lib/relationshipPermission";

// AE Mobile (CC Task #64, M4 linking): the contacts on a property's page. The container.
//
// It COMPLETES the existing panel's job on a phone and does not replace a working function:
//   - the list reads what the existing panel reads (GET /parties/by-property/:id), under its own cache key;
//   - Start appraisal is the existing request (POST /grow/appraisals/from-contact), with the existing failure handling
//     (one appraisal per property: an existing one is opened instead);
//   - Add new contact is the existing request (POST /grow/contacts), with the existing duplicate answer (409: "Open existing contact" only when the server returned its id, else none; "Create anyway" resubmits with confirmDuplicate);
//   - link, change role and unlink are the canonical property_parties operations, OFF until the backend supports them in both directions.
// Nothing is updated before the server accepts it. It is mounted by the wiring change only while the link controls are on; until
// then the existing panel keeps serving phones.

export interface MobilePropertyContactsProps {
  propertyId: number;
  propertyLabel: string;
  /** The existing panel's own gates, passed through unchanged by the mount. */
  canStartAppraisal: boolean;
  canCreateContact: boolean;
  existingAppraisalHref: string | null;
  /** The existing panel, kept reachable while the canonical link controls are off. */
  legacyActions?: import("react").ReactNode;
}

export default function MobilePropertyContacts({ propertyId, propertyLabel, canStartAppraisal, canCreateContact, existingAppraisalHref, legacyActions }: MobilePropertyContactsProps) {
  const { entitlements } = useEntitlements();
  const { user } = useSession();
  // The SHARED rule (lib/relationshipPermission.ts, the one desktop and the server follow): the explicit key, or run.access for an Agent or
  // Brokerage Administrator; run.access alone (Pit Crew) is not enough. Not re-derived here.
  const canManageRel = canManageRelationships((key) => entitlements.includes(key), user?.role);
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [panel, setPanel] = useState<PropertyLinkPanel | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<number | null>(null);
  const [role, setRole] = useState("");
  const [appraisalError, setAppraisalError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [fields, setFields] = useState({ name: "", email: "", phone: "" });
  const [createError, setCreateError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<ReturnType<typeof duplicateContactWarning>>(null);
  const [created, setCreated] = useState<{ id: number; name: string } | null>(null);

  const linked = useQuery<{ parties: LinkedPartyRow[] }>({
    queryKey: ["minimal-property-parties", propertyId],
    queryFn: () => apiFetch(linkedPartiesPath(propertyId)),
  });
  const contacts = mobileLinkedContacts(linked.data?.parties ?? []);
  const known: KnownLink[] = contacts.map((c) => ({ linkId: c.linkId, propertyId, partyId: c.partyId, role: c.role }));
  const picker = useLinkPicker("contacts", mobilePermissions(entitlements, user?.role), panel?.kind === "link");

  // Tap-to-Call beside each contact: a Call button for every usable number, for an agent who may see the contact. Nothing is requested for it
  // (the number is already in the rows above) and nothing about consent is read. The agent is responsible for their own compliance.
  const canSeeContacts = mayCallFromProperty(entitlements);
  const callState: Record<number, ContactCallState> = {};
  if (canSeeContacts) for (const c of contacts) callState[c.linkId] = { options: callPlan(numbersOf({ mobile: c.mobile }), c.name).options };
  const callReturn = useCallReturn();

  const write = useMutation({
    mutationFn: (request: LinkRequest) => apiFetch(request.path, { method: request.method, body: request.body === undefined ? undefined : JSON.stringify(request.body) }),
  });
  const start = useMutation({
    mutationFn: (partyId: number) => apiFetch<{ appraisal: { id: number } }>("/grow/appraisals/from-contact", { method: "POST", body: JSON.stringify(startAppraisalBody(partyId, propertyId)) }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["grow-appraisals"] });
      navigate(builderPath(result.appraisal.id));
    },
    onError: (err) => {
      const failure = resolveStartFailure(err instanceof ApiError ? err : null, propertyId, apiErrorMessage(err, "Couldn't start the appraisal. Try again."));
      if (failure.kind === "open-existing") {
        void queryClient.invalidateQueries({ queryKey: ["grow-appraisals"] });
        navigate(failure.builderHref);
        return;
      }
      setAppraisalError(failure.text);
    },
  });
  const createContact = useMutation<{ contact: { id: number } }, unknown, { name: string; email: string; phone: string; confirmDuplicate?: boolean }>({
    mutationFn: (input) => apiFetch("/grow/contacts", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (result, input) => {
      setCreated({ id: result.contact.id, name: input.name });
      setPickedId(result.contact.id);
      setCreateOpen(false);
      setFields({ name: "", email: "", phone: "" });
      setCreateError(null);
      setDuplicate(null);
    },
    onError: (err) => {
      const dup = err instanceof ApiError ? duplicateContactWarning(err) : null;
      if (dup) {
        setCreateError(null);
        setDuplicate(dup);
        return;
      }
      setDuplicate(null);
      setCreateError(apiErrorMessage(err, "Couldn't create the contact. Try again."));
    },
  });

  // The existing contact's name, for the warning. Only asked when the server revealed the contact's id, which it does only to a caller who may
  // read contacts; without an id nothing is requested and nothing about the contact is shown. The same request and cache key as Contact 360.
  const existingContactId = duplicate?.existingContactId ?? null;
  const existing = useQuery<GrowContact360>({
    queryKey: ["grow-contact", existingContactId],
    queryFn: () => apiFetch<GrowContact360>(`/grow/contacts/${existingContactId}`),
    enabled: existingContactId !== null,
    staleTime: 60_000,
    retry: false,
  });
  const existingName = existing.data?.contact.displayName?.trim() || null;

  const close = () => {
    setDuplicate(null);
    setPanel(null);
    setOpError(null);
    setPickedId(null);
    setRole("");
    setCreated(null);
    setCreateOpen(false);
    setCreateError(null);
    setDuplicate(null);
    picker.reset();
  };
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["minimal-property-parties", propertyId] });
    void queryClient.invalidateQueries({ queryKey: ["parties", "by-contact"] });
    void queryClient.invalidateQueries({ queryKey: ["grow-contact"] });
  };
  const send = (built: { ok: true; request: LinkRequest } | { ok: false; error: string }, done: string) => {
    if (!built.ok) {
      setOpError(built.error);
      return;
    }
    setOpError(null);
    write.mutate(built.request, {
      onSuccess: () => {
        close();
        setNotice(done);
        refresh();
      },
      onError: (error) => {
        setOpError(linkingFailureText(error instanceof ApiError ? error : null, apiErrorMessage(error, "That didn't go through. Try again.")));
        refresh();
      },
    });
  };

  return (
    <MobilePropertyContactsView
      propertyLabel={propertyLabel}
      contacts={contacts}
      loading={linked.isLoading}
      error={linked.isError ? { text: apiErrorMessage(linked.error, "Couldn't load the contacts."), onRetry: () => void linked.refetch() } : null}
      capabilities={linkingCapabilities(entitlements, undefined, user?.role)}
      canManageRelationships={canManageRel}
      panel={panel}
      submitting={write.isPending}
      opError={opError}
      notice={notice}
      callState={callState}
      onCall={(contact, option) => callReturn.begin({ partyId: contact.partyId, name: contact.name }, option)}
      callOffer={callReturn.offer}
      onDismissOffer={callReturn.dismiss}
      onMakePrimary={(linkId) => send(setPrimaryRequest(linkId), "Primary contact updated.")}
      legacyActions={legacyActions}
      roleValue={role}
      roleOptions={roleChoices()}
      appraisal={{
        existingHref: existingAppraisalHref,
        candidates: appraisalCandidates(contacts),
        canStart: canStartAppraisal,
        starting: start.isPending,
        error: appraisalError,
        onStart: (partyId) => {
          setAppraisalError(null);
          setNotice(null);
          start.mutate(partyId);
        },
      }}
      picker={
        panel?.kind === "link"
          ? {
              title: "Link a contact",
              searchLabel: "Search contacts",
              searchPlaceholder: "Name or email",
              query: picker.input,
              rows: picker.rows,
              message: picker.message,
              loading: picker.loading,
              selectedId: pickedId,
              choiceLabel: "Their relationship to the property",
              choices: roleChoices(),
              choice: role,
              submitLabel: "Link contact",
              submitting: write.isPending,
              error: opError,
              createdRow: created ? { id: created.id, title: created.name, subtitle: "New contact" } : null,
              create: canCreateContact
                ? {
                    open: createOpen,
                    name: fields.name,
                    email: fields.email,
                    phone: fields.phone,
                    creating: createContact.isPending,
                    error: createError,
                    duplicate,
                    duplicateName: existingName,
                    // "Use name" links the existing contact: only for a user who may manage relationships, and only when the server revealed the id.
                    onUseExisting:
                      canManageRel && existingContactId !== null
                        ? () => {
                            setCreated({ id: existingContactId, name: existingName ?? "Existing contact" });
                            setPickedId(existingContactId);
                            setDuplicate(null);
                            setCreateOpen(false);
                            setFields({ name: "", email: "", phone: "" });
                            setCreateError(null);
                          }
                        : null,
                    onOpen: () => {
                      setCreateOpen(true);
                      setCreateError(null);
                      setDuplicate(null);
                    },
                    onField: (field, value) => {
                      setDuplicate(null);
                      setFields((f) => ({ ...f, [field]: value }));
                    },
                    onSubmit: () => {
                      const name = fields.name.trim();
                      if (!name) {
                        setCreateError("Enter a name for the new contact.");
                        return;
                      }
                      setDuplicate(null);
                      createContact.mutate({ name, email: fields.email.trim(), phone: fields.phone.trim() });
                    },
                    onCreateAnyway: () => {
                      const name = fields.name.trim();
                      if (!name || !duplicate) return;
                      createContact.mutate({ name, email: fields.email.trim(), phone: fields.phone.trim(), confirmDuplicate: true });
                    },
                    onCancel: () => {
                      setCreateOpen(false);
                      setCreateError(null);
                      setDuplicate(null);
                    },
                  }
                : null,
              onQuery: picker.setInput,
              onSelect: setPickedId,
              onChoice: setRole,
              onSubmit: () => send(linkRequest(propertyId, pickedId, role, known), "Contact linked to this property."),
              onCancel: close,
            }
          : null
      }
      onOpen={(next) => {
        setNotice(null);
        setOpError(null);
        setPickedId(null);
        setRole("");
        setCreated(null);
        if (next.kind === "role") setRole(contacts.find((c) => c.linkId === next.linkId)?.role ?? "");
        setPanel(next);
      }}
      onClose={close}
      onRoleChange={setRole}
      onSubmitRole={() => {
        if (panel?.kind === "role") send(changeRoleRequest(panel.linkId, role, contacts.find((c) => c.linkId === panel.linkId)?.role ?? null), "Role saved.");
      }}
      onConfirmUnlink={() => {
        if (panel?.kind === "unlink") send(unlinkRequest(panel.linkId), "Contact unlinked.");
      }}
    />
  );
}
