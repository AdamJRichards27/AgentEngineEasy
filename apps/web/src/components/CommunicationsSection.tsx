// Agent Engine 2.0 -- Communications Hub (Priority 8), Section 32's
// "Property Communications section" + "Message Detail" + "Composer".
// Self-contained (owns its own queries/mutations) and dropped into the
// Property Workspace as a single component -- mirrors how AskAgentEngine
// is embedded there, rather than threading yet more state/mutations
// through PropertyWorkspace.tsx's already-large top-level function.
//
// Section 13's "restrained composer": one thread, one resolved recipient
// (chosen from the thread's existing participants -- add one first via the
// controls below), a channel, a classification, and either a template or a
// hand-written body. There is no bulk/multi-recipient send anywhere here.
//
// AE GROW PRIORITY 3 -- Contact 360 reuses this exact composer rather than
// a second one. ThreadDetailBlock/AddParticipantControls, which used to
// take a hardcoded `propertyId` purely to fetch recipient candidates, now
// take a small `RecipientSource` (a query key + fetch function) instead --
// the only change needed to make them work identically for a property-
// anchored thread (CommunicationsSection, unchanged public API below) and
// a contact-anchored one (ContactCommunicationsSection, new). ComposerForm
// and MessageRow were already generic over threadId/participants and
// needed no such change; ComposerForm gained two small optional props
// (initialChannel, and auto-selecting the recipient when there is exactly
// one participant) purely so a Contact 360 Email/SMS click can land the
// user straight in a ready-to-send composer -- see ContactCommunicationsSection
// below for how those are used.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import {
  COMMUNICATION_CHANNELS,
  COMMUNICATION_CLASSIFICATIONS,
  addManualParticipant,
  addParticipantFromParty,
  approveMessage,
  cancelMessage,
  channelLabel,
  classificationLabel,
  communicationStatusLabel,
  communicationStatusPillClass,
  createCommunicationThread,
  createContactCommunicationThread,
  createDraftMessage,
  fetchContactRecipientCandidates,
  fetchRecipientCandidates,
  fetchTemplates,
  fetchThreadDetail,
  fetchThreadsForParty,
  fetchThreadsForProperty,
  requestApproval,
  requeueMessage,
  sendMessageNow,
  type CandidateRecipient,
  type CommunicationChannel,
  type CommunicationClassification,
  type CommunicationMessage,
  type CommunicationParticipant,
} from "../lib/communications";

// A source of recipient candidates for a thread's "+ Add recipient"
// control -- either a property's linked parties or (AE Grow Priority 3) a
// single contact -- kept as data rather than a propertyId so
// ThreadDetailBlock/AddParticipantControls don't need to know which kind
// of anchor a thread has.
interface RecipientSource {
  queryKey: unknown[];
  fetch: () => Promise<{ candidates: CandidateRecipient[] }>;
}

export function CommunicationsSection({ propertyId }: { propertyId: number }) {
  const queryClient = useQueryClient();
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [showNewThread, setShowNewThread] = useState(false);
  const [newSubject, setNewSubject] = useState("");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["communications-threads", propertyId],
    queryFn: () => fetchThreadsForProperty(propertyId),
  });

  const invalidateThreads = () => queryClient.invalidateQueries({ queryKey: ["communications-threads", propertyId] });

  const recipientSource: RecipientSource = {
    queryKey: ["communications-recipients", "property", propertyId],
    fetch: () => fetchRecipientCandidates(propertyId),
  };

  const createThreadMut = useMutation({
    mutationFn: (subject: string) => createCommunicationThread(propertyId, { subject }),
    onSuccess: (thread) => {
      setNewSubject("");
      setShowNewThread(false);
      invalidateThreads();
      setSelectedThreadId(thread.id);
    },
  });

  const threads = data?.threads ?? [];

  return (
    <section className="card">
      <h2>Communications</h2>

      {isLoading ? (
        <p className="muted">Loading communications…</p>
      ) : isError ? (
        <p className="error-text">Couldn't load communications for this property.</p>
      ) : threads.length === 0 ? (
        <p className="muted">No communication threads yet.</p>
      ) : (
        <ul className="item-list">
          {threads.map((t) => (
            <li key={t.id}>
              <div className="pc-item-header">
                <button
                  type="button"
                  className="btn btn-link"
                  onClick={() => setSelectedThreadId((cur) => (cur === t.id ? null : t.id))}
                >
                  {t.subject}
                </button>
                <span className="muted">{new Date(t.lastActivityAt).toLocaleString()}</span>
              </div>
              {selectedThreadId === t.id && (
                <ThreadDetailBlock threadId={t.id} recipientSource={recipientSource} onChanged={invalidateThreads} />
              )}
            </li>
          ))}
        </ul>
      )}

      {!showNewThread ? (
        <button type="button" className="btn btn-secondary" onClick={() => setShowNewThread(true)}>
          + New Thread
        </button>
      ) : (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newSubject.trim()) return;
            createThreadMut.mutate(newSubject.trim());
          }}
        >
          <input
            value={newSubject}
            onChange={(e) => setNewSubject(e.target.value)}
            placeholder="Thread subject (e.g. Contract signing)"
            required
          />
          <button className="btn btn-primary btn-small" type="submit" disabled={createThreadMut.isPending}>
            Create
          </button>
          <button type="button" className="btn btn-link btn-small" onClick={() => setShowNewThread(false)}>
            Cancel
          </button>
        </form>
      )}
    </section>
  );
}

