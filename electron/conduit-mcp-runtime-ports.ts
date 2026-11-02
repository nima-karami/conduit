import type { ScreenPort } from '../src/contracts/server-ports';
import type {
  LaunchIds,
  RuntimeEvent,
  RuntimeTerminal,
  TerminalRuntime,
} from '../src/contracts/terminal-runtime';
import type { PtyHost } from '../src/pty-host';
import type { SessionScreens } from './session-screens';

type PtyPort = Pick<PtyHost, 'isAlive' | 'generation' | 'size'>;

export function createMcpRuntimePorts(deps: { pty: PtyPort; screens: SessionScreens }): {
  runtime: Pick<TerminalRuntime, 'get' | 'screen' | 'on'>;
  screens: ScreenPort;
  prepared(sessionId: string, ids: LaunchIds): void;
  spawned(sessionId: string): void;
  output(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  exit(sessionId: string, code?: number): void;
} {
  const prepared = new Map<string, LaunchIds>();
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const emit = (event: RuntimeEvent) => {
    for (const listener of listeners) listener(event);
  };
  const get = (sessionId: string): RuntimeTerminal | undefined => {
    const ids = prepared.get(sessionId);
    const size = deps.pty.size(sessionId);
    if (!deps.pty.isAlive(sessionId) || !ids || !size) return undefined;
    return {
      sessionId,
      generation: ids.generation,
      launchId: ids.launchId,
      state: 'live',
      size,
      target: { hcSession: 'node-pty', terminal: sessionId },
    };
  };

  return {
    runtime: {
      get,
      screen: async (sessionId) => (await deps.screens.snapshot(sessionId)) ?? null,
      on: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    screens: {
      ensure: (sessionId, opts) => {
        const size = deps.pty.size(sessionId);
        if (!size || deps.screens.has(sessionId)) return;
        if (!opts.seedTail) deps.screens.dispose(sessionId);
        deps.screens.start(sessionId, size.cols, size.rows);
      },
      keepTail: (sessionId) => {
        const size = deps.pty.size(sessionId);
        if (size) deps.screens.keepTail(sessionId, size.cols, size.rows);
      },
      release: (sessionId) => deps.screens.dispose(sessionId),
    },
    prepared: (sessionId, ids) => prepared.set(sessionId, ids),
    spawned: (sessionId) => {
      const terminal = get(sessionId);
      if (terminal)
        emit({ type: 'spawned', sessionId, generation: terminal.generation, size: terminal.size });
    },
    output: (sessionId, data) => deps.screens.feed(sessionId, data),
    resize: (sessionId, cols, rows) => {
      deps.screens.resize(sessionId, cols, rows);
      emit({ type: 'size', sessionId, size: { cols, rows } });
    },
    exit: (sessionId, code) => {
      const ids = prepared.get(sessionId);
      if (!ids) return;
      emit({
        type: 'exit',
        sessionId,
        generation: ids.generation,
        code: code ?? null,
        reason: 'exited',
      });
      prepared.delete(sessionId);
    },
  };
}
