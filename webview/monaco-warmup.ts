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

interface WarmModel {
  uri: string;
  languageId: string;
}
type DefAt = (uri: string, offset: number) => Promise<unknown>;
type WorkerGetter = (uri: string) => Promise<{ getDefinitionAtPosition: DefAt }>;

export interface WarmDeps {
  getModels: () => WarmModel[];
  isTsLang: (languageId: string) => boolean;
  getTypeScriptWorker: () => Promise<WorkerGetter>;
}

/**
 * Issue the SAME getDefinitionAtPosition call a real goto makes (against the first
 * TS/TSX model) so the worker pre-loads the cross-file resolution path before the
 * user's first manual goto. Fire-and-forget. No-op without consuming the guard if no
 * TS/TSX model is indexed yet — the model check runs before shouldWarm().
 */
export async function warmTypeScriptWorker(deps: WarmDeps): Promise<void> {
  const model = deps.getModels().find((m) => deps.isTsLang(m.languageId));
  if (!model) return; // nothing to warm yet; guard stays open for a retry
  if (!shouldWarm()) return; // already warmed this session
  try {
    const getWorker = await deps.getTypeScriptWorker();
    const worker = await getWorker(model.uri);
    await worker.getDefinitionAtPosition(model.uri, 0);
  } catch {
    // Worker not ready / transient: un-latch so a later trigger can retry.
    unlatch();
  }
}
