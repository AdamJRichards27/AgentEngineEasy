import "./mobileStyles";
import "./mobilePeople.css";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useSearch } from "wouter";
import { ApiError, apiErrorMessage, apiFetch } from "../../lib/api";
import type { GrowContact360 } from "../../lib/growContact360";
import { useEntitlements, useSession } from "../../lib/session";
import { MobileGrowSections } from "./MobileGrowSections";
import { useCallReturn } from "./useCallReturn";
import { MobileContactMessage, MobileContactView, type ContactLinkPanel } from "./MobileContactView";
import { canonicalContactLinksPath, changeRoleRequest, linkRequest, setPrimaryRequest, linkingCapabilities, linkingFailureText, parseContactLinks, roleChoices, unlinkRequest, type KnownLink, type LinkRequest } from "./mobileLinking";
import { MOBILE_LINKING } from "./mobileLinkingConfig";
import { CONTACT_NOT_FOUND, contactLoadMessage } from "./mobileContactMessages";
import { mobilePermissions } from "./mobilePermissions";
import { useLinkPicker } from "./useLinkPicker";
import {
  buildFormRequest,
  completeRequest,
  initialForm,
  toLocalInputValue,
  type ContactFormKind,
  type ContactFormState,
  type ContactWriteRequest,
} from "./mobileContactForms";
import { buildMobileContactLayout } from "./mobileContactLayout";
import { GROW_ACTIVITIES_MANAGE, MOBILE_PEOPLE_SHOWS_GROW_SECTIONS } from "./mobilePeopleConfig";

// AE Mobile (CC Task #64, M4): the phone Contact 360. The container. It reads the same payload and the same
// react-query key ["grow-contact", partyId] as the existing Contact 360, so nothing extra is requested, and
// it writes only through the four verified routes the request builders produce. After a write it refreshes
// the contact, Today and the activity list, as the classic screen does. Not wired into any route until the
// wiring pull request is approved.

const WRITTEN: Record<ContactFormKind, string> = {
  note: "Note saved.",
  call: "Saved.",
  commitment: "Commitment added.",
  reschedule: "Rescheduled.",
};

