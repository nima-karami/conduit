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

vi.mock('@lydell/node-pty', () => ({
  spawn: () => ({
    onData: () => {},
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
