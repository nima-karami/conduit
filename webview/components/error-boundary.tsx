import { Component, type ErrorInfo, type ReactNode } from 'react';
import {
  type BoundaryState,
  deriveBoundaryState,
  fallbackMessage,
  initialBoundaryState,
  shouldShowFallback,
} from './error-boundary-state';

// A render/teardown error anywhere under here would otherwise propagate to the
// React root and blank the ENTIRE app to black (there's no built-in fallback).
// The concrete trigger we hit: closing a running session unmounts TerminalPane,
// whose xterm WebGL addon teardown could throw `_isDisposed` of undefined. This
// boundary catches any such throw and renders a graceful, non-black fallback
// (styled like the editor's empty start state) with a recover action, so a
// center-pane crash degrades to "click to recover" instead of a black void.

export class ErrorBoundary extends Component<
  { children: ReactNode; onReset?: () => void },
  BoundaryState
> {
  state: BoundaryState = initialBoundaryState;

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return deriveBoundaryState(error);
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log rather than rethrow — the fallback is the recovery path.
    console.warn('[conduit] center pane error boundary caught:', error, info.componentStack);
  }

  private reset = () => {
    this.props.onReset?.();
    this.setState(initialBoundaryState);
  };

  render() {
    if (shouldShowFallback(this.state)) {
      // Mirrors the `.center-empty` start state (non-black: `background: var(--bg)`),
      // so a crash lands on a panel that matches the initial empty state, not a void.
      return (
        <div className="center-empty" role="alert">
          <p>Something went wrong.</p>
          <p className="center-empty__hint">{fallbackMessage(this.state.error)}</p>
          <button className="btn btn--primary" onClick={this.reset}>
            Reload view
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
