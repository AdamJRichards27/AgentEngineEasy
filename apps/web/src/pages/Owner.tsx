import { useState } from "react";
import { Link } from "wouter";
import { useSession } from "../lib/session";
import { apiErrorMessage } from "../lib/api";
import {
  useOwnerStatus, useOwnerBrokerages, useCreateOwnerBrokerage,
  useRenameOwnerBrokerage, useOwnerContext,
} from "../lib/owner";
import "../components/Owner.css";

export default function Owner() {
  const { user } = useSession();
  const status = useOwnerStatus(!!user?.platformOwner);
  const brokerages = useOwnerBrokerages(!!user?.platformOwner && status.data?.isOwner === true);
  const create = useCreateOwnerBrokerage();
  const rename = useRenameOwnerBrokerage();
  const context = useOwnerContext();
  const [filter, setFilter] = useState("");
  const [name, setName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const busy = create.isPending || rename.isPending || context.isPending;
  const selectedId = user?.ownerSelectedBrokerageId;
  const rows = brokerages.data?.brokerages.filter((b) =>
    b.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())) ?? [];

  if (!user?.platformOwner || (status.data && !status.data.isOwner)) {
    return <div className="primary-action">
      <p className="eyebrow">Platform administration</p>
      <h2>Platform Owner</h2>
      <p className="muted">Platform administration is only available to platform owners.</p>
      <Link href="/" className="btn btn-secondary btn-small">Back to Home</Link>
    </div>;
  }

  return (
    <div className="stack">
      <div className="primary-action">
        <p className="eyebrow">Platform administration</p>
        <h2>Platform Owner</h2>
        <p className="muted">Manage brokerages and select one to manage its team and invitations. Switching reloads the app to clear the previous brokerage's data. Enter your current password before selecting a brokerage.</p>
        <p className="muted">Owner access does not bypass product plans. New brokerages can manage users and invitations, but subscribed features need the usual billing activation.</p>
      </div>
      {status.isLoading && <Loading />}
      {status.isError && <section className="card" role="alert">
        <p className="error-text">{apiErrorMessage(status.error, "Couldn't check owner access.")}</p>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => void status.refetch()}>Try again</button>
      </section>}
      {status.data?.isOwner && <>
        <section className="card">
          <h2>Create brokerage</h2>
          <form className="inline-form" onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && !busy) create.mutate(name.trim(), { onSuccess: () => setName("") });
          }}>
            <input aria-label="New brokerage name" placeholder="Brokerage name" required
              value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
            <button type="submit" className="btn btn-primary btn-small" disabled={busy || !name.trim()}>
              {create.isPending ? "Creating…" : "Create brokerage"}
            </button>
          </form>
          {create.isSuccess && <p className="muted" role="status">Brokerage created. Select it below to manage its team.</p>}
          {create.isError && <p className="error-text" role="alert">{apiErrorMessage(create.error, "Couldn't create this brokerage.")}</p>}
        </section>
        <section className="card owner-directory">
          <h2>Brokerages{brokerages.data ? ` (${brokerages.data.brokerages.length})` : ""}</h2>
          <label className="owner-filter">
            <span>Current password</span>
            <input type="password" autoComplete="current-password" value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)} disabled={busy} />
          </label>
          <label className="owner-filter">
            <span>Filter brokerages</span>
            <input type="search" placeholder="Search by name" value={filter}
              onChange={(event) => setFilter(event.target.value)} />
          </label>
          {brokerages.isLoading && <Loading />}
          {brokerages.isError && <div role="alert">
            <p className="error-text">{apiErrorMessage(brokerages.error, "Couldn't load brokerages.")}</p>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => void brokerages.refetch()}>Try again</button>
          </div>}
          {brokerages.data && rows.length === 0 && <div className="empty-state">
            {brokerages.data.brokerages.length === 0
              ? "No brokerages yet. Create the first brokerage above."
              : "No brokerages match this search."}
            {filter && <button type="button" className="btn btn-secondary btn-small" onClick={() => setFilter("")}>Clear filter</button>}
          </div>}
          <ul className="item-list">
            {rows.map((brokerage) => <li key={brokerage.id}>
              <div className="pc-item-header">
                <div>
                  <strong>{brokerage.name}</strong>
                  {brokerage.id === selectedId && <span className="pill pill-warning">Selected</span>}
                </div>
                <div className="owner-actions">
                  <button type="button" className="btn btn-secondary btn-small" disabled={busy}
                    onClick={() => { setEditingId(brokerage.id); setEditingName(brokerage.name); rename.reset(); }}>
                    Rename
                  </button>
                  <button type="button" className="btn btn-primary btn-small" disabled={busy || !currentPassword}
                    onClick={() => context.mutate({ brokerageId: brokerage.id, currentPassword })}>
                    {context.isPending && context.variables?.brokerageId === brokerage.id ? "Selecting…" : brokerage.id === selectedId ? "Manage users" : "Select brokerage"}
                  </button>
                </div>
              </div>
              {editingId === brokerage.id && <form className="inline-form owner-rename" onSubmit={(event) => {
                event.preventDefault();
                if (editingName.trim() && !busy) rename.mutate({ id: brokerage.id, name: editingName.trim() }, {
                  onSuccess: () => setEditingId(null),
                });
              }}>
                <input aria-label={`Rename ${brokerage.name}`} required autoFocus value={editingName}
                  disabled={busy} onChange={(event) => setEditingName(event.target.value)} />
                <button type="submit" className="btn btn-primary btn-small" disabled={busy || !editingName.trim()}>
                  {rename.isPending ? "Saving…" : "Save name"}
                </button>
                <button type="button" className="btn btn-secondary btn-small" disabled={busy}
                  onClick={() => { setEditingId(null); rename.reset(); }}>Cancel</button>
              </form>}
            </li>)}
          </ul>
          {rename.isError && <p className="error-text" role="alert">{apiErrorMessage(rename.error, "Couldn't rename this brokerage.")}</p>}
          {context.isError && <p className="error-text" role="alert">{apiErrorMessage(context.error, "Couldn't select this brokerage.")}</p>}
        </section>
      </>}
    </div>
  );
}

function Loading() {
  return <div className="owner-loading" role="status" aria-label="Loading brokerages">
    <span /><span /><span />
  </div>;
}
