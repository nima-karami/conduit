import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '../../src/types';
import { nextRanPaneKeys, terminalPaneMounts } from '../../webview/terminal-pane-mounts';

interface S {
  id: string;
  status: SessionStatus;
}
const s = (id: string, status: SessionStatus): S => ({ id, status });
const keyOf = (x: S) => `${x.id}:0`;
const mounts = (sessions: S[], shown: string[], ran: string[]) =>
  terminalPaneMounts(sessions, { shown: new Set(shown), ran: new Set(ran), keyOf }).map(
    (m) => `${m.session.id}:${m.mode}`,
  );

describe('terminalPaneMounts', () => {
  it('mounts every running session in run mode, shown or not', () => {
    expect(mounts([s('a', 'running'), s('b', 'running')], ['a'], [])).toEqual(['a:run', 'b:run']);
  });

  it('mounts an exited session that ran here only while it is shown, in view mode', () => {
    const sessions = [s('a', 'exited'), s('b', 'exited')];
    expect(mounts(sessions, ['a'], ['a:0', 'b:0'])).toEqual(['a:view']);
    expect(mounts(sessions, ['b'], ['a:0', 'b:0'])).toEqual(['b:view']);
    // The split session counts as shown too.
    expect(mounts(sessions, ['a', 'b'], ['a:0', 'b:0'])).toEqual(['a:view', 'b:view']);
    expect(mounts(sessions, [], ['a:0', 'b:0'])).toEqual([]);
  });

  it('keeps the exited card, not a pane, for an exited session that never ran under its key', () => {
    expect(mounts([s('a', 'exited')], ['a'], [])).toEqual([]);
    expect(mounts([s('a', 'exited')], ['a'], ['a:1'])).toEqual([]);
  });

  it('never mounts a stale session', () => {
    expect(mounts([s('a', 'stale')], ['a'], ['a:0'])).toEqual([]);
  });

  it('keeps session order', () => {
    const sessions = [s('a', 'running'), s('b', 'exited'), s('c', 'running')];
    expect(mounts(sessions, ['b'], ['b:0'])).toEqual(['a:run', 'b:view', 'c:run']);
  });
});

describe('nextRanPaneKeys', () => {
  it('adds the mounted keys and keeps earlier ones while a session still has that key', () => {
    const next = nextRanPaneKeys(new Set(['a:0', 'gone:0', 'b:0']), ['c:0'], ['a:0', 'b:1', 'c:0']);
    expect([...next].sort()).toEqual(['a:0', 'c:0']);
  });

  it('a session switched away from keeps its key, so switching back remounts it', () => {
    const ran = nextRanPaneKeys(new Set(), ['a:0'], ['a:0', 'b:0']);
    const away = nextRanPaneKeys(ran, ['b:0'], ['a:0', 'b:0']);
    expect(away.has('a:0')).toBe(true);
    expect(
      terminalPaneMounts([s('a', 'exited')], { shown: new Set(['a']), ran: away, keyOf }).map(
        (m) => m.mode,
      ),
    ).toEqual(['view']);
  });
});