// AE GROW PRIORITY 3 -- Contact 360's communications section. Thin
// integration by design (see this file's header comment): the thread
// list/detail/composer below are the exact same pieces
// CommunicationsSection uses, pointed at the new contact-first routes
// (lib/communications.ts's fetchThreadsForParty / fetchContactRecipientCandidates
// / createContactCommunicationThread) instead of the property-first ones.
// The one genuinely new piece is the Email/SMS quick-start below: rather
// than making a user create a thread, add the contact as a recipient, and
// then open the composer as three separate steps (the property-first flow
// above still requires exactly that), a single Email/SMS click here does
// all three and lands straight in a ready-to-send composer -- see
// quickStart below.
export function ContactCommunicationsSection({
  partyId,
  canStartThread,
  quickComposeChannel,
  onQuickComposeHandled,
}: {
  partyId: number;
  // Gates thread creation (Email/SMS quick-start and "+ New Thread") on
  // the grow.contacts.manage entitlement the server actually enforces on
  // POST /grow/contacts/:partyId/communications/threads -- reading the
  // thread/message history and composing/sending within an existing
  // thread reuse the Hub's original, ungated-by-Grow-entitlement routes,
  // so only the "start a new contact-first thread" action needs this.
  canStartThread: boolean;
  // Set (briefly) by an external trigger -- Grow Today's Email/SMS action
  // buttons -- to run the same quick-start flow as this section's own
  // Email/SMS buttons, without the user needing to click them again after
  // being navigated here. Cleared via onQuickComposeHandled once handled.
  quickComposeChannel?: CommunicationChannel | null;
  onQuickComposeHandled?: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [autoComposeChannel, setAutoComposeChannel] = useState<CommunicationChannel | null>(null);
  const [showNewThread, setShowNewThread] = useState(false);
  const [newSubject, setNewSubject] = useState("");
  const [quickStartError, setQuickStartError] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["communications-threads", "party", partyId],
    queryFn: () => fetchThreadsForParty(partyId),
  });

  const { data: candidatesData } = useQuery({
    queryKey: ["communications-recipients", "party", partyId],
    queryFn: () => fetchContactRecipientCandidates(partyId),
  });
  const candidate = candidatesData?.candidates[0];

  const invalidateThreads = () => queryClient.invalidateQueries({ queryKey: ["communications-threads", "party", partyId] });

  const recipientSource: RecipientSource = {
    queryKey: ["communications-recipients", "party", partyId],
    fetch: () => fetchContactRecipientCandidates(partyId),
  };

  const createThreadMut = useMutation({
    mutationFn: (subject: string) => createContactCommunicationThread(partyId, { subject }),
    onSuccess: (thread) => {
      setNewSubject("");
      setShowNewThread(false);
      invalidateThreads();
      setAutoComposeChannel(null);
      setSelectedThreadId(thread.id);
    },
  });

  // Email/SMS quick-start: create a thread anchored to this contact, add
  // the contact itself as its one participant, then open straight into a
  // composer pre-set to that channel with that participant pre-selected
  // (ComposerForm below auto-selects the recipient when there's exactly
  // one). This is the "click Email or SMS, get a compose UI" flow Contact
  // 360 needs, without a second composer implementation.
  const quickStart = useMutation({
    mutationFn: async (channel: CommunicationChannel) => {
      const thread = await createContactCommunicationThread(partyId, { subject: channel === "EMAIL" ? "Email" : "SMS" });
      await addParticipantFromParty(thread.id, { partyId, role: "Contact" });
      return { thread, channel };
    },
    onSuccess: ({ thread, channel }) => {
      setQuickStartError(null);
      invalidateThreads();
      setSelectedThreadId(thread.id);
      setAutoComposeChannel(channel);
    },
    onError: (err: unknown) => setQuickStartError(err instanceof ApiError ? err.friendly : "Couldn't start that message."),
  });

  useEffect(() => {
    if (!quickComposeChannel) return;
    if (canStartThread && !quickStart.isPending) {
      quickStart.mutate(quickComposeChannel);
    }
    onQuickComposeHandled?.();
    // Only re-run when the external trigger itself changes -- quickStart
    // and onQuickComposeHandled are stable enough for this purpose and
    // including them would re-fire the effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickComposeChannel]);

  const threads = data?.threads ?? [];

  return (
    <section className="card">
      <h2>Communications</h2>
      <p className="muted">Email and SMS sent to this contact, and the history of every message — the same composer as a property's Communications section.</p>

      {canStartThread && (
        <div className="pc-item-actions">
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={!candidate?.email || quickStart.isPending}
            title={candidate?.email ? undefined : "No email on file for this contact"}
            onClick={() => quickStart.mutate("EMAIL")}
          >
            Email
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={!candidate?.mobile || quickStart.isPending}
            title={candidate?.mobile ? undefined : "No mobile on file for this contact"}
            onClick={() => quickStart.mutate("SMS")}
          >
            SMS
          </button>
        </div>
      )}
      {quickStartError && <p className="error-text">{quickStartError}</p>}

      {isLoading ? (
        <p className="muted">Loading communications…</p>
      ) : isError ? (
        <p className="error-text">Couldn't load communications for this contact.</p>
      ) : threads.length === 0 ? (
        <p className="muted">No communication threads yet.</p>
      ) : (
        <ul className="item-list">
          {threads.map((t) => (
            <li key={t.id}>
              <div className="pc-item-header">
                <button
                  type="button"
                  className="btn btn-link"
                  onClick={() => {
                    setAutoComposeChannel(null);
                    setSelectedThreadId((cur) => (cur === t.id ? null : t.id));
                  }}
                >
                  {t.subject}
                </button>
                <span className="muted">{new Date(t.lastActivityAt).toLocaleString()}</span>
              </div>
              {selectedThreadId === t.id && (
                <ThreadDetailBlock
                  threadId={t.id}
                  recipientSource={recipientSource}
                  onChanged={invalidateThreads}
                  initialComposerChannel={autoComposeChannel ?? undefined}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {canStartThread &&
        (!showNewThread ? (
          <button type="button" className="btn btn-link btn-small" onClick={() => setShowNewThread(true)}>
            + New Thread
          </button>
        ) : (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newSubject.trim()) return;
              createThreadMut.mutate(newSubject.trim());
            }}
          >
            <input
              value={newSubject}
              onChange={(e) => setNewSubject(e.target.value)}
              placeholder="Thread subject (e.g. Appraisal follow-up)"
              required
            />
            <button className="btn btn-primary btn-small" type="submit" disabled={createThreadMut.isPending}>
              Create
            </button>
            <button type="button" className="btn btn-link btn-small" onClick={() => setShowNewThread(false)}>
              Cancel
            </button>
          </form>
        ))}
    </section>
  );
}

function ThreadDetailBlock({
  threadId,
  recipientSource,
  onChanged,
  initialComposerChannel,
}: {
  threadId: number;
  recipientSource: RecipientSource;
  onChanged: () => void;
  // AE Grow Priority 3: when set, the composer below opens immediately
  // with this channel preselected, rather than requiring a second
  // "+ Compose Message" click -- see ContactCommunicationsSection's
  // quick-start above. Undefined for the property-first flow, which keeps
  // its original two-step "expand thread, then compose" behaviour.
  initialComposerChannel?: CommunicationChannel;
}) {
  const queryClient = useQueryClient();
  const [showComposer, setShowComposer] = useState(initialComposerChannel != null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["communications-thread", threadId],
    queryFn: () => fetchThreadDetail(threadId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["communications-thread", threadId] });
    onChanged();
  };

  if (isLoading) return <p className="muted">Loading thread…</p>;
  if (isError || !data) return <p className="error-text">Couldn't load this thread.</p>;

  return (
    <div className="stack" style={{ marginTop: "0.75rem", marginLeft: "1rem" }}>
      <div>
        <strong>Participants:</strong>{" "}
        {data.participants.length === 0 ? (
          <span className="muted">None yet.</span>
        ) : (
          <span className="muted">{data.participants.map((p) => `${p.displayName} (${p.role})`).join(", ")}</span>
        )}
      </div>
      <AddParticipantControls threadId={threadId} recipientSource={recipientSource} onAdded={invalidate} />

      {data.messages.length === 0 ? (
        <p className="muted">No messages in this thread yet.</p>
      ) : (
        <ul className="item-list">
          {data.messages.map((m) => (
            <MessageRow key={m.id} message={m} onChanged={invalidate} />
          ))}
        </ul>
      )}

      {!showComposer ? (
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setShowComposer(true)}>
          + Compose Message
        </button>
      ) : (
        <ComposerForm
          threadId={threadId}
          participants={data.participants}
          initialChannel={initialComposerChannel}
          onSent={() => {
            setShowComposer(false);
            invalidate();
          }}
          onCancel={() => setShowComposer(false)}
        />
      )}
    </div>
  );
}

function AddParticipantControls({
  threadId,
  recipientSource,
  onAdded,
}: {
  threadId: number;
  recipientSource: RecipientSource;
  onAdded: () => void;
}) {
  const [mode, setMode] = useState<"closed" | "party" | "manual">("closed");
  const [selectedPartyId, setSelectedPartyId] = useState("");
  const [role, setRole] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualRole, setManualRole] = useState("");
  const [manualEmail, setManualEmail] = useState("");
  const [manualMobile, setManualMobile] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: candidatesData } = useQuery({
    queryKey: recipientSource.queryKey,
    queryFn: recipientSource.fetch,
    enabled: mode === "party",
  });

  const addFromPartyMut = useMutation({
    mutationFn: () => addParticipantFromParty(threadId, { partyId: Number(selectedPartyId), role: role.trim() }),
    onSuccess: () => {
      setMode("closed");
      setSelectedPartyId("");
      setRole("");
      setError(null);
      onAdded();
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.friendly : "Couldn't add that recipient."),
  });

  const addManualMut = useMutation({
    mutationFn: () =>
      addManualParticipant(threadId, {
        displayName: manualName.trim(),
        role: manualRole.trim(),
        email: manualEmail.trim() || undefined,
        mobile: manualMobile.trim() || undefined,
        reason: manualReason.trim(),
      }),
    onSuccess: () => {
      setMode("closed");
      setManualName("");
      setManualRole("");
      setManualEmail("");
      setManualMobile("");
      setManualReason("");
      setError(null);
      onAdded();
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.friendly : "Couldn't add that recipient."),
  });

  if (mode === "closed") {
    return (
      <div className="pc-item-actions">
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setMode("party")}>
          + Add recipient
        </button>
        <button type="button" className="btn btn-link btn-small" onClick={() => setMode("manual")}>
          + Add manually
        </button>
      </div>
    );
  }

  if (mode === "party") {
    const candidates = candidatesData?.candidates ?? [];
    return (
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!selectedPartyId || !role.trim()) return;
          addFromPartyMut.mutate();
        }}
      >
        <select value={selectedPartyId} onChange={(e) => setSelectedPartyId(e.target.value)} required>
          <option value="">Choose a party…</option>
          {candidates.map((c) => (
            <option key={c.partyId} value={c.partyId}>
              {c.displayName} ({c.role}){c.isDuplicateContact ? " — duplicate contact" : ""}
            </option>
          ))}
        </select>
        <input placeholder="Role in this thread (e.g. Seller)" value={role} onChange={(e) => setRole(e.target.value)} required />
        <button className="btn btn-primary btn-small" type="submit" disabled={addFromPartyMut.isPending}>
          Add
        </button>
        <button type="button" className="btn btn-link btn-small" onClick={() => setMode("closed")}>
          Cancel
        </button>
        {candidates.length === 0 && <p className="muted">No candidate recipients found for this thread yet.</p>}
        {error && <p className="error-text">{error}</p>}
      </form>
    );
  }

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!manualName.trim() || !manualRole.trim() || !manualReason.trim()) return;
        addManualMut.mutate();
      }}
    >
      <input placeholder="Name" value={manualName} onChange={(e) => setManualName(e.target.value)} required />
      <input placeholder="Role (e.g. Supplier)" value={manualRole} onChange={(e) => setManualRole(e.target.value)} required />
      <input placeholder="Email (optional)" value={manualEmail} onChange={(e) => setManualEmail(e.target.value)} />
      <input placeholder="Mobile (optional)" value={manualMobile} onChange={(e) => setManualMobile(e.target.value)} />
      <input
        placeholder="Reason for adding manually (required)"
        value={manualReason}
        onChange={(e) => setManualReason(e.target.value)}
        required
      />
      <div className="pc-item-actions">
        <button className="btn btn-primary btn-small" type="submit" disabled={addManualMut.isPending}>
          Add
        </button>
        <button type="button" className="btn btn-link btn-small" onClick={() => setMode("closed")}>
          Cancel
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}

