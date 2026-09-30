import type { HostToWebview, WebviewToHost } from '../src/protocol';
import type { QuitReason } from '../src/quit-guard';
import type { AutoSaveMode } from '../src/settings';
import type { FileSaves } from './file-save-controller';
import type { DirtyAnswer, DirtyAsk } from './use-dirty-close';

export const FLUSH_BOUND_MS = 5000;
export const SETTLE_BOUND_MS = 5000;

type ConfirmQuitMsg = Extract<HostToWebview, { type: 'confirmQuit' }>;

export interface QuitResponderDeps {
  post(msg: WebviewToHost): void;
  autoSaveMode(): AutoSaveMode;
  /** Posts a settings edit still inside the provider's debounce. */
  flushSettings(): void;
  saves: Pick<FileSaves, 'flushAll' | 'whenIdle' | 'setToastsSuppressed'>;
  dirtyPaths(): string[];
  askDirty(req: DirtyAsk): Promise<DirtyAnswer>;
  askSessions(req: {
    reason: QuitReason;
    running: number;
    busy: number;
    onShown(): void;
    signal: AbortSignal;
  }): Promise<boolean>;
  focusDialog(): void;
  setLocked(on: boolean): void;
  wait(ms: number): Promise<void>;
  log(message: string): void;
}

interface Flow {
  requestId: number;
  phase: 'flushing' | 'asking' | 'settling' | 'done';
  abort: AbortController;
}

// The flow's steps and their order are the plan's contract: dirty-quit-guard plan, "Quit responder".
export function createQuitResponder(deps: QuitResponderDeps): {
  onConfirmQuit(msg: ConfirmQuitMsg): Promise<void>;
  onQuitAborted(requestId: number): void;
  discarded(): boolean;
} {
  let flow: Flow | null = null;
  let lockedFor: number | null = null;
  let discarded = false;

  async function decide(msg: ConfirmQuitMsg, signal: AbortSignal): Promise<boolean | null> {
    const { requestId, reason, running, busy } = msg;
    const onShown = () => deps.post({ type: 'quitDialogShown', requestId });
    const paths = deps.dirtyPaths();
    if (paths.length === 0 && running === 0) return true;
    if (paths.length === 0) {
      const ok = await deps.askSessions({ reason, running, busy, onShown, signal });
      return signal.aborted ? null : ok;
    }
    const answer = await deps.askDirty({ reason, paths, running, busy, onShown, signal });
    if (signal.aborted) return null;
    if (answer === 'discarded') discarded = true;
    return answer !== 'cancel';
  }

  async function onConfirmQuit(msg: ConfirmQuitMsg): Promise<void> {
    const { requestId } = msg;
    if (flow && flow.requestId === requestId) {
      if (flow.phase === 'asking') deps.focusDialog();
      else if (flow.phase === 'done')
        deps.post({ type: 'quitDecision', requestId, proceed: false });
      return;
    }
    flow?.abort.abort();
    discarded = false;
    const own: Flow = { requestId, phase: 'flushing', abort: new AbortController() };
    flow = own;
    const { signal } = own.abort;

    try {
      deps.post({ type: 'quitAck', requestId });
      // Before any await: the host's sync flush of settings.json runs after our answer, and a
      // debounced edit left to pagehide raced the teardown and was lost.
      deps.flushSettings();
      if (deps.autoSaveMode() !== 'off') {
        deps.saves.setToastsSuppressed(true);
        await Promise.race([deps.saves.flushAll('windowBlur'), deps.wait(FLUSH_BOUND_MS)]);
        if (signal.aborted) return;
      }

      own.phase = 'asking';
      const proceed = await decide(msg, signal);
      if (proceed === null) return;

      if (!proceed) {
        deps.post({ type: 'quitDecision', requestId, proceed: false });
        discarded = false;
        return;
      }

      own.phase = 'settling';
      let bounded = false;
      await Promise.race([
        deps.saves.whenIdle(),
        deps.wait(SETTLE_BOUND_MS).then(() => {
          bounded = true;
        }),
      ]);
      if (bounded) deps.log(`quit ${requestId}: saves still in flight after ${SETTLE_BOUND_MS}ms`);
      if (signal.aborted) return;
      if (msg.reason !== 'windowClose') {
        deps.setLocked(true);
        lockedFor = requestId;
      }
      // An edit made while the dialog or the settle bound was up is still debounced.
      deps.flushSettings();
      deps.post({ type: 'quitDecision', requestId, proceed: true });
    } finally {
      // A superseded flow leaves suppression to the flow that replaced it, whose own finally clears it.
      if (flow === own) {
        own.phase = 'done';
        deps.saves.setToastsSuppressed(false);
      }
    }
  }

  function onQuitAborted(requestId: number): void {
    const inFlight = flow?.requestId === requestId;
    const locked = lockedFor === requestId;
    if (!inFlight && !locked) return;
    if (inFlight) flow?.abort.abort();
    if (locked) {
      deps.setLocked(false);
      lockedFor = null;
    }
    discarded = false;
  }

  return { onConfirmQuit, onQuitAborted, discarded: () => discarded };
}
