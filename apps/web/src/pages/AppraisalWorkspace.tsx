import { useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiErrorMessage, apiFetch } from "../lib/api";
import { useEntitlements } from "../lib/session";
import { SAVE_DUE_FOLLOW_UP_LABEL } from "../lib/growTerms";
import {
  APPRAISAL_NEXT_STEP_LABELS,
  APPRAISAL_OUTCOME_REASONS,
  appraisalNextSteps,
  appraisalOutcomeOptions,
  appraisalStatusLabel,
  type AppraisalOutcome,
} from "../lib/growAppraisals";
import {
  type AppraisalHistoryItem,
  type AppraisalListRow,
  type AppraisalTimelineEntry,
  appraisalContactPath,
  appraisalHistory,
  appraisalNextStepSummary,
  appraisalOutcomeReasonLabel,
  appraisalPricingLockedMessage,
  appraisalReadOnlyMessage,
  formatAppraisalDateTime,
  formatAppraisalMoney,
} from "../lib/appraisalUi";

// One Appraisal Workspace. GET /grow/appraisals/:id plus the pipeline row
// for names, the opportunity list for the origin, and the property timeline
// for history. Writes use the routes that already exist.

interface WorkspaceAppraisal {
  id: number;
  propertyId: number;
  partyId: number | null;
  opportunityId: number | null;
  ownerUserId: number | null;
  status: string;
  outcome: string | null;
  outcomeReason: string | null;
  outcomeNotes: string | null;
  priceRangeLow: string | null;
  priceRangeHigh: string | null;
  pricingCommentary: string | null;
  marketPositionNarrative: string | null;
  sellingStrategy: string | null;
  marketingProposal: string | null;
  commissionRatePercent: string | null;
  commissionProposal: string | null;
  recommendedNextSteps: string | null;
  appointmentAt: string | null;
  presentationAt: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  followUpAt: string | null;
  followUpNotes: string | null;
  outcomeAt: string | null;
  createdAt: string;
  updatedAt: string;
  isFinalised: boolean;
  finalisedSnapshot: unknown;
  presentationDocumentId: number | null;
}

interface ComparableSaleRow {
  id: number;
  address: string;
  salePrice: string | null;
  saleDate: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  carSpaces: number | null;
  notes: string | null;
}

interface MarketCompetitionRow {
  id: number;
  address: string;
  askingPriceDisplay: string | null;
  status: string | null;
  daysOnMarket: number | null;
  notes: string | null;
}

interface WorkspaceResponse {
  appraisal: WorkspaceAppraisal;
  comparableSales: ComparableSaleRow[];
  marketCompetition: MarketCompetitionRow[];
}

interface OpportunityRow {
  id: number;
  opportunityType: string;
  stage: string | null;
  reason: string | null;
}

interface DetailDraft {
  priceRangeLow: string;
  priceRangeHigh: string;
  pricingCommentary: string;
  marketPositionNarrative: string;
  sellingStrategy: string;
  marketingProposal: string;
  commissionRatePercent: string;
  commissionProposal: string;
  recommendedNextSteps: string;
}