export default function MobileContact() {
  const params = useParams<{ id: string }>();
  const { entitlements, hasEntitlement } = useEntitlements();
  const { user } = useSession();
  const queryClient = useQueryClient();
  const partyId = /^\d+$/.test(params.id ?? "") ? Number(params.id) : null;
  const backHref = "/grow?tab=contacts";

  const [form, setForm] = useState<ContactFormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  // Link, edit-role and unlink. Every control is off until the backend is ready (MOBILE_LINKING); a change is
  // shown only after the server has accepted it, and nothing is updated optimistically.
  const [panel, setPanel] = useState<ContactLinkPanel | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [roleValue, setRoleValue] = useState("");
  const [pickedId, setPickedId] = useState<number | null>(null);
  const [relationship, setRelationship] = useState("");
  const permissions = mobilePermissions(entitlements, user?.role);
  const picker = useLinkPicker("properties", permissions, panel?.kind === "link");

  // Tap-to-call: the dialler opens from the link; nothing is recorded. When the agent comes back, Log call is offered (or opened from a
  // property page with ?log=call). It saves only if the agent saves it.
  const callReturn = useCallReturn();
  const search = useSearch();
  const opened = useRef(false);

  const detail = useQuery<GrowContact360>({
    queryKey: ["grow-contact", partyId],
    queryFn: () => apiFetch(`/grow/contacts/${partyId}`),
    enabled: partyId !== null,
  });

  // The property links come from property_parties, the one canonical table, once the backend supports reading them by contact
  // (MOBILE_LINKING.contactCanonicalRead). Until then nothing is requested and the screen shows what the contact payload carries,
  // read-only. The two sources are never merged.
  const canonical = useQuery<unknown>({
    queryKey: ["parties", "by-contact", partyId],
    queryFn: () => apiFetch(canonicalContactLinksPath(partyId as number)),
    enabled: partyId !== null && MOBILE_LINKING.contactCanonicalRead,
  });
  const canonicalLinks = MOBILE_LINKING.contactCanonicalRead && canonical.isSuccess ? parseContactLinks(canonical.data) : null;

  useEffect(() => {
    if (opened.current || !detail.data || !hasEntitlement(GROW_ACTIVITIES_MANAGE)) return;
    if (new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("log") !== "call") return;
    opened.current = true;
    setForm(initialForm("call", new Date()));
  }, [detail.data, search, hasEntitlement]);

  const write = useMutation({
    mutationFn: (request: ContactWriteRequest | LinkRequest) =>
      apiFetch(request.path, { method: request.method, body: request.body === undefined ? undefined : JSON.stringify(request.body) }),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["grow-contact", partyId] });
    void queryClient.invalidateQueries({ queryKey: ["grow-today"] });
    void queryClient.invalidateQueries({ queryKey: ["grow-activities"] });
  };
  const refreshLinks = () => {
    void queryClient.invalidateQueries({ queryKey: ["grow-contact", partyId] });
    void queryClient.invalidateQueries({ queryKey: ["grow-contacts"] });
    void queryClient.invalidateQueries({ queryKey: ["parties", "by-contact", partyId] });
    void queryClient.invalidateQueries({ queryKey: ["minimal-property-parties"] });
    void queryClient.invalidateQueries({ queryKey: ["grow-today"] });
  };
  const closeLinkPanel = () => {
    setPanel(null);
    setLinkError(null);
    setPickedId(null);
    setRelationship("");
    setRoleValue("");
    picker.reset();
  };
  const sendLink = (built: { ok: true; request: LinkRequest } | { ok: false; error: string }, done: string) => {
    if (!built.ok) {
      setLinkError(built.error);
      return;
    }
    setLinkError(null);
    write.mutate(built.request, {
      onSuccess: () => {
        closeLinkPanel();
        setNotice({ text: done, failed: false });
        refreshLinks();
      },
      onError: (error) => {
        setLinkError(linkingFailureText(error instanceof ApiError ? error : null, apiErrorMessage(error, "That didn't go through. Try again.")));
        refreshLinks();
      },
    });
  };

  if (partyId === null) return <MobileContactMessage backHref={backHref} text={CONTACT_NOT_FOUND} />;
  if (detail.isLoading) {
    return (
      <div className="mob-c" data-ae-contact="mobile">
        <p className="mob-c-note" role="status">
          Loading contact…
        </p>
      </div>
    );
  }
  if (detail.isError) {
    const failure = contactLoadMessage(detail.error instanceof ApiError ? detail.error.status : null, apiErrorMessage(detail.error, "Couldn't load this contact."));
    return <MobileContactMessage backHref={backHref} text={failure.text} onRetry={failure.retry ? () => void detail.refetch() : undefined} />;
  }
  if (!detail.data) return null;

  const layout = buildMobileContactLayout(detail.data, {
    now: new Date(),
    canLog: hasEntitlement(GROW_ACTIVITIES_MANAGE),
    expandedHistory: historyExpanded,
    canonicalLinks,
  });
  // What this contact is already linked to, for the repeat guard: canonical rows only.
  const known: KnownLink[] = layout.properties.filter((p) => p.canonical && p.propertyId !== null && p.roleValue !== null).map((p) => ({ linkId: p.key, propertyId: p.propertyId as number, partyId: partyId as number, role: p.roleValue as string }));

  return (
    <MobileContactView
      onCall={(option) => callReturn.begin({ partyId: layout.id, name: layout.name }, option)}
      callOffer={layout.canLog ? callReturn.offer : null}
      onLogOffer={() => {
        const offer = callReturn.offer;
        const started = initialForm("call", new Date());
        setForm(offer ? { ...started, values: { ...started.values, occurredAt: toLocalInputValue(new Date(offer.startedAt)) } } : started);
        callReturn.dismiss();
      }}
      onDismissOffer={callReturn.dismiss}
      linking={{
        capabilities: linkingCapabilities(entitlements, undefined, user?.role),
        panel,
        error: linkError,
        submitting: write.isPending,
        roleValue,
        roleOptions: roleChoices(),
        picker:
          panel?.kind === "link"
            ? {
                title: "Link a property",
                searchLabel: "Search properties",
                searchPlaceholder: "Address, suburb or postcode",
                query: picker.input,
                rows: picker.rows,
                message: picker.message,
                loading: picker.loading,
                selectedId: pickedId,
                choiceLabel: "Their relationship to the property",
                choices: roleChoices(),
                choice: relationship,
                submitLabel: "Link property",
                submitting: write.isPending,
                error: linkError,
                onQuery: picker.setInput,
                onSelect: setPickedId,
                onChoice: setRelationship,
                onSubmit: () => sendLink(linkRequest(pickedId ?? 0, partyId, relationship, known), "Property linked."),
                onCancel: closeLinkPanel,
              }
            : null,
        onOpen: (next) => {
          setNotice(null);
          setLinkError(null);
          setPickedId(null);
          setRelationship("");
          setRoleValue(next.kind === "edit" ? (layout.properties.find((p) => p.key === next.relationshipId)?.roleValue ?? "") : "");
          setPanel(next);
        },
        onClose: closeLinkPanel,
        onRoleChange: setRoleValue,
        onSubmitRole: () => {
          if (panel?.kind === "edit") sendLink(changeRoleRequest(panel.relationshipId, roleValue, layout.properties.find((p) => p.key === panel.relationshipId)?.roleValue ?? null), "Role saved.");
        },
        onMakePrimary: (linkId) => sendLink(setPrimaryRequest(linkId), "Primary contact updated."),
        onConfirmUnlink: () => {
          if (panel?.kind === "unlink") sendLink(unlinkRequest(panel.relationshipId), "Property unlinked.");
        },
      }}
      sectionsSlot={MOBILE_PEOPLE_SHOWS_GROW_SECTIONS ? <MobileGrowSections current="contacts" /> : null}
      backHref={backHref}
      layout={layout}
      historyExpanded={historyExpanded}
      onToggleHistory={() => setHistoryExpanded((v) => !v)}
      form={form}
      formError={formError}
      submitting={write.isPending && pending === null}
      notice={notice}
      pendingCommitmentId={pending}
      onOpenForm={(kind, commitmentId) => {
        setNotice(null);
        setFormError(null);
        setForm(initialForm(kind, new Date(), commitmentId ?? null));
      }}
      onCloseForm={() => {
        setForm(null);
        setFormError(null);
      }}
      onField={(name, value) => setForm((f) => (f ? { ...f, values: { ...f.values, [name]: value } } : f))}
      onSubmit={() => {
        if (!form) return;
        const built = buildFormRequest(form, partyId, new Date());
        if (!built.ok) {
          setFormError(built.error);
          return;
        }
        setFormError(null);
        write.mutate(built.request, {
          onSuccess: () => {
            setForm(null);
            setNotice({ text: WRITTEN[form.kind], failed: false });
            refresh();
          },
          onError: (error) => setFormError(apiErrorMessage(error, "That didn't go through. Try again.")),
        });
      }}
      onComplete={(commitmentId) => {
        setNotice(null);
        setPending(commitmentId);
        write.mutate(completeRequest(commitmentId), {
          onSuccess: () => {
            setNotice({ text: "Marked done.", failed: false });
            refresh();
          },
          onError: (error) => setNotice({ text: apiErrorMessage(error, "That didn't go through. Try again."), failed: true }),
          onSettled: () => setPending(null),
        });
      }}
    />
  );
}
