import {
  promises as fsp,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRolloutFs } from '../../server/domain/codex-rollout-fs';
import {
  type CodexWatchDeps,
  createCodexRolloutWatch,
} from '../../server/domain/codex-rollout-watch';
import type { CodexAction } from '../../src/codex-rollout';
import type { LimitSignal } from '../../src/contracts/auto-resume';

const FIXTURES = join(__dirname, '..', 'fixtures', 'codex-rollout');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8').trimEnd();
const PRIMARY = fixture('primary-meta.jsonl');
const GUARDIAN = fixture('guardian-meta.jsonl');
const LIMIT_TASK_COMPLETE = fixture('limit.jsonl').split('\n')[2] ?? '';
const ACTION_LINES = fixture('actions.jsonl').split('\n');

const ROOT = '/sessions';
const DAY12 = '/sessions/2026/11/12';
const DAY13 = '/sessions/2026/11/13';
const FILE_A = `${DAY12}/rollout-a.jsonl`;
const FILE_B = `${DAY12}/rollout-b.jsonl`;
const NOW = Date.parse('2026-11-12T21:02:00Z');
const IDS = { generation: 1, launchId: 'a'.repeat(32) };
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
  const bound: string[] = [];
  const signals: LimitSignal[] = [];
  const actions: { sessionId: string; action: CodexAction }[] = [];
  const feeds: { sessionId: string; state: string }[] = [];
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
      readFrom: async function* (p, offset, discarding = false) {
        const content = files.get(p) ?? '';
        yield {
          kind: 'start',
          identity: { dev: 1, ino: 1, fileSize: content.length },
          highWater: content.length,
        };
        const tail = content.slice(offset);
        const end = tail.lastIndexOf('\n') + 1;
        if (end)
          yield {
            kind: 'lines',
            lines: tail.slice(0, end).split('\n').slice(0, -1),
            cursor: offset + end,
            discarding,
          };
        yield { kind: 'end', cursor: offset + end, discarding };
      },
      pathIdentity: async (p) => ({ dev: 1, ino: 1, fileSize: (files.get(p) ?? '').length }),
      exists: async (p) => dirs.has(p),
    },
    samePath: (a, b) => a === b,
    episodeOpen: () => false,
    onSignal: (s) => signals.push(s),
    onPosture: () => {},
    onBound: (id) => bound.push(id),
    onAction: (sessionId, action) => actions.push({ sessionId, action }),
    onFeed: (sessionId, state) => feeds.push({ sessionId, state }),
    log: {
      debug: () => {},
      warn: (msg) => warnings.push(msg),
    },
  };
  const emit = (dir: string, name: string | null) => live.get(dir)?.onEvent('rename', name);
  return {
    deps,
    files,
    dirs,
    live,
    failWatch,
    opened,
    signals,
    actions,
    feeds,
    warnings,
    emit,
    bound,
  };
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
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
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
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    h.files.set(FILE_A, `${GUARDIAN}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    await flush();
    expect(watch.boundFile('s1')).toBeNull();
  });

  it('refuses an ambiguous file when two unbound sessions qualify, and warns', async () => {
    const h = harness();
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    watch.track('s2', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
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
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    expect(watch.boundFile('s1')).toBe(FILE_A);
    expect(h.signals.map((s) => s.kind)).toEqual(['limited']);
    expect(h.bound).toEqual(['s1']);
  });

  it('a late bind replays only the end state: no old turn as resumed, limit only if still current', async () => {
    const turn = fixture('turn.jsonl').split('\n');
    const limit = fixture('limit.jsonl').split('\n');
    const h = harness();
    // An earlier finished turn, then the turn that ended in the limit.
    h.files.set(FILE_A, [PRIMARY, ...turn, ...limit].join('\n') + '\n');
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    expect(h.signals.map((s) => s.kind)).toEqual(['reset-info', 'limited']);

    const g = harness();
    // The limit, then a later turn started: the limit is history.
    g.files.set(FILE_A, [PRIMARY, ...limit, turn[0]].join('\n') + '\n');
    const w2 = createCodexRolloutWatch(g.deps);
    w2.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    expect(g.signals.map((s) => s.kind)).toEqual(['reset-info']);
  });

  it('a late bind whose file ends with a turn after the limit answers an open episode as resumed', async () => {
    const turn = fixture('turn.jsonl').split('\n');
    const limit = fixture('limit.jsonl').split('\n');
    const h = harness();
    h.deps.episodeOpen = () => true;
    h.files.set(FILE_A, [PRIMARY, ...limit, turn[0]].join('\n') + '\n');
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    expect(h.signals.map((s) => s.kind)).toEqual(['reset-info', 'resumed']);
  });

  it('holds a partial last line back until its newline arrives', async () => {
    const h = harness();
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
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
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
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
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    expect(h.live.size).toBe(1);
    watch.untrack('s1');
    expect(h.live.size).toBe(0);
  });

  it('dispose closes every watch and drops the tracked sessions', async () => {
    const h = harness();
    h.files.set(FILE_A, `${PRIMARY}\n`);
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
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
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    expect(watch.boundFile('s1')).toBe(FILE_A);

    const later = PRIMARY.replace('2026-11-12T21:00:44.670Z', '2026-11-12T21:01:30.000Z').replace(
      '01a1d190-1af2-7db3-ae44-cb9dacc349ed',
      '01a1d190-aaaa-7db3-ae44-cb9dacc349ed',
    );
    h.files.set(FILE_B, `${later}\n`);
    watch.track('s2', {
      cwd: '/work/project',
      ids: IDS,
      launchAt: Date.parse('2026-11-12T21:01:20Z'),
    });
    await flush();
    expect(watch.boundFile('s2')).toBe(FILE_B);
    expect(watch.boundFile('s1')).toBe(FILE_A);
  });

  it('re-reads a first line that did not parse yet, instead of caching the miss', async () => {
    const h = harness();
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
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
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
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
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
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
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
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
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    const openWarnings = () => h.warnings.filter((w) => w === 'could not watch rollout folder');
    expect(openWarnings()).toHaveLength(1);

    watch.untrack('s1');
    await flush();
    watch.track('s2', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    expect(openWarnings()).toHaveLength(2);
  });
  it('replay emits no actions', async () => {
    const h = harness();
    h.files.set(FILE_A, `${[PRIMARY, ...ACTION_LINES].join('\n')}\n`);
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    expect(watch.boundFile('s1')).toBe(FILE_A);
    expect(h.actions).toEqual([]);
  });

  it('new item_completed emits one action', async () => {
    const h = harness();
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    h.files.set(FILE_A, `${PRIMARY}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    await flush();
    expect(watch.boundFile('s1')).toBe(FILE_A);

    h.files.set(FILE_A, `${PRIMARY}\n${ACTION_LINES[1]}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    vi.advanceTimersByTime(250);
    await flush();
    expect(h.actions).toEqual([
      {
        sessionId: 's1',
        action: {
          kind: 'command',
          command: 'echo hi',
          cwd: '/work/project',
          exitCode: 0,
          durationMs: 0,
        },
      },
    ]);
  });

  it('new FileChange item emits one file-change action with its paths only', async () => {
    const h = harness();
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    h.files.set(FILE_A, `${PRIMARY}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    await flush();

    h.files.set(FILE_A, `${PRIMARY}\n${ACTION_LINES[2]}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    vi.advanceTimersByTime(250);
    await flush();
    expect(h.actions).toEqual([
      {
        sessionId: 's1',
        action: { kind: 'file-change', paths: ['/work/project/a.txt', '/work/project/b.txt'] },
      },
    ]);
  });

  it('ambiguous bind reports unavailable once per session', async () => {
    const h = harness();
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    watch.track('s2', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    h.files.set(FILE_A, `${PRIMARY}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    await flush();
    expect(h.feeds).toEqual([
      { sessionId: 's1', state: 'unavailable' },
      { sessionId: 's2', state: 'unavailable' },
    ]);

    const later = PRIMARY.replace(
      '01a1d190-1af2-7db3-ae44-cb9dacc349ed',
      '01a1d190-bbbb-7db3-ae44-cb9dacc349ed',
    );
    h.files.set(FILE_B, `${later}\n`);
    h.emit(DAY12, 'rollout-b.jsonl');
    await flush();
    expect(h.feeds).toHaveLength(2);
  });
});

