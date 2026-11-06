import type { TypingPort } from '../../src/contracts/server-ports';
import type { TerminalRuntime } from '../../src/contracts/terminal-runtime';
import { createPtyWriter } from '../../src/pty-writer';
import { SUBMIT_GAP_MS } from '../../src/timed-messages';

/** Today's PtyWriter over C1 `input`: the server's only path into a PTY (D19). */
export function createTyping(
  runtime: Pick<TerminalRuntime, 'get' | 'input'>,
  opts: { gapMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): TypingPort {
  const write = (sessionId: string, data: string, generation?: number) => {
    const t = runtime.get(sessionId);
    return !!t && runtime.input(sessionId, generation ?? t.generation, data);
  };
  const writer = createPtyWriter({
    generation: (sessionId) => runtime.get(sessionId)?.generation,
    input: (sessionId, data) => write(sessionId, data),
    sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    gapMs: opts.gapMs ?? SUBMIT_GAP_MS,
  });
  return {
    submit: writer.submit,
    submitEnter: writer.submitEnter,
    forget: writer.forget,
    write: (sessionId, data, options) => write(sessionId, data, options?.generation),
  };
}
