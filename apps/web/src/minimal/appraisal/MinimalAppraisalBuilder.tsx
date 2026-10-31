import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "wouter";
import { apiErrorMessage, apiFetch } from "../../lib/api";
import { useEntitlements } from "../../lib/session";
import type { AppraisalListRow } from "../../lib/appraisalUi";
import {
  EMPTY_COMPARABLE_FORM,
  EMPTY_COMPETITION_FORM,
  type BuilderState,
  type BuilderWorkspace,
  type ComparableForm,
  type CompetitionForm,
  type RangeDraft,
  comparableBody,
  competitionBody,
  continueBuilder,
  followUpBody,
  goToBuilderStep,
  unsavedStepEdits,
  resumeBuilderState,
  initialBuilderState,
  rangeDraftFrom,
  rangePatchBody,
} from "./appraisalBuilderModel";
import { MinimalAppraisalBuilderMessage, MinimalAppraisalBuilderView, type FollowUpForm } from "./MinimalAppraisalBuilderView";
import "./appraisalBuilder.css";

// AE Minimal A seven-step Appraisal Builder page. Rendered only inside the
// Minimal shell (route selector selectAppraisalBuilderView; flag
// AE_MINIMAL_UX_ENABLED, default OFF). Every read and write is an existing
// route, under the same react-query keys as the classic AppraisalWorkspace:
//   GET    /grow/appraisals/:id                    ["grow-appraisal-workspace", id]
//   GET    /grow/appraisals/pipeline               ["grow-appraisals"] (address and contact name)
//   PATCH  /grow/appraisals/:id                    range, commentary, market narrative
//   POST   /grow/appraisals/:id/comparable-sales   and DELETE …/:saleId
//   POST   /grow/appraisals/:id/market-competition and DELETE …/:itemId
//   POST   /grow/appraisals/:id/presentation/generate
//   POST   /grow/appraisals/:id/follow-up
// No new endpoint, no migration, no browser draft storage.

const EMPTY_FOLLOW_UP: FollowUpForm = { date: "", time: "", notes: "" };

