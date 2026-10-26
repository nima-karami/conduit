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

export interface PtyWriterDeps {
  generation(sessionId: string): number | undefined;
  input(sessionId: string, data: string): boolean;
  sleep(ms: number): Promise<void>;
  gapMs: number;
}

export interface PtyWriter {
  submit(sessionId: string, text: string, hooks?: SubmitHooks): Promise<SubmitOutcome>;
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

  const run = async (
    sessionId: string,
    text: string,
    hooks: SubmitHooks,
  ): Promise<SubmitOutcome> => {
    const gen = deps.generation(sessionId);
    if (gen === undefined) return 'no-pty';
    if (!(await hookAllows(hooks.beforeText))) return 'gate-closed';
    // The hook awaited (a screen snapshot): the PTY may have been respawned meanwhile.
    if (deps.generation(sessionId) !== gen) return 'generation-changed';
    if (!deps.input(sessionId, text)) return 'write-failed';
    await deps.sleep(deps.gapMs);
    if (deps.generation(sessionId) !== gen) return 'generation-changed';
    if (!(await hookAllows(hooks.beforeEnter))) return 'withheld';
    // beforeEnter may wait out a slow echo: a respawn meanwhile must not get the Enter either.
    if (deps.generation(sessionId) !== gen) return 'generation-changed';
    return deps.input(sessionId, '\r') ? 'submitted' : 'write-failed';
  };

  return {
    submit(sessionId, text, hooks = {}) {
      const next = (chains.get(sessionId) ?? Promise.resolve()).then(() =>
        run(sessionId, text, hooks),
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
    forget(sessionId) {
      chains.delete(sessionId);
    },
  };
}
