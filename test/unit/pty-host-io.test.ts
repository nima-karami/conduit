import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyHost } from '../../src/pty-host';

/**
 * PtyHost's two new reads (spec 2026-08-28-timed-messages §3): `input` reports whether a live
 * process took the write — which is what `delivered` is derived from — and `tailLines` exposes
 * the tail `lastLine` already keeps, for the limit detector.
 *
 * node-pty is mocked: this asserts PtyHost's own bookkeeping, and the real module is a native
 * addon built against Electron's ABI.
 */

const writes: { sessionId: string; data: string }[] = [];
let onExitCb: ((e: { exitCode: number }) => void) | null = null;
/** Push a chunk into the most recently spawned child, the way node-pty would. */
let emit: ((data: string) => void) | null = null;

vi.mock('@lydell/node-pty', () => ({
  spawn: () => ({
    onData: (cb: (data: string) => void) => {
      emit = cb;
    },
    onExit: (cb: (e: { exitCode: number }) => void) => {
      onExitCb = cb;
    },
    write: (data: string) => writes.push({ sessionId: 'current', data }),
    resize: () => {},
    kill: () => {},
  }),
}));

const spec = { command: 'cmd.exe', args: [] as string[], cwd: '.' };

describe('PtyHost.input', () => {
  beforeEach(() => {
    writes.length = 0;
    onExitCb = null;
    emit = null;
  });

  it('returns false and writes nothing for a session with no live process', () => {
    const host = new PtyHost(() => {});
    expect(host.input('ghost', 'Continue')).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('returns true and writes for a live session', () => {
    const host = new PtyHost(() => {});
    host.start('s1', 80, 24, spec);
    expect(host.input('s1', 'Continue')).toBe(true);
    expect(host.input('s1', '\r')).toBe(true);
    expect(writes.map((w) => w.data)).toEqual(['Continue', '\r']);
  });

  it('returns false once the process has exited', () => {
    const host = new PtyHost(() => {});
    host.start('s1', 80, 24, spec);
    onExitCb?.({ exitCode: 0 });
    expect(host.isAlive('s1')).toBe(false);
    expect(host.input('s1', 'Continue')).toBe(false);
  });

  it('returns false after dispose', () => {
    const host = new PtyHost(() => {});
    host.start('s1', 80, 24, spec);
    host.dispose('s1');
    expect(host.input('s1', 'Continue')).toBe(false);
  });
});

/**
 * The gate that makes arm-by-default defensible (spec §2 "Limit-aware"): the limit detector only
 * ever sees the session's TRAILING output. That reassembly is PtyHost's job, not the pure
 * module's — src/limit-notice.ts is handed lines and cannot know where a chunk ended.
 */
describe('PtyHost.tailLines', () => {
  const NOTICE = "You've hit your session limit · resets 11:10pm";

  beforeEach(() => {
    writes.length = 0;
    onExitCb = null;
    emit = null;
  });

  const started = () => {
    const host = new PtyHost(() => {});
    host.start('s1', 80, 24, spec);
    return host;
  };

  it('is empty for a session that has printed nothing', () => {
    const host = new PtyHost(() => {});
    expect(host.tailLines('ghost', 3)).toEqual([]);
    host.start('s1', 80, 24, spec);
    expect(host.tailLines('s1', 3)).toEqual([]);
  });

  it('joins a line split across two chunks — the case the pure module cannot see', () => {
    const host = started();
    emit?.("You've hit your session ");
    // Mid-line: the half-line is all there is, and it is not yet a notice.
    expect(host.tailLines('s1', 3)).toEqual(["You've hit your session"]);
    emit?.(`limit · resets 11:10pm${String.fromCharCode(13, 10)}`);
    expect(host.tailLines('s1', 3)).toEqual([NOTICE]);
  });

  it('strips the colour a real TUI wraps the notice in', () => {
    const host = started();
    emit?.(`\u001b[33m${NOTICE}\u001b[0m\r\n`);
    expect(host.tailLines('s1', 3)).toEqual([NOTICE]);
  });

  it('hands back only the last n non-empty lines, newest last', () => {
    const host = started();
    emit?.('one\r\ntwo\r\n\r\nthree\r\nfour\r\n');
    expect(host.tailLines('s1', 3)).toEqual(['two', 'three', 'four']);
  });

  it('drops a notice that later output has scrolled past — the whole safety argument', () => {
    const host = started();
    emit?.(`${NOTICE}\r\n`);
    expect(host.tailLines('s1', 3)).toContain(NOTICE);
    emit?.('- const a = 1;\r\n+ const a = 2;\r\n  const b = 3;\r\n');
    expect(host.tailLines('s1', 3)).not.toContain(NOTICE);
  });

  it(`drops the previous child's tail when the session is relaunched`, () => {
    // The tail deliberately survives term:exit (the card keeps its last line), but a relaunch
    // reuses the session id — and carrying the dead agent's limit notice into a fresh bare shell
    // is what would arm a Continue into it (§12.1).
    const host = started();
    emit?.(`${NOTICE}\r\n`);
    onExitCb?.({ exitCode: 0 });
    expect(host.tailLines('s1', 3)).toContain(NOTICE);
    host.start('s1', 80, 24, spec);
    expect(host.tailLines('s1', 3)).toEqual([]);
    expect(host.lastLine('s1')).toBe('');
  });
});
