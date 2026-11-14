import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CodexWatchDeps,
  createCodexRolloutWatch,
} from '../../server/domain/codex-rollout-watch';
import type { LimitSignal } from '../../src/contracts/auto-resume';

const FIXTURES = join(__dirname, '..', 'fixtures', 'codex-rollout');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8').trimEnd();
const PRIMARY = fixture('primary-meta.jsonl');
const GUARDIAN = fixture('guardian-meta.jsonl');
const LIMIT_TASK_COMPLETE = fixture('limit.jsonl').split('\n')[2] ?? '';

const ROOT = '/sessions';
const DAY12 = '/sessions/2026/11/12';
const DAY13 = '/sessions/2026/11/13';
const FILE_A = `${DAY12}/rollout-a.jsonl`;
const FILE_B = `${DAY12}/rollout-b.jsonl`;
const NOW = Date.parse('2026-11-12T21:02:00Z');
const LAUNCH = Date.parse('2026-11-12T21:00:40Z');

interface Live {
  onEvent(event: string, filename: string | null): void;
  onGone(error?: Error): void;
  closed: boolean;
}

function harness() {
  const files = new Map<string, string>();
  const dirs = new Set<string>([DAY12]);
  const live = new Map<string, Live>();
  const failWatch = new Set<string>();
  const opened: string[] = [];
  const signals: LimitSignal[] = [];
  const warnings: string[] = [];
  const deps: CodexWatchDeps = {
    sessionsRoot: ROOT,
    now: () => NOW,
    localDate: () => ({ y: 2026, m: 11, d: 12 }),
    watchDir: (dir, _opts, onEvent, onGone) => {
      if (failWatch.has(dir)) throw new Error('EMFILE: too many open files');
      opened.push(dir);
      const watch: Live = { onEvent, onGone, closed: false };
      live.set(dir, watch);
      return {
        close() {
          watch.closed = true;
          if (live.get(dir) === watch) live.delete(dir);
        },
      };
    },
    fs: {
      readdir: async (p) => {
        if (!dirs.has(p)) throw new Error(`ENOENT ${p}`);
        return [...files.keys()]
          .filter((f) => posix.dirname(f) === p)
          .map((f) => posix.basename(f));
      },
      readFirstLine: async (p) => {
        const content = files.get(p);
        if (content === undefined) return null;
        const i = content.indexOf('\n');
        return i < 0 ? null : content.slice(0, i);
      },
      readFrom: async (p, offset) => {
        const content = files.get(p) ?? '';
        return { data: content.slice(offset), size: content.length };
      },
      exists: async (p) => dirs.has(p),
    },
    samePath: (a, b) => a === b,
    episodeOpen: () => false,
    onSignal: (s) => signals.push(s),
    log: {
      debug: () => {},
      warn: (msg) => warnings.push(msg),
    },
  };
  const emit = (dir: string, name: string | null) => live.get(dir)?.onEvent('rename', name);
  return { deps, files, dirs, live, failWatch, opened, signals, warnings, emit };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('codex rollout watch', () => {
  it('binds the primary file on its first line and reads its appended limit line', async () => {
    const h = harness();
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', launchAt: LAUNCH });
    await flush();

    h.files.set(FILE_A, `${PRIMARY}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    await flush();
    expect(watch.boundFile('s1')).toBe(FILE_A);
    expect(h.live.has(DAY12)).toBe(true);

    h.files.set(FILE_A, `${PRIMARY}\n${LIMIT_TASK_COMPLETE}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    vi.advanceTimersByTime(250);
    await flush();
    expect(h.signals).toContainEqual(
      expect.objectContaining({ kind: 'limited', sessionId: 's1', source: 'codex-rollout' }),
    );
  });

  it('does not bind a subagent meta line even with the same cwd', async () => {
    const h = harness();
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', launchAt: LAUNCH });
    await flush();
    h.files.set(FILE_A, `${GUARDIAN}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    await flush();
    expect(watch.boundFile('s1')).toBeNull();
  });

  it('refuses an ambiguous file when two unbound sessions qualify, and warns', async () => {
    const h = harness();
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', launchAt: LAUNCH });
    watch.track('s2', { cwd: '/work/project', launchAt: LAUNCH });
    await flush();
    h.files.set(FILE_A, `${PRIMARY}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    await flush();
    expect(watch.boundFile('s1')).toBeNull();
    expect(watch.boundFile('s2')).toBeNull();
    expect(h.warnings).toHaveLength(1);
  });

  it('replays a limit line written before the late bind, from offset zero', async () => {
    const h = harness();
    h.files.set(FILE_A, `${PRIMARY}\n${LIMIT_TASK_COMPLETE}\n`);
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', launchAt: LAUNCH });
    await flush();
    expect(watch.boundFile('s1')).toBe(FILE_A);
    expect(h.signals.map((s) => s.kind)).toEqual(['limited']);
  });

  it('holds a partial last line back until its newline arrives', async () => {
    const h = harness();
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', launchAt: LAUNCH });
    await flush();
    h.files.set(FILE_A, `${PRIMARY}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    await flush();

    const cut = Math.floor(LIMIT_TASK_COMPLETE.length / 2);
    h.files.set(FILE_A, `${PRIMARY}\n${LIMIT_TASK_COMPLETE.slice(0, cut)}`);
    h.emit(DAY12, 'rollout-a.jsonl');
    vi.advanceTimersByTime(250);
    await flush();
    expect(h.signals).toEqual([]);

    h.files.set(FILE_A, `${PRIMARY}\n${LIMIT_TASK_COMPLETE}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    vi.advanceTimersByTime(250);
    await flush();
    expect(h.signals.map((s) => s.kind)).toEqual(['limited']);
  });

  it('watches the day folders only, never the sessions root', async () => {
    const h = harness();
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', launchAt: LAUNCH });
    await flush();
    expect(h.opened).toEqual([DAY12]);

    h.dirs.add(DAY13);
    vi.advanceTimersByTime(2000);
    await flush();
    expect(h.opened).toEqual([DAY12, DAY13]);
    expect(h.opened).not.toContain(ROOT);
  });

  it('releases its folder watch when the last unbound session is untracked', async () => {
    const h = harness();
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', launchAt: LAUNCH });
    await flush();
    expect(h.live.size).toBe(1);
    watch.untrack('s1');
    expect(h.live.size).toBe(0);
  });

  it('dispose closes every watch and drops the tracked sessions', async () => {
    const h = harness();
    h.files.set(FILE_A, `${PRIMARY}\n`);
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', launchAt: LAUNCH });
    await flush();
    expect(watch.boundFile('s1')).toBe(FILE_A);
    watch.dispose();
    expect(h.live.size).toBe(0);
    expect(watch.boundFile('s1')).toBeNull();
  });

  it('binds a second file for a later session without re-binding the first', async () => {
    const h = harness();
    h.files.set(FILE_A, `${PRIMARY}\n`);
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', launchAt: LAUNCH });
    await flush();
    expect(watch.boundFile('s1')).toBe(FILE_A);

    const later = PRIMARY.replace('2026-11-12T21:00:44.670Z', '2026-11-12T21:01:30.000Z').replace(
      '01a1d190-1af2-7db3-ae44-cb9dacc349ed',
      '01a1d190-aaaa-7db3-ae44-cb9dacc349ed',
    );
    h.files.set(FILE_B, `${later}\n`);
    watch.track('s2', { cwd: '/work/project', launchAt: Date.parse('2026-11-12T21:01:20Z') });
    await flush();
    expect(watch.boundFile('s2')).toBe(FILE_B);
    expect(watch.boundFile('s1')).toBe(FILE_A);
  });

  it('re-reads a first line that did not parse yet, instead of caching the miss', async () => {
    const h = harness();
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', launchAt: LAUNCH });
    await flush();
    h.files.set(FILE_A, `${PRIMARY.slice(0, 40)}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    await flush();
    expect(watch.boundFile('s1')).toBeNull();

    h.files.set(FILE_A, `${PRIMARY}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    await flush();
    expect(watch.boundFile('s1')).toBe(FILE_A);
  });

  it('reads every bound file in a folder when the event names no file', async () => {
    const h = harness();
    h.files.set(FILE_A, `${PRIMARY}\n`);
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', launchAt: LAUNCH });
    await flush();
    expect(watch.boundFile('s1')).toBe(FILE_A);

    h.files.set(FILE_A, `${PRIMARY}\n${LIMIT_TASK_COMPLETE}\n`);
    h.emit(DAY12, null);
    vi.advanceTimersByTime(250);
    await flush();
    expect(h.signals.map((x) => x.kind)).toEqual(['limited']);
  });

  it('warns once per folder while the watch keeps throwing, and again after the folder goes missing', async () => {
    const h = harness();
    h.failWatch.add(DAY12);
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', launchAt: LAUNCH });
    await flush();
    const openWarnings = () => h.warnings.filter((w) => w === 'could not watch rollout folder');
    vi.advanceTimersByTime(2000);
    await flush();
    vi.advanceTimersByTime(2000);
    await flush();
    expect(openWarnings()).toHaveLength(1);

    h.dirs.delete(DAY12);
    vi.advanceTimersByTime(2000);
    await flush();
    h.dirs.add(DAY12);
    vi.advanceTimersByTime(2000);
    await flush();
    expect(openWarnings()).toHaveLength(2);
  });

  it('reopens a folder whose watch errored, and still emits lines appended afterwards', async () => {
    const h = harness();
    h.files.set(FILE_A, `${PRIMARY}\n`);
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', launchAt: LAUNCH });
    await flush();
    expect(watch.boundFile('s1')).toBe(FILE_A);
    const openedBefore = h.opened.filter((d) => d === DAY12).length;

    const before = h.live.get(DAY12);
    before?.onGone(new Error('x'));
    vi.advanceTimersByTime(2000);
    await flush();
    expect(h.opened.filter((d) => d === DAY12)).toHaveLength(openedBefore + 1);
    const reopened = h.live.get(DAY12);
    expect(reopened).toBeDefined();
    expect(reopened).not.toBe(before);

    h.files.set(FILE_A, `${PRIMARY}\n${LIMIT_TASK_COMPLETE}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    vi.advanceTimersByTime(250);
    await flush();
    expect(h.signals.map((x) => x.kind)).toEqual(['limited']);
  });

  it('warns again for a folder that failed, left the sessions, and came back', async () => {
    const h = harness();
    h.failWatch.add(DAY12);
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', launchAt: LAUNCH });
    await flush();
    const openWarnings = () => h.warnings.filter((w) => w === 'could not watch rollout folder');
    expect(openWarnings()).toHaveLength(1);

    watch.untrack('s1');
    await flush();
    watch.track('s2', { cwd: '/work/project', launchAt: LAUNCH });
    await flush();
    expect(openWarnings()).toHaveLength(2);
  });
});
