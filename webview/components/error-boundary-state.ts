// Pure logic for the error boundary, split out so it's unit-testable without a
// DOM / React renderer (the vitest env is `node`). The boundary component itself
// (error-boundary.tsx) is a thin shell that delegates the fallback decision here.

export interface BoundaryState {
  /** The error that was caught, or null while rendering normally. */
  error: Error | null;
}

export const initialBoundaryState: BoundaryState = { error: null };

/**
 * React's `getDerivedStateFromError` body. Normalizes non-Error throws to an Error.
 */
export function deriveBoundaryState(error: unknown): BoundaryState {
  return { error: error instanceof Error ? error : new Error(String(error)) };
}

export function shouldShowFallback(state: BoundaryState): boolean {
  return state.error !== null;
}

export function fallbackMessage(error: Error | null): string {
  return error?.message ? error.message : 'Something went wrong.';
}
