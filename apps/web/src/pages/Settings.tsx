import { useSession } from "../lib/session";

export default function Settings() {
  const { user } = useSession();
  return (
    <div>
      <h1>Settings</h1>
      <section className="card">
        <h2>Account</h2>
        <p>
          {user?.firstName} {user?.lastName} · {user?.email}
        </p>
        <p className="muted">{user?.brokerageName} · {user?.role}</p>
      </section>
      <p className="muted">Integrations and Pit Crew configuration land here as later phases build them out.</p>
    </div>
  );
}