function detailDraft(appraisal: WorkspaceAppraisal): DetailDraft {
  return {
    priceRangeLow: appraisal.priceRangeLow ?? "",
    priceRangeHigh: appraisal.priceRangeHigh ?? "",
    pricingCommentary: appraisal.pricingCommentary ?? "",
    marketPositionNarrative: appraisal.marketPositionNarrative ?? "",
    sellingStrategy: appraisal.sellingStrategy ?? "",
    marketingProposal: appraisal.marketingProposal ?? "",
    commissionRatePercent: appraisal.commissionRatePercent ?? "",
    commissionProposal: appraisal.commissionProposal ?? "",
    recommendedNextSteps: appraisal.recommendedNextSteps ?? "",
  };
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function appraisalActionError(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return "That couldn't be found.";
  if (error instanceof ApiError && error.status === 400) return apiErrorMessage(error, "Check the details and try again.");
  if (error instanceof ApiError && error.status === 403) {
    return apiErrorMessage(error, "You don't have permission to update this appraisal.");
  }
  if (error instanceof ApiError && error.status === 409) {
    return apiErrorMessage(error, "That step isn't available for this appraisal.");
  }
  return apiErrorMessage(error, "Couldn't update that appraisal. Try again.");
}

function parseAppraisalId(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const id = Number(value);
  return id <= 2_147_483_647 ? id : null;
}

export default function AppraisalWorkspace() {
  const params = useParams<{ id: string }>();
  const appraisalId = parseAppraisalId(params.id);
  const queryClient = useQueryClient();
  const { hasEntitlement } = useEntitlements();
  const canRead = hasEntitlement("grow.access");
  const canWrite = canRead && hasEntitlement("grow.opportunities.manage");
  const canHandOff = canRead && hasEntitlement("run.access");

  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const [outcome, setOutcome] = useState<AppraisalOutcome>("WON");
  const [outcomeReason, setOutcomeReason] = useState("");
  const [outcomeNotes, setOutcomeNotes] = useState("");
  const [followUpAt, setFollowUpAt] = useState("");
  const [followUpNotes, setFollowUpNotes] = useState("");
  const [details, setDetails] = useState<DetailDraft | null>(null);
  const [comparableAddress, setComparableAddress] = useState("");
  const [comparablePrice, setComparablePrice] = useState("");
  const [comparableNotes, setComparableNotes] = useState("");
  const [competitionAddress, setCompetitionAddress] = useState("");
  const [competitionPrice, setCompetitionPrice] = useState("");
  const [competitionStatus, setCompetitionStatus] = useState("");
  const [sendOpen, setSendOpen] = useState(false);
  const [sendSubject, setSendSubject] = useState("");
  const [sendBody, setSendBody] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const workspace = useQuery<WorkspaceResponse>({
    queryKey: ["grow-appraisal-workspace", appraisalId],
    queryFn: () => apiFetch(`/grow/appraisals/${appraisalId}`),
    enabled: canRead && appraisalId !== null,
  });
  const pipeline = useQuery<{ appraisals: AppraisalListRow[] }>({
    queryKey: ["grow-appraisals"],
    queryFn: () => apiFetch("/grow/appraisals/pipeline"),
    enabled: canRead && appraisalId !== null,
  });
  const opportunities = useQuery<{ opportunities: OpportunityRow[] }>({
    queryKey: ["grow-opportunities"],
    queryFn: () => apiFetch("/grow/opportunities"),
    enabled: canRead && appraisalId !== null,
  });
  const propertyId = workspace.data?.appraisal.propertyId ?? null;
  const timeline = useQuery<{ timeline: AppraisalTimelineEntry[] }>({
    queryKey: ["property-timeline", propertyId],
    queryFn: () => apiFetch(`/properties/${propertyId}/timeline`),
    enabled: canRead && propertyId !== null,
  });

  function refresh() {
    setErrorMessage(null);
    setOutcomeOpen(false);
    setOutcomeReason("");
    setOutcomeNotes("");
    setDetails(null);
    setComparableAddress("");
    setComparablePrice("");
    setComparableNotes("");
    setCompetitionAddress("");
    setCompetitionPrice("");
    setCompetitionStatus("");
    setSendOpen(false);
    setSendSubject("");
    setSendBody("");
    if (appraisalId !== null) {
      queryClient.invalidateQueries({ queryKey: ["grow-appraisal-workspace", appraisalId] });
    }
    queryClient.invalidateQueries({ queryKey: ["grow-appraisals"] });
    queryClient.invalidateQueries({ queryKey: ["grow-opportunities"] });
    queryClient.invalidateQueries({ queryKey: ["grow-today"] });
    if (propertyId !== null) {
      queryClient.invalidateQueries({ queryKey: ["property-timeline", propertyId] });
      queryClient.invalidateQueries({ queryKey: ["property-workspace", propertyId] });
    }
  }

  const changeStatus = useMutation({
    mutationFn: (toStatus: string) =>
      apiFetch(`/grow/appraisals/${appraisalId}/status`, {
        method: "POST",
        body: JSON.stringify({ toStatus }),
      }),
    onSuccess: refresh,
    onError: (error) => setErrorMessage(appraisalActionError(error)),
  });
  const recordOutcome = useMutation({
    mutationFn: (body: { outcome: string; outcomeReason?: string; outcomeNotes?: string }) =>
      apiFetch(`/grow/appraisals/${appraisalId}/outcome`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: refresh,
    onError: (error) => setErrorMessage(appraisalActionError(error)),
  });
  const scheduleFollowUp = useMutation({
    mutationFn: (body: { followUpAt: string; followUpNotes?: string }) =>
      apiFetch(`/grow/appraisals/${appraisalId}/follow-up`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setFollowUpAt("");
      setFollowUpNotes("");
      refresh();
    },
    onError: (error) => setErrorMessage(appraisalActionError(error)),
  });
  const saveDetails = useMutation({
    mutationFn: (body: Record<string, string | null>) =>
      apiFetch(`/grow/appraisals/${appraisalId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: refresh,
    onError: (error) => setErrorMessage(appraisalActionError(error)),
  });
  const addComparable = useMutation({
    mutationFn: (body: { address: string; salePrice?: string; notes?: string }) =>
      apiFetch(`/grow/appraisals/${appraisalId}/comparable-sales`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: refresh,
    onError: (error) => setErrorMessage(appraisalActionError(error)),
  });
  const removeComparable = useMutation({
    mutationFn: (saleId: number) =>
      apiFetch(`/grow/appraisals/${appraisalId}/comparable-sales/${saleId}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: (error) => setErrorMessage(appraisalActionError(error)),
  });
  const addCompetition = useMutation({
    mutationFn: (body: { address: string; askingPriceDisplay?: string; status?: string }) =>
      apiFetch(`/grow/appraisals/${appraisalId}/market-competition`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: refresh,
    onError: (error) => setErrorMessage(appraisalActionError(error)),
  });
  const removeCompetition = useMutation({
    mutationFn: (itemId: number) =>
      apiFetch(`/grow/appraisals/${appraisalId}/market-competition/${itemId}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: (error) => setErrorMessage(appraisalActionError(error)),
  });
  const sendAppraisal = useMutation({
    mutationFn: (body: { subject?: string; bodyText?: string }) =>
      apiFetch(`/grow/appraisals/${appraisalId}/send`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: refresh,
    onError: (error) => setErrorMessage(appraisalActionError(error)),
  });
  const draftMarketPosition = useMutation({
    mutationFn: () => apiFetch(`/grow/appraisals/${appraisalId}/market-position/generate`, { method: "POST" }),
    onSuccess: refresh,
    onError: (error) => setErrorMessage(appraisalActionError(error)),
  });
  const createPresentation = useMutation({
    mutationFn: () => apiFetch(`/grow/appraisals/${appraisalId}/presentation/generate`, { method: "POST" }),
    onSuccess: refresh,
    onError: (error) => setErrorMessage(appraisalActionError(error)),
  });
  const finalise = useMutation({
    mutationFn: () => apiFetch(`/appraisals/by-property/${propertyId}/finalise`, { method: "POST" }),
    onSuccess: refresh,
    onError: (error) => setErrorMessage(appraisalActionError(error)),
  });
  const handOff = useMutation({
    mutationFn: () => apiFetch(`/grow/appraisals/${appraisalId}/run-handoff`, { method: "POST" }),
    onSuccess: refresh,
    onError: (error) => setErrorMessage(appraisalActionError(error)),
  });

  if (!canRead) {
    return (
      <div>
        <h1>Appraisal</h1>
        <p className="muted">Grow is not active for your brokerage.</p>
      </div>
    );
  }
  if (appraisalId === null) {
    return (
      <div>
        <h1>Appraisal</h1>
        <p className="empty-state">That appraisal couldn't be found.</p>
      </div>
    );
  }
  if (workspace.isLoading) return <div className="app-loading">Loading…</div>;
  if (workspace.isError) {
    const missing = workspace.error instanceof ApiError && workspace.error.status === 404;
    return (
      <div>
        <p className="muted">
          <Link href="/grow/appraisals">Appraisals</Link>
        </p>
        <h1>Appraisal</h1>
        <p className="error-text">
          {missing ? "That appraisal couldn't be found." : apiErrorMessage(workspace.error, "Couldn't load this appraisal.")}
        </p>
      </div>
    );
  }
  if (!workspace.data) return <div className="app-loading">Loading…</div>;

  const appraisal = workspace.data.appraisal;
  const summary = pipeline.data?.appraisals.find((row) => row.id === appraisal.id) ?? null;
  const address = summary?.propertyAddress ?? `Property ${appraisal.propertyId}`;
  const contactName = summary?.partyDisplayName?.trim() || null;
  const ownerName = summary?.ownerName?.trim() || null;
  const opportunity =
    appraisal.opportunityId === null
      ? null
      : (opportunities.data?.opportunities.find((row) => row.id === appraisal.opportunityId) ?? null);
  const readOnlyMessage = appraisalReadOnlyMessage(appraisal);
  const pricingLockedMessage = appraisalPricingLockedMessage(appraisal);
  const canEdit = canWrite && readOnlyMessage === null;
  const canEditPricing = canEdit && pricingLockedMessage === null;
  const steps = canEdit ? appraisalNextSteps(appraisal.status) : [];
  const outcomes = canEdit ? appraisalOutcomeOptions(appraisal.status) : [];
  const draft = details ?? detailDraft(appraisal);
  const history: AppraisalHistoryItem[] = appraisalHistory(appraisal, timeline.data?.timeline ?? []);
  const low = formatAppraisalMoney(appraisal.priceRangeLow);
  const high = formatAppraisalMoney(appraisal.priceRangeHigh);
  const priceLabel = low && high ? `${low} – ${high}` : null;
  const busy =
    changeStatus.isPending ||
    recordOutcome.isPending ||
    scheduleFollowUp.isPending ||
    saveDetails.isPending ||
    addComparable.isPending ||
    removeComparable.isPending ||
    addCompetition.isPending ||
    removeCompetition.isPending ||
    sendAppraisal.isPending ||
    draftMarketPosition.isPending ||
    createPresentation.isPending ||
    finalise.isPending ||
    handOff.isPending;
  const won = appraisal.status === "WON" || appraisal.outcome === "WON";

  function updateDetail(field: keyof DetailDraft, value: string) {
    setDetails({ ...draft, [field]: value });
  }

  function submitDetails() {
    const narrative = {
      marketPositionNarrative: blankToNull(draft.marketPositionNarrative),
      sellingStrategy: blankToNull(draft.sellingStrategy),
      marketingProposal: blankToNull(draft.marketingProposal),
      recommendedNextSteps: blankToNull(draft.recommendedNextSteps),
    };
    if (!canEditPricing) {
      saveDetails.mutate(narrative);
      return;
    }
    const lowValue = blankToNull(draft.priceRangeLow);
    const highValue = blankToNull(draft.priceRangeHigh);
    if ((lowValue === null) !== (highValue === null)) {
      setErrorMessage("Enter both the low and the high price, or leave both blank.");
      return;
    }
    saveDetails.mutate({
      priceRangeLow: lowValue,
      priceRangeHigh: highValue,
      pricingCommentary: blankToNull(draft.pricingCommentary),
      commissionRatePercent: blankToNull(draft.commissionRatePercent),
      commissionProposal: blankToNull(draft.commissionProposal),
      ...narrative,
    });
  }

  return (
    <div className="appraisal-workspace">
      <p className="muted">
        <Link href="/grow">Grow</Link>
        {" · "}
        <Link href="/grow/appraisals">Appraisals</Link>
      </p>
      <h1 id="appraisal-property">{address}</h1>
      <p className="muted">
        <Link href={`/properties/${appraisal.propertyId}`}>View property</Link>
      </p>

      <section className="card">
        <h2>Appraisal</h2>
        <p id="appraisal-status">
          Status: {appraisalStatusLabel(appraisal.status)}
          {appraisal.isFinalised ? " · Finalised" : ""}
        </p>
        <p id="appraisal-outcome-summary">
          Outcome: {appraisal.outcome ?? "Not recorded"}
          {appraisalOutcomeReasonLabel(appraisal.outcomeReason)
            ? ` — ${appraisalOutcomeReasonLabel(appraisal.outcomeReason)}`
            : ""}
        </p>
        {appraisal.outcomeNotes && <p>{appraisal.outcomeNotes}</p>}
        <p id="appraisal-contact">
          Contact:{" "}
          {appraisal.partyId !== null ? (
            <Link href={appraisalContactPath(appraisal.partyId)}>{contactName ?? "View contact"}</Link>
          ) : (
            "No contact"
          )}
        </p>
        <p id="appraisal-opportunity">
          Origin opportunity:{" "}
          {appraisal.opportunityId === null
            ? "None"
            : opportunity
              ? `${opportunity.opportunityType}${opportunity.reason ? ` — ${opportunity.reason}` : ""}${opportunity.stage ? ` (${opportunity.stage})` : ""}`
              : `Opportunity ${appraisal.opportunityId}`}
        </p>
        {ownerName && <p>Owner: {ownerName}</p>}
        {priceLabel && <p>Price range: {priceLabel}</p>}
        <p id="appraisal-next-step">Next step: {appraisalNextStepSummary(appraisal.status)}</p>
        {readOnlyMessage && (
          <p id="appraisal-readonly" className="muted">
            {readOnlyMessage}
          </p>
        )}
        {errorMessage && (
          <p className="error-text" role="alert">
            {errorMessage}
          </p>
        )}
      </section>

      {canEdit && (
        <section className="card">
          <h2>Actions</h2>
          <div className="appraisal-actions">
            {steps.map((step) => (
              <button
                key={step}
                type="button"
                className="btn btn-secondary btn-small"
                id={`appraisal-status-${step}`}
                disabled={busy}
                onClick={() => changeStatus.mutate(step)}
              >
                {APPRAISAL_NEXT_STEP_LABELS[step]}
              </button>
            ))}
            {outcomes.length > 0 && (
              <button
                type="button"
                className="btn btn-secondary btn-small"
                id="appraisal-record-outcome"
                disabled={busy}
                onClick={() => setOutcomeOpen((open) => !open)}
              >
                {outcomeOpen ? "Cancel" : "Record outcome"}
              </button>
            )}
          </div>
          {outcomeOpen && outcomes.length > 0 && (
            <form
              className="stack grow-inline-form"
              id="appraisal-outcome-form"
              onSubmit={(event) => {
                event.preventDefault();
                const notes = outcomeNotes.trim();
                recordOutcome.mutate({
                  outcome,
                  ...(outcomeReason ? { outcomeReason } : {}),
                  ...(notes ? { outcomeNotes: notes } : {}),
                });
              }}
            >
              <label htmlFor="appraisal-outcome">
                Outcome
                <select id="appraisal-outcome" value={outcome} onChange={(event) => setOutcome(event.target.value as AppraisalOutcome)}>
                  {outcomes.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="appraisal-outcome-reason">
                Reason (optional)
                <select id="appraisal-outcome-reason" value={outcomeReason} onChange={(event) => setOutcomeReason(event.target.value)}>
                  <option value="">No reason</option>
                  {APPRAISAL_OUTCOME_REASONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="appraisal-outcome-notes">
                Notes (optional)
                <textarea
                  id="appraisal-outcome-notes"
                  value={outcomeNotes}
                  rows={2}
                  onChange={(event) => setOutcomeNotes(event.target.value)}
                />
              </label>
              <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
                Save outcome
              </button>
            </form>
          )}
          <form
            className="stack grow-inline-form"
            id="appraisal-follow-up-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!followUpAt) {
                setErrorMessage("Choose a follow-up date.");
                return;
              }
              const when = new Date(followUpAt);
              if (Number.isNaN(when.getTime())) {
                setErrorMessage("Choose a follow-up date.");
                return;
              }
              const notes = followUpNotes.trim();
              scheduleFollowUp.mutate({
                followUpAt: when.toISOString(),
                ...(notes ? { followUpNotes: notes } : {}),
              });
            }}
          >
            <label htmlFor="appraisal-follow-up-at">
              Due follow-up
              <input
                id="appraisal-follow-up-at"
                type="datetime-local"
                value={followUpAt}
                onChange={(event) => setFollowUpAt(event.target.value)}
              />
            </label>
            <label htmlFor="appraisal-follow-up-notes">
              Follow-up notes (optional)
              <textarea
                id="appraisal-follow-up-notes"
                value={followUpNotes}
                rows={2}
                onChange={(event) => setFollowUpNotes(event.target.value)}
              />
            </label>
            <button className="btn btn-secondary btn-small" type="submit" disabled={busy}>
              {SAVE_DUE_FOLLOW_UP_LABEL}
            </button>
          </form>
        </section>
      )}

      <section className="card">
        <h2>Price and proposal</h2>
        {canEdit ? (
          <div className="stack">
            {canEditPricing ? (
              <>
                <label htmlFor="appraisal-price-low">
                  Price range low
                  <input id="appraisal-price-low" value={draft.priceRangeLow} onChange={(event) => updateDetail("priceRangeLow", event.target.value)} />
                </label>
                <label htmlFor="appraisal-price-high">
                  Price range high
                  <input id="appraisal-price-high" value={draft.priceRangeHigh} onChange={(event) => updateDetail("priceRangeHigh", event.target.value)} />
                </label>
                <label htmlFor="appraisal-pricing-commentary">
                  Pricing commentary
                  <textarea
                    id="appraisal-pricing-commentary"
                    value={draft.pricingCommentary}
                    rows={3}
                    onChange={(event) => updateDetail("pricingCommentary", event.target.value)}
                  />
                </label>
              </>
            ) : (
              <div className="stack">
                <p id="appraisal-pricing-locked" className="muted">
                  {pricingLockedMessage}
                </p>
                <p>{priceLabel ?? "No price range"}</p>
                {appraisal.pricingCommentary && <p>{appraisal.pricingCommentary}</p>}
              </div>
            )}
            <label htmlFor="appraisal-market-position">
              Market position
              <textarea
                id="appraisal-market-position"
                value={draft.marketPositionNarrative}
                rows={3}
                onChange={(event) => updateDetail("marketPositionNarrative", event.target.value)}
              />
            </label>
            <label htmlFor="appraisal-selling-strategy">
              Selling strategy
              <textarea
                id="appraisal-selling-strategy"
                value={draft.sellingStrategy}
                rows={3}
                onChange={(event) => updateDetail("sellingStrategy", event.target.value)}
              />
            </label>
            <label htmlFor="appraisal-marketing">
              Marketing
              <textarea
                id="appraisal-marketing"
                value={draft.marketingProposal}
                rows={3}
                onChange={(event) => updateDetail("marketingProposal", event.target.value)}
              />
            </label>
            {canEditPricing ? (
              <>
                <label htmlFor="appraisal-commission-rate">
                  Commission rate (%)
                  <input
                    id="appraisal-commission-rate"
                    value={draft.commissionRatePercent}
                    onChange={(event) => updateDetail("commissionRatePercent", event.target.value)}
                  />
                </label>
                <label htmlFor="appraisal-commission">
                  Fee proposal
                  <textarea
                    id="appraisal-commission"
                    value={draft.commissionProposal}
                    rows={2}
                    onChange={(event) => updateDetail("commissionProposal", event.target.value)}
                  />
                </label>
              </>
            ) : (
              <>
                {appraisal.commissionRatePercent && <p>Commission rate: {appraisal.commissionRatePercent}%</p>}
                {appraisal.commissionProposal && <p>{appraisal.commissionProposal}</p>}
              </>
            )}
            <label htmlFor="appraisal-recommended-steps">
              Recommended next steps
              <textarea
                id="appraisal-recommended-steps"
                value={draft.recommendedNextSteps}
                rows={2}
                onChange={(event) => updateDetail("recommendedNextSteps", event.target.value)}
              />
            </label>
            <button id="appraisal-save-details" className="btn btn-primary btn-small" type="button" disabled={busy} onClick={submitDetails}>
              Save details
            </button>
          </div>
        ) : (
          <div className="stack">
            <p>{priceLabel ?? "No price range"}</p>
            {appraisal.pricingCommentary && <p>{appraisal.pricingCommentary}</p>}
            {appraisal.marketPositionNarrative && <p>{appraisal.marketPositionNarrative}</p>}
            {appraisal.sellingStrategy && <p>{appraisal.sellingStrategy}</p>}
            {appraisal.marketingProposal && <p>{appraisal.marketingProposal}</p>}
            {appraisal.commissionProposal && <p>{appraisal.commissionProposal}</p>}
            {appraisal.recommendedNextSteps && <p>{appraisal.recommendedNextSteps}</p>}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Comparable sales</h2>
        {workspace.data.comparableSales.length === 0 && <p className="empty-state">No comparable sales yet.</p>}
        {workspace.data.comparableSales.length > 0 && (
          <ul className="item-list">
            {workspace.data.comparableSales.map((sale) => (
              <li key={sale.id}>
                <p>
                  {sale.address}
                  {formatAppraisalMoney(sale.salePrice) ? ` — ${formatAppraisalMoney(sale.salePrice)}` : ""}
                  {sale.notes ? ` — ${sale.notes}` : ""}
                </p>
                {canEditPricing && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    id={`appraisal-comparable-remove-${sale.id}`}
                    disabled={busy}
                    onClick={() => removeComparable.mutate(sale.id)}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEditPricing && (
          <form
            className="stack grow-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              const addressValue = comparableAddress.trim();
              if (!addressValue) {
                setErrorMessage("Enter the comparable sale address.");
                return;
              }
              const price = blankToNull(comparablePrice);
              const notes = blankToNull(comparableNotes);
              addComparable.mutate({
                address: addressValue,
                ...(price ? { salePrice: price } : {}),
                ...(notes ? { notes } : {}),
              });
            }}
          >
            <label htmlFor="appraisal-comparable-address">
              Address
              <input
                id="appraisal-comparable-address"
                value={comparableAddress}
                onChange={(event) => setComparableAddress(event.target.value)}
              />
            </label>
            <label htmlFor="appraisal-comparable-price">
              Sale price (optional)
              <input id="appraisal-comparable-price" value={comparablePrice} onChange={(event) => setComparablePrice(event.target.value)} />
            </label>
            <label htmlFor="appraisal-comparable-notes">
              Notes (optional)
              <input id="appraisal-comparable-notes" value={comparableNotes} onChange={(event) => setComparableNotes(event.target.value)} />
            </label>
            <button id="appraisal-add-comparable" className="btn btn-secondary btn-small" type="submit" disabled={busy}>
              Add comparable sale
            </button>
          </form>
        )}
      </section>

      <section className="card">
        <h2>Market competition</h2>
        {workspace.data.marketCompetition.length === 0 && <p className="empty-state">No competition listed yet.</p>}
        {workspace.data.marketCompetition.length > 0 && (
          <ul className="item-list">
            {workspace.data.marketCompetition.map((item) => (
              <li key={item.id}>
                <p>
                  {item.address}
                  {item.askingPriceDisplay ? ` — ${item.askingPriceDisplay}` : ""}
                  {item.status ? ` — ${item.status}` : ""}
                </p>
                {canEditPricing && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    disabled={busy}
                    onClick={() => removeCompetition.mutate(item.id)}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEditPricing && (
          <form
            className="stack grow-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              const addressValue = competitionAddress.trim();
              if (!addressValue) {
                setErrorMessage("Enter the competing listing address.");
                return;
              }
              const price = blankToNull(competitionPrice);
              const status = blankToNull(competitionStatus);
              addCompetition.mutate({
                address: addressValue,
                ...(price ? { askingPriceDisplay: price } : {}),
                ...(status ? { status } : {}),
              });
            }}
          >
            <label htmlFor="appraisal-competition-address">
              Address
              <input
                id="appraisal-competition-address"
                value={competitionAddress}
                onChange={(event) => setCompetitionAddress(event.target.value)}
              />
            </label>
            <label htmlFor="appraisal-competition-price">
              Asking price (optional)
              <input
                id="appraisal-competition-price"
                value={competitionPrice}
                onChange={(event) => setCompetitionPrice(event.target.value)}
              />
            </label>
            <button className="btn btn-secondary btn-small" type="submit" disabled={busy}>
              Add competition
            </button>
          </form>
        )}
      </section>

      {canEdit && (
        <section className="card">
          <h2>Share</h2>
          <div className="appraisal-actions">
            <button
              type="button"
              className="btn btn-secondary btn-small"
              id="appraisal-send-toggle"
              disabled={busy}
              onClick={() => setSendOpen((open) => !open)}
            >
              {sendOpen ? "Cancel send" : "Send appraisal"}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              id="appraisal-market-position-generate"
              disabled={busy}
              onClick={() => draftMarketPosition.mutate()}
            >
              Draft market position
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              id="appraisal-presentation-generate"
              disabled={busy}
              onClick={() => createPresentation.mutate()}
            >
              Create presentation
            </button>
            {canEditPricing && (
              <button
                type="button"
                className="btn btn-primary btn-small"
                id="appraisal-finalise"
                disabled={busy || !appraisal.priceRangeLow || !appraisal.priceRangeHigh}
                onClick={() => finalise.mutate()}
              >
                Finalise appraisal
              </button>
            )}
          </div>
          {sendOpen && (
            <form
              className="stack grow-inline-form"
              id="appraisal-send-form"
              onSubmit={(event) => {
                event.preventDefault();
                const subject = sendSubject.trim();
                const bodyText = sendBody.trim();
                sendAppraisal.mutate({
                  ...(subject ? { subject } : {}),
                  ...(bodyText ? { bodyText } : {}),
                });
              }}
            >
              <label htmlFor="appraisal-send-subject">
                Subject (optional)
                <input id="appraisal-send-subject" value={sendSubject} onChange={(event) => setSendSubject(event.target.value)} />
              </label>
              <label htmlFor="appraisal-send-body">
                Message (optional)
                <textarea id="appraisal-send-body" value={sendBody} rows={3} onChange={(event) => setSendBody(event.target.value)} />
              </label>
              <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
                Send
              </button>
            </form>
          )}
          {appraisal.presentationDocumentId !== null && <p className="muted">Presentation document {appraisal.presentationDocumentId}</p>}
        </section>
      )}

      {won && canHandOff && (
        <section className="card">
          <h2>Run</h2>
          <p className="muted">Hand this won appraisal to Run. The appraisal record itself stays as it is.</p>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            id="appraisal-run-handoff"
            disabled={busy}
            onClick={() => handOff.mutate()}
          >
            Hand off to Run
          </button>
        </section>
      )}

      <section className="card">
        <h2>History</h2>
        {timeline.isError && <p className="muted">The property history couldn't be loaded.</p>}
        {history.length === 0 && <p className="empty-state">No history yet.</p>}
        {history.length > 0 && (
          <ul className="timeline" id="appraisal-history">
            {history.map((item) => (
              <li key={`${item.at}|${item.label}`}>
                <span className="when">{formatAppraisalDateTime(item.at)}</span> {item.label}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