function ComposerForm({
  threadId,
  participants,
  initialChannel,
  onSent,
  onCancel,
}: {
  threadId: number;
  participants: CommunicationParticipant[];
  // AE Grow Priority 3: preselects the channel (EMAIL/SMS) the user
  // actually clicked, instead of always defaulting to EMAIL -- undefined
  // for the property-first flow.
  initialChannel?: CommunicationChannel;
  onSent: () => void;
  onCancel: () => void;
}) {
  // AE Grow Priority 3: when there's exactly one participant (always true
  // right after ContactCommunicationsSection's quick-start, which adds the
  // contact as the thread's only participant), pick it automatically --
  // one fewer click, and harmless for the property-first flow, which
  // simply keeps requiring a manual choice whenever there's more than one.
  const [recipientParticipantId, setRecipientParticipantId] = useState(() =>
    participants.length === 1 ? String(participants[0].id) : "",
  );
  const [channel, setChannel] = useState<CommunicationChannel>(initialChannel ?? "EMAIL");
  const [classification, setClassification] = useState<CommunicationClassification>("TRANSACTIONAL");
  const [templateId, setTemplateId] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [placeholderValues, setPlaceholderValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const { data: templatesData } = useQuery({
    queryKey: ["communications-templates", channel],
    queryFn: () => fetchTemplates({ channel, status: "ACTIVE" }),
  });

  const createMut = useMutation({
    mutationFn: () =>
      createDraftMessage(threadId, {
        channel,
        classification,
        recipientParticipantId: recipientParticipantId ? Number(recipientParticipantId) : undefined,
        subject: subject.trim() || undefined,
        bodyText: templateId ? undefined : bodyText,
        templateId: templateId ? Number(templateId) : undefined,
        placeholderValues: templateId ? placeholderValues : undefined,
      }),
    onSuccess: () => onSent(),
    onError: (err: unknown) => setError(err instanceof ApiError ? err.friendly : "Couldn't create this draft."),
  });

  const templates = templatesData?.templates ?? [];
  const selectedTemplate = templates.find((t) => String(t.id) === templateId);

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        createMut.mutate();
      }}
    >
      <select value={recipientParticipantId} onChange={(e) => setRecipientParticipantId(e.target.value)} required>
        <option value="">Recipient…</option>
        {participants.map((p) => (
          <option key={p.id} value={p.id}>
            {p.displayName} ({p.role})
          </option>
        ))}
      </select>
      {participants.length === 0 && <p className="muted">Add a recipient above before composing.</p>}

      <select value={channel} onChange={(e) => setChannel(e.target.value as CommunicationChannel)}>
        {COMMUNICATION_CHANNELS.map((c) => (
          <option key={c} value={c}>
            {channelLabel(c)}
          </option>
        ))}
      </select>

      <select value={classification} onChange={(e) => setClassification(e.target.value as CommunicationClassification)}>
        {COMMUNICATION_CLASSIFICATIONS.map((c) => (
          <option key={c} value={c}>
            {classificationLabel(c)}
          </option>
        ))}
      </select>

      <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
        <option value="">No template — write manually</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>

      {selectedTemplate ? (
        <div className="stack">
          {selectedTemplate.placeholders.length === 0 ? (
            <p className="muted">This template has no placeholders to fill in.</p>
          ) : (
            selectedTemplate.placeholders.map((key) => (
              <input
                key={key}
                placeholder={key}
                value={placeholderValues[key] ?? ""}
                onChange={(e) => setPlaceholderValues((prev) => ({ ...prev, [key]: e.target.value }))}
              />
            ))
          )}
          <p className="muted">This uses the template's approved wording — the fields above fill in the blanks.</p>
        </div>
      ) : (
        <>
          {channel !== "PHONE_CALL" && (
            <input placeholder="Subject (optional)" value={subject} onChange={(e) => setSubject(e.target.value)} />
          )}
          <textarea
            placeholder={channel === "PHONE_CALL" ? "Call outcome / notes" : "Message"}
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            rows={4}
            required={channel !== "PHONE_CALL"}
          />
        </>
      )}

      {error && <p className="error-text">{error}</p>}

      <div className="pc-item-actions">
        <button className="btn btn-primary btn-small" type="submit" disabled={createMut.isPending || !recipientParticipantId}>
          Save Draft
        </button>
        <button type="button" className="btn btn-link btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// Section 15: which lifecycle buttons are offered depends only on the