export default function MinimalAppraisalBuilder() {
  const params = useParams<{ id: string }>();
  const appraisalId = /^\d+$/.test(params.id ?? "") ? Number(params.id) : null;
  const queryClient = useQueryClient();
  const { hasEntitlement } = useEntitlements();
  const canWrite = hasEntitlement("grow.access") && hasEntitlement("grow.opportunities.manage");

  const workspace = useQuery<BuilderWorkspace>({
    queryKey: ["grow-appraisal-workspace", appraisalId],
    queryFn: () => apiFetch(`/grow/appraisals/${appraisalId}`),
    enabled: appraisalId !== null,
  });
  const pipeline = useQuery<{ appraisals: AppraisalListRow[] }>({
    queryKey: ["grow-appraisals"],
    queryFn: () => apiFetch("/grow/appraisals/pipeline"),
    enabled: appraisalId !== null,
  });

  const [state, setState] = useState<BuilderState>(initialBuilderState);
  // Keyboard and screen-reader users land on the new step's heading, not on
  // the Continue button that stayed in place (a11y pass, 19 Oct 2026).
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    if (typeof document !== "undefined") document.getElementById("ae-appraisal-step-title")?.focus();
  }, [state.step]);
  // AB-2: once the server workspace first loads, reopen at the furthest step it
  // supports instead of step 1. Applied once; later refreshes keep the agent's place.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || !workspace.data) return;
    resumed.current = true;
    const next = resumeBuilderState(workspace.data);
    // Don't steal focus on load: only the agent's own step changes move focus.
    if (next.step !== state.step) firstStep.current = true;
    setState(next);
  }, [workspace.data]);
  const [rangeEdit, setRangeEdit] = useState<RangeDraft | null>(null);
  const [narrativeEdit, setNarrativeEdit] = useState<string | null>(null);
  const [comparableForm, setComparableForm] = useState<ComparableForm>(EMPTY_COMPARABLE_FORM);
  const [competitionForm, setCompetitionForm] = useState<CompetitionForm>(EMPTY_COMPETITION_FORM);
  const [followUpForm, setFollowUpForm] = useState<FollowUpForm>(EMPTY_FOLLOW_UP);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // AB-6: first attempt to leave a step with unsaved typing warns; choosing the same target again discards.
  const [pendingLeave, setPendingLeave] = useState<number | null>(null);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["grow-appraisal-workspace", appraisalId] });
    void queryClient.invalidateQueries({ queryKey: ["grow-appraisals"] });
    void queryClient.invalidateQueries({ queryKey: ["grow-today"] });
  }

  function failed(fallback: string) {
    return (error: unknown) => {
      setNotice(null);
      setMessage(apiErrorMessage(error, fallback));
    };
  }

  function done(text: string) {
    return () => {
      setMessage(null);
      setNotice(text);
      refresh();
    };
  }

  const patch = useMutation({
    mutationFn: (body: Record<string, string | null>) =>
      apiFetch(`/grow/appraisals/${appraisalId}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      setRangeEdit(null);
      setNarrativeEdit(null);
      done("Saved.")();
    },
    onError: failed("Couldn't save. Try again."),
  });
  const addSale = useMutation({
    mutationFn: (body: unknown) =>
      apiFetch(`/grow/appraisals/${appraisalId}/comparable-sales`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setComparableForm(EMPTY_COMPARABLE_FORM);
      done("Comparable added.")();
    },
    onError: failed("Couldn't add the comparable. Try again."),
  });
  const removeSale = useMutation({
    mutationFn: (saleId: number) => apiFetch(`/grow/appraisals/${appraisalId}/comparable-sales/${saleId}`, { method: "DELETE" }),
    onSuccess: done("Comparable removed."),
    onError: failed("Couldn't remove the comparable. Try again."),
  });
  const addListing = useMutation({
    mutationFn: (body: unknown) =>
      apiFetch(`/grow/appraisals/${appraisalId}/market-competition`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setCompetitionForm(EMPTY_COMPETITION_FORM);
      done("Listing added.")();
    },
    onError: failed("Couldn't add the listing. Try again."),
  });
  const removeListing = useMutation({
    mutationFn: (itemId: number) => apiFetch(`/grow/appraisals/${appraisalId}/market-competition/${itemId}`, { method: "DELETE" }),
    onSuccess: done("Listing removed."),
    onError: failed("Couldn't remove the listing. Try again."),
  });
  const preview = useMutation({
    mutationFn: () => apiFetch(`/grow/appraisals/${appraisalId}/presentation/generate`, { method: "POST" }),
    onSuccess: done("Document preview built."),
    onError: failed("Couldn't build the document preview. Try again."),
  });
  const followUp = useMutation({
    mutationFn: (body: unknown) => apiFetch(`/grow/appraisals/${appraisalId}/follow-up`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setFollowUpForm(EMPTY_FOLLOW_UP);
      done("Due follow-up saved. It now shows on Today.")();
    },
    onError: failed("Couldn't save the due follow-up. Try again."),
  });

  if (appraisalId === null) return <MinimalAppraisalBuilderMessage text="That appraisal couldn't be found — it may have been removed." />;
  if (workspace.isLoading) return <p className="am-empty-note">Loading appraisal…</p>;
  if (workspace.isError) {
    return (
      <MinimalAppraisalBuilderMessage
        text={apiErrorMessage(workspace.error, "Couldn't load this appraisal.")}
        onRetry={() => void workspace.refetch()}
      />
    );
  }
  if (!workspace.data) return null;

  const ws = workspace.data;
  const row = pipeline.data?.appraisals.find((r) => r.id === ws.appraisal.id);
  const rangeDraft = rangeEdit ?? rangeDraftFrom(ws.appraisal);
  const narrativeDraft = narrativeEdit ?? ws.appraisal.marketPositionNarrative ?? "";
  const busy =
    patch.isPending || addSale.isPending || removeSale.isPending || addListing.isPending || removeListing.isPending || preview.isPending || followUp.isPending;

  function blockedByUnsaved(target: number): boolean {
    if (!canWrite) return false;
    const warning = unsavedStepEdits(state.step, { range: rangeEdit, narrative: narrativeEdit }, ws.appraisal);
    if (!warning) {
      setPendingLeave(null);
      return false;
    }
    if (pendingLeave === target) {
      setPendingLeave(null);
      setRangeEdit(null);
      setNarrativeEdit(null);
      return false;
    }
    setPendingLeave(target);
    setNotice(null);
    setMessage(warning);
    return true;
  }

  return (
    <MinimalAppraisalBuilderView
      workspace={ws}
      subject={{
        address: row?.propertyAddress ?? `Property ${ws.appraisal.propertyId}`,
        location: null,
        propertyHref: `/properties/${ws.appraisal.propertyId}`,
        contactName: row?.partyDisplayName ?? null,
        contactHref: ws.appraisal.partyId != null ? `/grow/contacts/${ws.appraisal.partyId}` : null,
      }}
      state={state}
      rangeDraft={rangeDraft}
      narrativeDraft={narrativeDraft}
      comparableForm={comparableForm}
      competitionForm={competitionForm}
      followUpForm={followUpForm}
      message={message}
      notice={notice}
      busy={busy}
      canWrite={canWrite}
      runAccess={hasEntitlement("run.access")}
      on={{
        continueStep: () => {
          if (blockedByUnsaved(state.step + 1)) return;
          const next = continueBuilder(state, { workspace: ws, rangeDraft }, { reviewOnly: !canWrite });
          setNotice(null);
          setMessage(next.message);
          setState(next.state);
          if (!next.message && typeof window !== "undefined") window.scrollTo(0, 0);
        },
        back: () => {
          if (blockedByUnsaved(state.step - 1)) return;
          setMessage(null);
          setState(goToBuilderStep(state, state.step - 1));
        },
        goTo: (n) => {
          if (n !== state.step && blockedByUnsaved(n)) return;
          setMessage(null);
          setState(goToBuilderStep(state, n));
        },
        setRange: (p) => {
          setRangeEdit({ ...rangeDraft, ...p });
        },
        saveRange: () => {
          const body = rangePatchBody(rangeDraft);
          if (!body) return;
          patch.mutate(body);
        },
        setComparable: (p) => setComparableForm((cur) => ({ ...cur, ...p })),
        addComparable: () => {
          const result = comparableBody(comparableForm);
          if (!result.ok) return setMessage(result.error);
          addSale.mutate(result.body);
        },
        removeComparable: (id) => removeSale.mutate(id),
        setCompetition: (p) => setCompetitionForm((cur) => ({ ...cur, ...p })),
        addCompetition: () => {
          const result = competitionBody(competitionForm);
          if (!result.ok) return setMessage(result.error);
          addListing.mutate(result.body);
        },
        removeCompetition: (id) => removeListing.mutate(id),
        setNarrative: (text) => setNarrativeEdit(text),
        saveNarrative: () => patch.mutate({ marketPositionNarrative: narrativeDraft.trim() || null }),
        buildPreview: () => preview.mutate(),
        setFollowUp: (p) => setFollowUpForm((cur) => ({ ...cur, ...p })),
        saveFollowUp: () => {
          const result = followUpBody(followUpForm);
          if (!result.ok) return setMessage(result.error);
          followUp.mutate(result.body);
        },
      }}
    />
  );
}
