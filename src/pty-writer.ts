export type SubmitOutcome =
  | 'submitted'
  | 'no-pty'
  | 'write-failed'
  | 'generation-changed'
  | 'gate-closed'
  | 'withheld';

/** see docs/plans/2026-10-25-conduit-mcp-server.plan.md, rulings 1 and 3 */
export interface SubmitHooks {
  beforeText?: () => boolean | Promise<boolean>;
  beforeEnter?: () => boolean | Promise<boolean>;
}

export interface SubmitEnterOptions {
  beforeEnter?: () => boolean | Promise<boolean>;
}

export interface SubmitOptions extends SubmitHooks {
  bracketed?: boolean;
  /**
   * When the Enter follows the text. `gap` (default): the fixed ENTER_FLOOR_MS, as notices and every
   * other host write always had. `quiet`: also wait for the echo to settle — Scheduler deliveries
   * only, whose long pastes a TUI may still be drawing (spec 2026-11-13 R5, amended).
   */
  settle?: 'gap' | 'quiet';
}

export interface PtyWriterDeps {
  generation(sessionId: string): number | undefined;
  input(sessionId: string, data: string): boolean;
  sleep(ms: number): Promise<void>;
  outputQuiet(sessionId: string, quietMs: number, maxMs: number): Promise<void>;
}

// see spec 2026-11-13-scheduler-auto-resume R5
export const ENTER_FLOOR_MS = 120;
export const ECHO_QUIET_MS = 300;
export const ECHO_MAX_MS = 5_000;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export interface PtyWriter {
  submit(sessionId: string, text: string, opts?: SubmitOptions): Promise<SubmitOutcome>;
  submitEnter(sessionId: string, opts?: SubmitEnterOptions): Promise<SubmitOutcome>;
  sequence(
    sessionId: string,
    write: () => boolean,
    opts: SubmitEnterOptions & { submit: boolean },
  ): Promise<SubmitOutcome>;
  forget(sessionId: string): void;
}

/** A hook that throws is a closed gate (its outcome code): never write on an unproven condition. */
async function hookAllows(hook: (() => boolean | Promise<boolean>) | undefined): Promise<boolean> {
  if (!hook) return true;
  try {
    return (await hook()) === true;
  } catch {
    return false;
  }
}

/**
 * The one serialized writer for host-originated PTY input (timed messages, notices): one submit
 * per session at a time, so a notice can never land inside a timed message's submit gap.
 * Text and `\r` are two writes — a TUI that coalesces a single read keeps a trailing CR as
 * literal text. Bound to the PTY generation: a restart inside the gap must not get the Enter.
 */
export function createPtyWriter(deps: PtyWriterDeps): PtyWriter {
  const chains = new Map<string, Promise<unknown>>();

  const beforeEnter = (sessionId: string, settle: SubmitOptions['settle']) =>
    settle === 'quiet'
      ? Promise.all([
          deps.sleep(ENTER_FLOOR_MS),
          deps.outputQuiet(sessionId, ECHO_QUIET_MS, ECHO_MAX_MS),
        ])
      : deps.sleep(ENTER_FLOOR_MS);

  const run = async (
    sessionId: string,
    text: string,
    opts: SubmitOptions,
  ): Promise<SubmitOutcome> => {
    const gen = deps.generation(sessionId);
    if (gen === undefined) return 'no-pty';
    if (!(await hookAllows(opts.beforeText))) return 'gate-closed';
    // The hook awaited (a screen snapshot): the PTY may have been respawned meanwhile.
    if (deps.generation(sessionId) !== gen) return 'generation-changed';
    const payload = opts.bracketed ? `${PASTE_START}${text}${PASTE_END}` : text;
    if (!deps.input(sessionId, payload)) return 'write-failed';
    await beforeEnter(sessionId, opts.settle);
    if (deps.generation(sessionId) !== gen) return 'generation-changed';
    if (!(await hookAllows(opts.beforeEnter))) return 'withheld';
    // beforeEnter may wait out a slow echo: a respawn meanwhile must not get the Enter either.
    if (deps.generation(sessionId) !== gen) return 'generation-changed';
    return deps.input(sessionId, '\r') ? 'submitted' : 'write-failed';
  };

  const runEnter = async (sessionId: string, opts: SubmitEnterOptions): Promise<SubmitOutcome> => {
    const gen = deps.generation(sessionId);
    if (gen === undefined) return 'no-pty';
    // The caller's full gate runs inside the slot, so the check and the write are atomic with
    // respect to other queued work (a timed message's gap, another notice attempt).
    if (!(await hookAllows(opts.beforeEnter))) return 'withheld';
    if (deps.generation(sessionId) !== gen) return 'generation-changed';
    return deps.input(sessionId, '\r') ? 'submitted' : 'write-failed';
  };

  return {
    submit(sessionId, text, opts = {}) {
      const next = (chains.get(sessionId) ?? Promise.resolve()).then(() =>
        run(sessionId, text, opts),
      );
      // The caller still sees a rejection from `next`; the chain only orders slots, so a throwing
      // dep must not wedge every later submit for the session.
      chains.set(
        sessionId,
        next.then(
          () => undefined,
          () => undefined,
        ),
      );
      return next;
    },
    submitEnter(sessionId, opts = {}) {
      const next = (chains.get(sessionId) ?? Promise.resolve()).then(() =>
        runEnter(sessionId, opts),
      );
      chains.set(
        sessionId,
        next.then(
          () => undefined,
          () => undefined,
        ),
      );
      return next;
    },
    sequence(sessionId, write, opts) {
      const next = (chains.get(sessionId) ?? Promise.resolve()).then(
        async (): Promise<SubmitOutcome> => {
          const gen = deps.generation(sessionId);
          if (gen === undefined) return 'no-pty';
          if (!write()) return 'write-failed';
          if (!opts.submit) return 'submitted';
          await beforeEnter(sessionId, 'gap');
          if (deps.generation(sessionId) !== gen) return 'generation-changed';
          if (!(await hookAllows(opts.beforeEnter))) return 'withheld';
          if (deps.generation(sessionId) !== gen) return 'generation-changed';
          return deps.input(sessionId, '\r') ? 'submitted' : 'write-failed';
        },
      );
      chains.set(
        sessionId,
        next.then(
          () => undefined,
          () => undefined,
        ),
      );
      return next;
    },
    forget(sessionId) {
      chains.delete(sessionId);
    },
  };
}