describe('bounded stream integration', () => {
  it('does not retry an incomplete line without another notification', async () => {
    const h = harness();
    h.files.set(FILE_A, `${PRIMARY}\npartial`);
    const read = h.deps.fs.readFrom;
    let reads = 0;
    h.deps.fs.readFrom = (file, offset, discard) => {
      reads++;
      return read(file, offset, discard);
    };
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    expect(reads).toBe(1);
    vi.advanceTimersByTime(10_000);
    await flush();
    expect(reads).toBe(1);
    watch.dispose();
  });

  it.skipIf(process.platform === 'win32').each(['replacement', 'truncation'] as const)(
    'rejects an in-flight real descriptor after %s',
    async (change) => {
      const dir = mkdtempSync(join(tmpdir(), 'rollout-revision-'));
      const realFile = join(dir, 'rollout.jsonl');
      const oldFile = join(dir, 'old.jsonl');
      const content = `${PRIMARY}\n${LIMIT_TASK_COMPLETE}\n`;
      writeFileSync(realFile, content);
      const h = harness();
      h.files.set(FILE_A, content);
      const real = createRolloutFs({ onFirstLineTooLong: () => {}, chunkBytes: 64 });
      const open = fsp.open.bind(fsp);
      let close: ReturnType<typeof vi.spyOn> | undefined;
      const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        close = vi.spyOn(handle, 'close');
        return handle;
      });
      let release: (() => void) | undefined;
      let paused = false;
      let finished = false;
      let opens = 0;
      h.deps.fs.readFrom = async function* (_file, offset, discard) {
        opens++;
        try {
          for await (const event of real.readFrom(realFile, offset, discard)) {
            yield event;
            if (event.kind === 'start' && opens === 1) {
              paused = true;
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            }
          }
        } finally {
          finished = true;
        }
      };
      h.deps.fs.pathIdentity = () => real.pathIdentity(realFile);
      const updates: string[] = [];
      h.deps.onPosture = (id) => updates.push(id);
      const watch = createCodexRolloutWatch(h.deps);
      try {
        watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
        await vi.waitFor(() => expect(paused).toBe(true));
        if (change === 'replacement') {
          renameSync(realFile, oldFile);
          writeFileSync(realFile, content);
        } else {
          truncateSync(realFile, 0);
        }
        release?.();
        await vi.waitFor(() => expect(finished).toBe(true));
        expect(close).toHaveBeenCalledOnce();
        expect(h.signals).toEqual([]);
        expect(h.actions).toEqual([]);
        expect(updates).toEqual([]);
        expect(watch.linkPosture('s1', IDS, '01a1d190-1af2-7db3-ae44-cb9dacc349ed')).toBe(false);
        if (change === 'truncation') writeFileSync(realFile, content);
        h.emit(DAY12, 'rollout-a.jsonl');
        vi.advanceTimersByTime(250);
        await flush();
        expect(opens).toBe(1);
        expect(h.signals).toEqual([]);
        expect(h.actions).toEqual([]);
        expect(updates).toEqual([]);
      } finally {
        release?.();
        watch.dispose();
        openSpy.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'retires established posture after a real in-flight short read',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'rollout-short-'));
      const realFile = join(dir, 'rollout.jsonl');
      const uuid = '01a1d190-1af2-7db3-ae44-cb9dacc349ed';
      const initial = `${PRIMARY}\n`;
      writeFileSync(realFile, initial);
      const h = harness();
      h.files.set(FILE_A, initial);
      const real = createRolloutFs({ onFirstLineTooLong: () => {}, chunkBytes: 64 });
      let release: (() => void) | undefined;
      let pause = false;
      let paused = false;
      let completed = 0;
      h.deps.fs.readFrom = async function* (_file, offset, discard) {
        try {
          for await (const event of real.readFrom(realFile, offset, discard)) {
            yield event;
            if (pause && event.kind === 'start') {
              paused = true;
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            }
          }
        } finally {
          completed++;
        }
      };
      h.deps.fs.pathIdentity = () => real.pathIdentity(realFile);
      const updates: string[] = [];
      h.deps.onPosture = (id) => updates.push(id);
      const watch = createCodexRolloutWatch(h.deps);
      try {
        watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
        await vi.waitFor(() => expect(completed).toBe(1));
        expect(watch.linkPosture('s1', IDS, uuid)).toBe(true);
        writeFileSync(realFile, `${initial}${LIMIT_TASK_COMPLETE}\n`);
        pause = true;
        h.emit(DAY12, 'rollout-a.jsonl');
        vi.advanceTimersByTime(250);
        await vi.waitFor(() => expect(paused).toBe(true));
        truncateSync(realFile, 0);
        release?.();
        await vi.waitFor(() => expect(completed).toBe(2));
        expect(watch.getPosture('s1', IDS)).toBeNull();
        expect(watch.linkPosture('s1', IDS, uuid)).toBe(false);
        expect(watch.linkPosture('s1', { ...IDS, generation: 2 }, uuid)).toBe(false);
        expect(updates).toEqual(['s1']);
        expect(h.signals).toEqual([]);
      } finally {
        release?.();
        watch.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('replays a real multi-chunk archive around an oversized resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rollout-replay-'));
    try {
      for (const laterLimit of [false, true]) {
        const h = harness();
        const realFile = join(dir, laterLimit ? 'later.jsonl' : 'early.jsonl');
        const resume = fixture('turn.jsonl').split('\n')[0] ?? '';
        const rows = [PRIMARY, LIMIT_TASK_COMPLETE, `${resume}${' '.repeat(4096)}`];
        if (laterLimit) rows.push(LIMIT_TASK_COMPLETE);
        const content = `${rows.join('\n')}\n`;
        writeFileSync(realFile, content);
        h.files.set(FILE_A, content);
        const real = createRolloutFs({
          onFirstLineTooLong: () => {},
          recordMaxBytes: 2048,
          chunkBytes: 64,
        });
        let completed = false;
        h.deps.fs.readFrom = async function* (_file, offset, discard) {
          yield* real.readFrom(realFile, offset, discard);
          completed = true;
        };
        h.deps.fs.pathIdentity = () => real.pathIdentity(realFile);
        const watch = createCodexRolloutWatch(h.deps);
        watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
        await vi.waitFor(() => expect(completed).toBe(true));
        expect(h.signals.map((signal) => signal.kind)).toEqual(laterLimit ? ['limited'] : []);
        watch.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forgets replay conclusions across a gap', async () => {
    const h = harness();
    const content = `${PRIMARY}\n${LIMIT_TASK_COMPLETE}\nmissing\n`;
    h.files.set(FILE_A, content);
    h.deps.fs.readFrom = async function* () {
      yield {
        kind: 'start',
        identity: { dev: 1, ino: 1, fileSize: content.length },
        highWater: content.length,
      };
      yield {
        kind: 'lines',
        lines: [PRIMARY, LIMIT_TASK_COMPLETE],
        cursor: content.length - 8,
        discarding: false,
      };
      yield { kind: 'gap', cursor: content.length, discarding: false };
      yield { kind: 'end', cursor: content.length, discarding: false };
    };
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    expect(h.signals).toEqual([]);
    watch.dispose();
  });

  it('commits a delivered live batch before a later read error', async () => {
    const h = harness();
    h.files.set(FILE_A, `${PRIMARY}\n`);
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    const line = ACTION_LINES[1] ?? '';
    const oldSize = `${PRIMARY}\n`.length;
    const content = `${PRIMARY}\n${line}\n`;
    h.files.set(FILE_A, content);
    const original = h.deps.fs.readFrom;
    let fail = true;
    h.deps.fs.readFrom = async function* (file, offset, discard) {
      if (!fail) {
        yield* original(file, offset, discard);
        return;
      }
      fail = false;
      yield {
        kind: 'start',
        identity: { dev: 1, ino: 1, fileSize: content.length },
        highWater: content.length,
      };
      yield { kind: 'lines', lines: [line], cursor: content.length, discarding: false };
      throw new Error('read failed');
    };
    h.emit(DAY12, 'rollout-a.jsonl');
    vi.advanceTimersByTime(250);
    await flush();
    const delivered = h.actions.length;
    expect(delivered).toBeGreaterThan(0);
    expect(content.length).toBeGreaterThan(oldSize);
    h.emit(DAY12, 'rollout-a.jsonl');
    vi.advanceTimersByTime(250);
    await flush();
    expect(h.actions).toHaveLength(delivered);
    watch.dispose();
  });

  it('blocks links during an in-flight read and rejects an old generation', async () => {
    const h = harness();
    const uuid = '01a1d190-1af2-7db3-ae44-cb9dacc349ed';
    h.files.set(FILE_A, `${PRIMARY}\n`);
    const watch = createCodexRolloutWatch(h.deps);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    const read = h.deps.fs.readFrom;
    let release: (() => void) | undefined;
    h.deps.fs.readFrom = async function* (file, offset, discard) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield* read(file, offset, discard);
    };
    h.emit(DAY12, 'rollout-a.jsonl');
    vi.advanceTimersByTime(250);
    await flush();
    expect(watch.linkPosture('s1', IDS, uuid)).toBe(false);
    watch.untrack('s1');
    watch.track('s1', { cwd: '/work/project', ids: { ...IDS, generation: 2 }, launchAt: LAUNCH });
    release?.();
    await flush();
    expect(watch.linkPosture('s1', IDS, uuid)).toBe(false);
    watch.dispose();
  });
});

