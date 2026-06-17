import { Component, type ErrorInfo, type ReactNode } from 'react';
import {
  type BoundaryState,
  deriveBoundaryState,
  fallbackMessage,
  initialBoundaryState,
  shouldShowFallback,
} from './error-boundary-state';

// Without this, a render/teardown throw under here propagates to the React root and
// blanks the ENTIRE app to black. Concrete trigger: closing a running session unmounts
// TerminalPane, whose xterm WebGL addon teardown can throw `_isDisposed` of undefined.
// The fallback degrades a center-pane crash to "click to recover" instead of a void.

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
      // Mirrors the `.center-empty` start state so a crash lands on a matching panel, not a void.
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
