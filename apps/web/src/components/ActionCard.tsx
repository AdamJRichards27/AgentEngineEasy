import type { ReactNode } from "react";

/**
 * A presentation-only card for an existing, explainable action.
 *
 * The card deliberately knows nothing about data fetching, ranking, or
 * mutations. Callers provide the status and deterministic explanation that
 * already came from their source, plus the existing links/buttons for the
 * action. That keeps Today and Grow consistent without creating another
 * action surface or inventing an AI recommendation.
 */
export interface ActionCardProps {
  status: ReactNode;
  title: ReactNode;
  context?: ReactNode;
  explanation?: ReactNode;
  suggestedNextStep?: ReactNode;
  metadata?: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
  notice?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function ActionCard({
  status,
  title,
  context,
  explanation,
  suggestedNextStep,
  metadata,
  primaryAction,
  secondaryActions,
  notice,
  children,
  className,
}: ActionCardProps) {
  const cardClassName = ["action-card", className].filter(Boolean).join(" ");

  return (
    <article className={cardClassName}>
      <header className="action-card-header">
        <div className="action-card-status">{status}</div>
        <h3 className="action-card-title">{title}</h3>
        {context ? <p className="action-card-context">{context}</p> : null}
      </header>

      {explanation ? (
        <p className="action-card-explanation">
          <span className="action-card-label">Why this is here</span>
          {explanation}
        </p>
      ) : null}

      {suggestedNextStep ? (
        <p className="action-card-next-step">
          <span className="action-card-label">Suggested next step</span>
          {suggestedNextStep}
        </p>
      ) : null}

      {metadata ? <div className="action-card-metadata">{metadata}</div> : null}
      {notice}

      {primaryAction || secondaryActions ? (
        <div className="action-card-actions">
          {primaryAction ? <div className="action-card-primary">{primaryAction}</div> : null}
          {secondaryActions ? <div className="action-card-secondary">{secondaryActions}</div> : null}
        </div>
      ) : null}

      {children}
    </article>
  );
}

export default ActionCard;