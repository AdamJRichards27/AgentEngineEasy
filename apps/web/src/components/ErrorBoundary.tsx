import { Component, type ErrorInfo, type ReactNode } from "react";
import {
  INITIAL_ERROR_BOUNDARY_STATE,
  deriveErrorBoundaryState,
  shouldResetOnKeyChange,
  type ErrorBoundaryState,
} from "../lib/errorBoundary";

// AE GROW Pilot Readiness WP5 — contains a render failure to the region that
// failed instead of blanking the whole SPA. Used at the app root (main.tsx),
// around the routed page outlet (App.tsx), and around each Grow workspace tab
// and Contact 360 (Grow.tsx). The fallback is a plain, accessible message
// (role="alert") with a "Try again" reset and a short support reference —
// never the raw error message or stack; those go to the console only.
interface ErrorBoundaryProps {
  children?: ReactNode;
  // What failed, in words ("this page", "Contact 360"). Used in the heading.
  label?: string;
  // "page" for the app-root fallback (full-screen, adds "Reload page");
  // "panel" (default) for a contained in-page card.
  variant?: "page" | "panel";
  // When this changes while the fallback is showing, the boundary resets
  // itself — e.g. navigating to another route or switching tabs.
  resetKey?: unknown;
  // Optional extra way out, e.g. "Back to contacts".
  secondaryAction?: { label: string; onClick: () => void };
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = INITIAL_ERROR_BOUNDARY_STATE;

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return deriveErrorBoundaryState(error);
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[Agent Engine] ${this.props.label ?? "A section"} failed to render (${this.state.reference ?? "no reference"})`, error, info.componentStack);
  }

  componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (shouldResetOnKeyChange(this.state, previous.resetKey, this.props.resetKey)) this.reset();
  }

  reset = (): void => {
    this.setState(INITIAL_ERROR_BOUNDARY_STATE);
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    const { label, variant = "panel", secondaryAction } = this.props;
    const isPage = variant === "page";
    const heading = label ? `Something went wrong showing ${label}` : "Something went wrong";
    return (
      <div className={`card error-boundary${isPage ? " error-boundary-page" : ""}`} role="alert">
        {isPage ? <h1>{heading}</h1> : <h2>{heading}</h2>}
        <p className="muted">
          {isPage
            ? "Agent Engine hit an unexpected problem. Try again, or reload the page."
            : "This section couldn't be displayed. The rest of Agent Engine is still working — try again."}
        </p>
        {this.state.reference && (
          <p className="error-boundary-reference">
            If this keeps happening, contact support and quote <strong>{this.state.reference}</strong>.
          </p>
        )}
        <div className="error-boundary-actions">
          <button type="button" className="btn btn-primary" onClick={this.reset}>
            Try again
          </button>
          {secondaryAction && (
            <button type="button" className="btn btn-secondary" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </button>
          )}
          {isPage && (
            <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>
              Reload page
            </button>
          )}
        </div>
      </div>
    );
  }
}
