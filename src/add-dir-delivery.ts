// Typing `/add-dir <path>` into a running claude (mf-live-edits spec §2.3). Renderer-safe.
import { SUBMIT_GAP_MS } from './timed-messages';

/** Lets claude answer each line before the next arrives (spec §5). */
export const ADD_DIR_LINE_GAP_MS = 300;

export type AgentScopeReason =
  | 'noSession'
  | 'notRunning'
  | 'notClaude'
  | 'nothingPending'
  | 'busy'
  | 'inFlight'
  | 'writeFailed'
  | 'homeMissing';

export type AddDirsResult =
  | { ok: true; delivered: string[] }
  | { ok: false; reason: AgentScopeReason; delivered: string[] };

export interface AddDirsDeps {
  sessionId: string;
  inFlight: Set<string>;
  sessionExists: () => boolean;
  /** Bound to the child live at the call, so a restart mid-sequence reads as dead (R1). */
  isAlive: () => boolean;
  isBusy: () => boolean;
  /** undefined = no scope (not a claude process, or not captured). */
  typeable: () => readonly string[] | undefined;
  write: (data: string) => boolean;
  sleep: (ms: number) => Promise<void>;
  onDelivered: (path: string) => void;
}

export async function runAddDirs(deps: AddDirsDeps): Promise<AddDirsResult> {
  const fail = (reason: AgentScopeReason, delivered: string[] = []): AddDirsResult => ({
    ok: false,
    reason,
    delivered,
  });
  if (!deps.sessionExists()) return fail('noSession');
  if (!deps.isAlive()) return fail('notRunning');
  const pending = deps.typeable();
  if (pending === undefined) return fail('notClaude');
  if (pending.length === 0) return fail('nothingPending');
  // Checked once, before any write: nothing is queued, so a deferred line can't land unseen
  // (spec §2.3 step 2, D5).
  if (deps.isBusy()) return fail('busy');
  if (deps.inFlight.has(deps.sessionId)) return fail('inFlight');
  deps.inFlight.add(deps.sessionId);
  const paths = [...pending];
  const delivered: string[] = [];
  try {
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (i > 0) await deps.sleep(ADD_DIR_LINE_GAP_MS);
      // Verbatim and unquoted: claude takes the whole trimmed remainder as the path (spec §0).
      if (!deps.isAlive() || !deps.write(`/add-dir ${p}`)) return fail('writeFailed', delivered);
      await deps.sleep(SUBMIT_GAP_MS);
      if (!deps.isAlive() || !deps.write('\r')) return fail('writeFailed', delivered);
      delivered.push(p);
      deps.onDelivered(p);
    }
    return { ok: true, delivered };
  } finally {
    deps.inFlight.delete(deps.sessionId);
  }
}