// message's current status — the server is the sole authority on whether
// the action is actually allowed (e.g. approval permissions, the
// transition table); a rejected action surfaces its reason inline rather
// than being silently hidden ahead of time.
function MessageRow({ message, onChanged }: { message: CommunicationMessage; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.friendly : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="pc-item">
      <div className="pc-item-header">
        <strong>{message.subject || channelLabel(message.channel)}</strong>
        <span className={communicationStatusPillClass(message.status)}>{communicationStatusLabel(message.status)}</span>
      </div>
      <p className="muted">
        {channelLabel(message.channel)} · {classificationLabel(message.classification)} · To{" "}
        {message.recipientDisplayName ?? message.recipientDestination ?? "an unresolved recipient"}
      </p>
      {message.bodyText && <p>{message.bodyText}</p>}
      {message.failureDetail && <p className="error-text">{message.failureDetail}</p>}
      {error && <p className="error-text">{error}</p>}

      <div className="pc-item-actions">
        {message.status === "DRAFT" && (
          <>
            <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => run(() => requestApproval(message.id, message.version))}>
              Request Approval
            </button>
            <button className="btn btn-primary btn-small" disabled={busy} onClick={() => run(() => sendMessageNow(message.id, message.version))}>
              Send Now
            </button>
            <button className="btn btn-link btn-small" disabled={busy} onClick={() => run(() => cancelMessage(message.id, message.version))}>
              Cancel
            </button>
          </>
        )}

        {message.status === "AWAITING_APPROVAL" && (
          <>
            <button className="btn btn-primary btn-small" disabled={busy} onClick={() => run(() => approveMessage(message.id, message.version))}>
              Approve
            </button>
            <button className="btn btn-link btn-small" disabled={busy} onClick={() => run(() => cancelMessage(message.id, message.version))}>
              Cancel
            </button>
          </>
        )}

        {message.status === "APPROVED" && (
          <>
            <button className="btn btn-primary btn-small" disabled={busy} onClick={() => run(() => sendMessageNow(message.id, message.version))}>
              Send
            </button>
            <button className="btn btn-link btn-small" disabled={busy} onClick={() => run(() => cancelMessage(message.id, message.version))}>
              Cancel
            </button>
          </>
        )}

        {(message.status === "BLOCKED_BY_CONSENT" || message.status === "BLOCKED_BY_COST_CONTROL") && (
          <>
            <button className="btn btn-primary btn-small" disabled={busy} onClick={() => run(() => requeueMessage(message.id, message.version))}>
              Retry
            </button>
            <button className="btn btn-link btn-small" disabled={busy} onClick={() => run(() => cancelMessage(message.id, message.version))}>
              Cancel
            </button>
          </>
        )}
      </div>
    </li>
  );
}