describe('linked posture continuity', () => {
  it.each(['replacement', 'truncation'] as const)(
    'never processes a later notification after %s',
    async (mode) => {
      const h = harness();
      h.files.set(FILE_A, `${PRIMARY}\n`);
      const watch = createCodexRolloutWatch(h.deps);
      watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
      await flush();
      const original = h.deps.fs.readFrom;
      let first = true;
      h.deps.fs.readFrom = async function* (file, offset, discard) {
        if (first) {
          first = false;
          const size = mode === 'truncation' ? 0 : offset;
          yield {
            kind: 'start',
            identity: { dev: 1, ino: mode === 'replacement' ? 2 : 1, fileSize: size },
            highWater: size,
          };
          yield { kind: 'end', cursor: size, discarding: false };
          return;
        }
        yield* original(file, offset, discard);
      };
      h.emit(DAY12, 'rollout-a.jsonl');
      vi.advanceTimersByTime(250);
      await flush();
      h.files.set(FILE_A, `${PRIMARY}\n${LIMIT_TASK_COMPLETE}\n`);
      h.emit(DAY12, 'rollout-a.jsonl');
      vi.advanceTimersByTime(250);
      await flush();
      expect(h.signals).toEqual([]);
      expect(h.actions).toEqual([]);
      watch.dispose();
    },
  );

  it('marks errors stale, recovers only on context, and invalidates replacement', async () => {
    const h = harness();
    let mode: 'normal' | 'error' | 'replacement' = 'normal';
    const read = h.deps.fs.readFrom;
    h.deps.fs.readFrom = async function* (file, offset, discard) {
      if (mode === 'error') throw new Error('unavailable');
      for await (const event of read(file, offset, discard)) {
        if (mode === 'replacement' && event.kind === 'start')
          yield { ...event, identity: { dev: 1, ino: 2, fileSize: event.highWater } };
        else yield event;
      }
    };
    const watch = createCodexRolloutWatch(h.deps);
    const uuid = '01a1d190-1af2-7db3-ae44-cb9dacc349ed';
    const context = JSON.stringify({
      type: 'turn_context',
      timestamp: '2026-11-17T12:00:00Z',
      payload: { sandbox_policy: { type: 'read-only' }, approval_policy: 'never' },
    });
    h.files.set(FILE_A, `${PRIMARY}\n${context}\n`);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    mode = 'error';
    h.emit(DAY12, 'rollout-a.jsonl');
    vi.advanceTimersByTime(250);
    await flush();
    expect(watch.linkPosture('s1', IDS, uuid)).toBe(true);
    expect(watch.getPosture('s1', IDS)?.freshness).toBe('stale');
    mode = 'error';
    h.emit(DAY12, 'rollout-a.jsonl');
    vi.advanceTimersByTime(250);
    await flush();
    expect(watch.getPosture('s1', IDS)?.freshness).toBe('stale');
    mode = 'normal';
    h.files.set(FILE_A, `${PRIMARY}\n${context}\n${context}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    vi.advanceTimersByTime(250);
    await flush();
    expect(watch.getPosture('s1', IDS)?.freshness).toBe('current');
    mode = 'replacement';
    h.emit(DAY12, 'rollout-a.jsonl');
    vi.advanceTimersByTime(250);
    await flush();
    expect(watch.getPosture('s1', IDS)).toBeNull();
    expect(watch.linkPosture('s1', IDS, uuid)).toBe(false);
    watch.dispose();
  });
});

describe('linked posture', () => {
  it('uses only the bound UUID and folds each complete context in order', async () => {
    const h = harness();
    const updates: string[] = [];
    h.deps.onPosture = (id) => updates.push(id);
    const watch = createCodexRolloutWatch(h.deps);
    h.files.set(FILE_A, `${PRIMARY}\n`);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    expect(watch.linkPosture('s1', IDS, '01a1d190-aaaa-7db3-ae44-cb9dacc349ed')).toBe(false);
    expect(
      watch.linkPosture('s1', { ...IDS, generation: 2 }, '01a1d190-1af2-7db3-ae44-cb9dacc349ed'),
    ).toBe(false);
    expect(watch.linkPosture('s1', IDS, '01a1d190-1af2-7db3-ae44-cb9dacc349ed')).toBe(true);
    expect(watch.getPosture('s1', IDS)?.reading).toBeNull();
    const context = (payload: object) =>
      JSON.stringify({ type: 'turn_context', timestamp: '2026-11-17T12:00:00Z', payload });
    h.files.set(
      FILE_A,
      `${PRIMARY}\n${context({ sandbox_policy: { type: 'workspace-write' }, approval_policy: 'never' })}\n${context({})}\n`,
    );
    h.emit(DAY12, 'rollout-a.jsonl');
    vi.advanceTimersByTime(250);
    await flush();
    expect(updates).toEqual(['s1']);
    expect(watch.getPosture('s1', IDS)).toEqual({
      freshness: 'current',
      reading: { status: 'unknown', reportedAt: Date.parse('2026-11-17T12:00:00Z') },
      lastKnown: {
        status: 'known',
        reportedAt: Date.parse('2026-11-17T12:00:00Z'),
        sandbox: 'workspace-write',
        approval: 'never',
      },
    });
    watch.untrack('s1');
    expect(watch.getPosture('s1', IDS)).toBeNull();
    watch.dispose();
  });
});

describe('posture retirement', () => {
  it('permanently retires only matching IDs even when a read is in flight', async () => {
    const h = harness();
    const uuid = '01a1d190-1af2-7db3-ae44-cb9dacc349ed';
    let release: (() => void) | undefined;
    let hold = false;
    const read = h.deps.fs.readFrom;
    h.deps.fs.readFrom = async function* (file, offset, discard) {
      for await (const event of read(file, offset, discard)) {
        if (hold) {
          hold = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        yield event;
      }
    };
    const watch = createCodexRolloutWatch(h.deps);
    h.files.set(FILE_A, `${PRIMARY}\n`);
    watch.track('s1', { cwd: '/work/project', ids: IDS, launchAt: LAUNCH });
    await flush();
    expect(watch.linkPosture('s1', IDS, uuid)).toBe(true);
    watch.unlinkPosture('s1', { ...IDS, generation: 2 });
    expect(watch.getPosture('s1', IDS)).not.toBeNull();
    hold = true;
    const context = JSON.stringify({
      type: 'turn_context',
      timestamp: '2026-11-17T12:00:00Z',
      payload: { sandbox_policy: { type: 'read-only' }, approval_policy: 'never' },
    });
    h.files.set(FILE_A, `${PRIMARY}\n${context}\n`);
    h.emit(DAY12, 'rollout-a.jsonl');
    vi.advanceTimersByTime(250);
    await flush();
    expect(release).toBeDefined();
    watch.unlinkPosture('s1', IDS);
    expect(watch.getPosture('s1', IDS)).toBeNull();
    expect(watch.linkPosture('s1', IDS, uuid)).toBe(false);
    release?.();
    await flush();
    expect(watch.linkPosture('s1', IDS, uuid)).toBe(false);
    expect(watch.boundFile('s1')).toBe(FILE_A);
    watch.dispose();
  });
});
