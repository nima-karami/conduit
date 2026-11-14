import type { TypingPort } from '../../src/contracts/server-ports';
import type { TerminalRuntime } from '../../src/contracts/terminal-runtime';
import { createPtyWriter } from '../../src/pty-writer';
import { createOutputQuiet, type OutputQuiet } from './output-quiet';

/** Today's PtyWriter over C1 `input`: the server's only path into a PTY (D19). */
export function createTyping(
  runtime: Pick<TerminalRuntime, 'get' | 'input' | 'on'>,
  opts: { sleep?: (ms: number) => Promise<void>; outputQuiet?: OutputQuiet } = {},
): TypingPort {
  const write = (sessionId: string, data: string, generation?: number) => {
    const t = runtime.get(sessionId);
    return !!t && runtime.input(sessionId, generation ?? t.generation, data);
  };
  const outputQuiet =
    opts.outputQuiet ??
    createOutputQuiet({
      on: (listener) => runtime.on(listener),
      now: () => Date.now(),
      setTimer: (ms, fn) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
  const writer = createPtyWriter({
    generation: (sessionId) => runtime.get(sessionId)?.generation,
    input: (sessionId, data) => write(sessionId, data),
    sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    outputQuiet: (sessionId, quietMs, maxMs) => outputQuiet.wait(sessionId, quietMs, maxMs),
  });
  return {
    submit: writer.submit,
    submitEnter: writer.submitEnter,
    sequence: writer.sequence,
    forget: writer.forget,
    write: (sessionId, data, options) => write(sessionId, data, options?.generation),
  };
}
