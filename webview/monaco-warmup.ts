// Pure, Monaco-free helpers for warming the TypeScript language worker and tracking
// in-flight go-to-definition requests. Kept free of any runtime `monaco-editor` import
// so they load in the `node` Vitest env (the Monaco-bound wrapper lives in
// `monaco-warmup-bind.ts`). See docs/specs/archive/2026-06-11-goto-def.md.

// Once-guard so the TS-worker warm-up runs at most once per session, surviving React
// StrictMode double-invoked effects and remounts. Latched synchronously on trigger so a
// concurrent call during the async await window can't start a second warm-up; a thrown
// attempt un-latches (see the catch below) so a later trigger can retry.
let warmStarted = false;

function unlatch(): void {
  warmStarted = false;
}

/** True only the first time this session; idempotent thereafter. */
export function shouldWarm(): boolean {
  if (warmStarted) return false;
  warmStarted = true;
  return true;
}

/** Test-only: reset the module-scoped guard between cases. */
export function resetWarmGuardForTests(): void {
  unlatch();
}

export interface InflightTracker {
  begin(): void;
  end(): void;
  active(): boolean;
  subscribe(fn: () => void): () => void;
}

/**
 * Ref-counted, observable in-flight tracker. `active()` is true iff `begin` calls
 * outnumber `end` calls; the count never goes negative. Subscribers are notified on
 * every 0<->>=1 transition so a React indicator can re-render.
 */
export function createInflightTracker(): InflightTracker {
  let count = 0;
  const subs = new Set<() => void>();
  const notify = (): void => {
    for (const fn of subs) fn();
  };
  return {
    begin() {
      const was = count > 0;
      count += 1;
      if (!was) notify();
    },
    end() {
      if (count === 0) return;
      count -= 1;
      if (count === 0) notify();
    },
    active: () => count > 0,
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

/** Shared tracker the CodeViewer subscribes to and goto requests mark begin/end on. */
export const gotoInflight = createInflightTracker();

export interface WarmDeps {
  /** Bring the language worker up (and let it sync). Whatever it resolves to is ignored. */
  acquire: () => Promise<unknown>;
}

/**
 * Spin the language worker up once, off the interaction path, so the user's first navigation
 * isn't paying for its cold start.
 *
 * Pushing indexed content does NOT start the worker — monaco's `_updateExtraLibs` returns
 * early when there isn't one — so something has to ask for it. Fire-and-forget: a failure
 * un-latches the guard so a later trigger can retry.
 */
export async function warmLanguageWorker(deps: WarmDeps): Promise<void> {
  if (!shouldWarm()) return; // already warmed this session
  try {
    await deps.acquire();
  } catch {
    unlatch();
  }
}
