// Pure logic for the error boundary, split out so it's unit-testable without a
// DOM / React renderer (the vitest env is `node`). The boundary component itself
// (error-boundary.tsx) is a thin shell that delegates the fallback decision here.

export interface BoundaryState {
  /** The error that was caught, or null while rendering normally. */
  error: Error | null;
}

/** Initial (healthy) boundary state. */
export const initialBoundaryState: BoundaryState = { error: null };

/**
 * React's `getDerivedStateFromError` body: a thrown render/teardown error flips
 * the boundary into its caught state so the fallback renders instead of a blank
 * (black) root. Normalizes non-Error throws to an Error.
 */
export function deriveBoundaryState(error: unknown): BoundaryState {
  return { error: error instanceof Error ? error : new Error(String(error)) };
}

/**
 * Whether the boundary should render its fallback (true) or the children (false).
 * Pure so the decision has a single tested source of truth.
 */
export function shouldShowFallback(state: BoundaryState): boolean {
  return state.error !== null;
}

/** Human-readable message for the fallback panel (safe for a null error). */
export function fallbackMessage(error: Error | null): string {
  return error?.message ? error.message : 'Something went wrong.';
}
