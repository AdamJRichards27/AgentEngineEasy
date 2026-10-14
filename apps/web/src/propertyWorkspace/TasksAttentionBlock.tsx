// Moved unchanged from PropertyWorkspace.tsx so a later shell can reuse this panel.

import type { AutomationTaskBlock, AttentionItemBlock } from "./types";

// #122 — agent-facing WAE task/reminder + attention-item surface. Plain
// completion/resolution actions; no invented workflow-builder UI.
export function TasksAttentionBlock({
  tasks,
  attentionItems,
  onCompleteTask,
  onResolveAttentionItem,
}: {
  tasks: AutomationTaskBlock[];
  attentionItems: AttentionItemBlock[];
  onCompleteTask: (taskId: string) => void;
  onResolveAttentionItem: (itemId: string) => void;
}) {
  return (
    <div className="stack">
      {tasks.length > 0 && (
        <ul className="item-list">
          {tasks.map((t) => (
            <li key={t.id}>
              <span className={t.kind === "REMINDER" ? "pill" : "pill pill-success"}>{t.kind === "REMINDER" ? "Reminder" : "Task"}</span>{" "}
              {t.title}
              {t.dueAt && ` · due ${new Date(t.dueAt).toLocaleDateString()}`}
              {t.assignedRole && ` · ${t.assignedRole}`}
              <button className="btn btn-link" onClick={() => onCompleteTask(t.id)}>
                Mark Complete
              </button>
            </li>
          ))}
        </ul>
      )}
      {attentionItems.length > 0 && (
        <ul className="item-list">
          {attentionItems.map((item) => (
            <li key={item.id}>
              <span className="pill pill-danger">Needs attention</span> {item.reasonCode}
              {item.detail && ` — ${item.detail}`}
              <button className="btn btn-link" onClick={() => onResolveAttentionItem(item.id)}>
                Resolve
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
