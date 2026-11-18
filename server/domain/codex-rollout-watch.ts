import { dirname, join } from 'node:path';
import { type DirWatch, EXISTS_POLL_MS, type watchDir } from '../../electron/watch-dir';
import {
  bindsTo,
  type CodexAction,
  LineSplitter,
  parseRolloutMeta,
  type RolloutMeta,
  rolloutActions,
  rolloutPosture,
  rolloutSignals,
} from '../../src/codex-rollout';
import type { LimitSignal } from '../../src/contracts/auto-resume';
import type { CodexPostureUpdate } from '../../src/contracts/native-launch';
import type { LaunchIds } from '../../src/contracts/terminal-runtime';

const READ_DEBOUNCE_MS = 250;

export interface CodexWatchDeps {
  sessionsRoot: string;
  now(): number;
  localDate(ms: number): { y: number; m: number; d: number };
  watchDir: typeof watchDir;
  fs: {
    readdir(p: string): Promise<string[]>;
    readFirstLine(p: string): Promise<string | null>;
    readFrom(
      p: string,
      offset: number,
    ): Promise<{
      data: string;
      size: number;
      identity: { dev: number; ino: number; fileSize: number } | null;
    }>;
    exists(p: string): Promise<boolean>;
  };
  samePath(a: string, b: string): boolean;
  episodeOpen(sessionId: string): boolean;
  onSignal(s: LimitSignal): void;
  onPosture(sessionId: string, ids: LaunchIds): void;
  /** A session got its rollout file: a structured adapter speaks for it from now on (spec R13). */
  onBound(sessionId: string): void;
  onAction(sessionId: string, action: CodexAction): void;
  onFeed(sessionId: string, state: 'unavailable'): void;
  log: { debug(msg: string, data?: object): void; warn(msg: string, data?: object): void };
}

export interface CodexWatch {
  track(sessionId: string, s: { cwd: string; launchAt: number; ids: LaunchIds }): void;
  linkPosture(sessionId: string, ids: LaunchIds, threadId: string): boolean;
  getPosture(sessionId: string, ids: LaunchIds): CodexPostureUpdate | null;
  unlinkPosture(sessionId: string, ids: LaunchIds): void;
  untrack(sessionId: string): void;
  boundFile(sessionId: string): string | null;
  dispose(): void;
}

interface Tracked {
  ids: LaunchIds;
  identity: { dev: number; ino: number } | null;
  metaId: string | null;
  linked: boolean;
  postureRetired: boolean;
  posture: CodexPostureUpdate;
  cwd: string;
  launchAt: number;
  boundFile: string | null;
  offset: number;
  splitter: LineSplitter;
  reading: boolean;
  readAgain: boolean;
  /** The first read after a bind is history, not news (see readBound). */
  replayed: boolean;
  feedReported: boolean;
  debounce: ReturnType<typeof setTimeout> | null;
}

interface Day {
  y: number;
  m: number;
  d: number;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const isRolloutFile = (name: string): boolean =>
  name.startsWith('rollout-') && name.endsWith('.jsonl');

function nextDay({ y, m, d }: Day): Day {
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() };
}

export function createCodexRolloutWatch(deps: CodexWatchDeps): CodexWatch {
  const sessions = new Map<string, Tracked>();
  const metas = new Map<string, RolloutMeta | null>();
  const decided = new Set<string>();
  const inspecting = new Set<string>();
  const folders = new Map<string, DirWatch>();
  const opening = new Set<string>();
  const openWarned = new Set<string>();
  let poll: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const dirOf = ({ y, m, d }: Day): string => join(deps.sessionsRoot, String(y), pad(m), pad(d));

  const wantedFolders = (): Set<string> => {
    const wanted = new Set<string>();
    for (const s of sessions.values()) {
      if (s.boundFile !== null) {
        wanted.add(dirname(s.boundFile));
        continue;
      }
      const day = deps.localDate(s.launchAt);
      wanted.add(dirOf(day));
      wanted.add(dirOf(nextDay(day)));
    }
    return wanted;
  };

  const reconcile = (): void => {
    if (disposed) return;
    const wanted = wantedFolders();
    for (const [dir, watch] of folders) {
      if (wanted.has(dir)) continue;
      watch.close();
      folders.delete(dir);
    }
    for (const dir of openWarned) {
      if (!wanted.has(dir)) openWarned.delete(dir);
    }
    let missing = false;
    for (const dir of wanted) {
      if (folders.has(dir)) continue;
      missing = true;
      if (!opening.has(dir)) void openFolder(dir);
    }
    if (missing && !poll) {
      poll = setInterval(reconcile, EXISTS_POLL_MS);
    } else if (!missing && poll) {
      clearInterval(poll);
      poll = null;
    }
  };

  const openFolder = async (dir: string): Promise<void> => {
    opening.add(dir);
    try {
      if (!(await deps.fs.exists(dir))) {
        openWarned.delete(dir);
        return;
      }
      if (disposed || folders.has(dir) || !wantedFolders().has(dir)) return;
      try {
        const watch = deps.watchDir(
          dir,
          {},
          (_event, name) => onFolderEvent(dir, name),
          (error) => {
            folders.delete(dir);
            if (error) deps.log.warn('rollout folder watch failed', { dir, error: String(error) });
            reconcile();
          },
        );
        folders.set(dir, watch);
        openWarned.delete(dir);
      } catch (err) {
        if (!openWarned.has(dir)) {
          openWarned.add(dir);
          deps.log.warn('could not watch rollout folder', { dir, error: String(err) });
        }
        return;
      }
      await examineFolder(dir);
    } finally {
      opening.delete(dir);
    }
  };

  const examineFolder = async (dir: string): Promise<void> => {
    try {
      for (const name of await deps.fs.readdir(dir)) {
        if (isRolloutFile(name)) await examine(join(dir, name));
      }
    } catch (err) {
      deps.log.warn('could not list rollout folder', { dir, error: String(err) });
    }
  };

  const onFolderEvent = (dir: string, name: string | null): void => {
    if (name === null) {
      for (const [id, s] of sessions) {
        if (s.boundFile !== null && dirname(s.boundFile) === dir) scheduleRead(id);
      }
      void examineFolder(dir);
      return;
    }
    const file = join(dir, name);
    const bound = [...sessions].find(([, s]) => s.boundFile === file);
    if (bound) scheduleRead(bound[0]);
    else if (isRolloutFile(name)) void examine(file);
  };

  const readMeta = async (file: string): Promise<RolloutMeta | null> => {
    const line = await deps.fs.readFirstLine(file);
    if (line === null) return null;
    const meta = parseRolloutMeta(line);
    // a miss is not cached: the file may still be being written, so the next event reads it again
    if (meta) metas.set(file, meta);
    return meta;
  };

  const examine = async (file: string): Promise<void> => {
    if (decided.has(file) || inspecting.has(file)) return;
    inspecting.add(file);
    try {
      const meta = metas.get(file) ?? (await readMeta(file));
      if (!meta) return;
      const candidates = [...sessions]
        .filter(([, s]) => s.boundFile === null && bindsTo(meta, s, deps.samePath))
        .map(([id]) => id);
      if (candidates.length === 0) return;
      decided.add(file);
      if (candidates.length > 1) {
        deps.log.warn('rollout matches more than one session; those sessions use rules', {
          file,
          sessionIds: candidates,
        });
        for (const id of candidates) reportUnavailable(id);
        return;
      }
      const [only] = candidates;
      if (only !== undefined) bind(only, file);
    } finally {
      inspecting.delete(file);
    }
  };

  const reportUnavailable = (sessionId: string): void => {
    const s = sessions.get(sessionId);
    if (!s || s.feedReported) return;
    s.feedReported = true;
    deps.onFeed(sessionId, 'unavailable');
  };

  const bind = (sessionId: string, file: string): void => {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.boundFile = file;
    s.offset = 0;
    s.splitter = new LineSplitter();
    s.replayed = false;
    deps.onBound(sessionId);
    deps.log.debug('codex rollout bound', { sessionId, file });
    reconcile();
    void readBound(sessionId);
  };

  const scheduleRead = (sessionId: string): void => {
    const s = sessions.get(sessionId);
    if (!s) return;
    if (s.debounce) clearTimeout(s.debounce);
    s.debounce = setTimeout(() => {
      s.debounce = null;
      void readBound(sessionId);
    }, READ_DEBOUNCE_MS);
  };

  /** The newest reset-info, and the limit only when no turn started after it. */
  const replayState = (sessionId: string, lines: readonly string[]): LimitSignal[] => {
    let reset: LimitSignal | null = null;
    let limited: LimitSignal | null = null;
    let resumedAfter: LimitSignal | null = null;
    for (const line of lines) {
      for (const signal of rolloutSignals(sessionId, line, true, deps.now())) {
        if (signal.kind === 'reset-info') reset = signal;
        else if (signal.kind === 'limited') {
          limited = signal;
          resumedAfter = null;
        } else if (signal.kind === 'resumed') {
          if (limited) resumedAfter = signal;
          limited = null;
        }
      }
    }
    const out: LimitSignal[] = [];
    if (reset) out.push(reset);
    if (limited) out.push(limited);
    // A turn that started after the last limit still answers an episode the rules opened.
    else if (resumedAfter && deps.episodeOpen(sessionId)) out.push(resumedAfter);
    return out;
  };

  const sameIds = (a: LaunchIds, b: LaunchIds): boolean =>
    a.generation === b.generation && a.launchId === b.launchId;

  const readBound = async (sessionId: string): Promise<void> => {
    const s = sessions.get(sessionId);
    if (!s?.boundFile) return;
    if (s.reading) {
      s.readAgain = true;
      return;
    }
    s.reading = true;
    const file = s.boundFile;
    try {
      const offset = s.offset;
      const { data, size, identity } = await deps.fs.readFrom(file, offset);
      if (sessions.get(sessionId) !== s || s.boundFile !== file) return;
      const firstEnd = data.indexOf('\n');
      const firstMeta =
        offset === 0 && firstEnd >= 0 ? parseRolloutMeta(data.slice(0, firstEnd)) : null;
      const expectedMeta = metas.get(file);
      const valid =
        identity !== null &&
        identity.fileSize >= offset &&
        (offset === 0
          ? !!firstMeta && !firstMeta.isSubThread && firstMeta.id === expectedMeta?.id
          : !!s.identity && identity.dev === s.identity.dev && identity.ino === s.identity.ino);
      if (!s.postureRetired && !valid) {
        const wasLinked = s.linked;
        s.linked = false;
        s.identity = null;
        s.metaId = null;
        s.posture = { freshness: 'current', reading: null, lastKnown: null };
        if (wasLinked) deps.onPosture(sessionId, s.ids);
      } else if (!s.postureRetired && identity) {
        s.identity = { dev: identity.dev, ino: identity.ino };
        if (firstMeta) s.metaId = firstMeta.id;
      }
      s.offset = size;
      const lines = s.splitter.push(data);
      let postureChanged = false;
      if (valid && !s.postureRetired) {
        for (const line of lines) {
          const reading = rolloutPosture(line);
          if (!reading) continue;
          s.posture = {
            freshness: reading.status === 'known' ? 'current' : s.posture.freshness,
            reading,
            lastKnown: reading.status === 'known' ? reading : s.posture.lastKnown,
          };
          postureChanged = true;
        }
      }
      if (postureChanged && s.linked && sessions.get(sessionId) === s)
        deps.onPosture(sessionId, s.ids);
      if (!s.replayed) {
        // A late bind replays the whole file: only its END state is news. Replaying an old
        // task_started as `resumed` would close the rule-opened episode and open a duplicate
        // (blockers D2, review of d30afb9f B3).
        s.replayed = true;
        if (sessions.get(sessionId) === s)
          for (const signal of replayState(sessionId, lines)) deps.onSignal(signal);
      } else {
        for (const line of lines) {
          if (sessions.get(sessionId) !== s) break;
          const signals = rolloutSignals(sessionId, line, deps.episodeOpen(sessionId), deps.now());
          for (const signal of signals) deps.onSignal(signal);
          for (const action of rolloutActions(line)) deps.onAction(sessionId, action);
        }
      }
    } catch (err) {
      if (sessions.get(sessionId) === s && s.boundFile === file && !s.postureRetired) {
        s.posture = { ...s.posture, freshness: 'stale' };
        if (s.linked) deps.onPosture(sessionId, s.ids);
      }
      deps.log.warn('rollout read failed', { file, error: String(err) });
    } finally {
      s.reading = false;
      if (s.readAgain) {
        s.readAgain = false;
        void readBound(sessionId);
      }
    }
  };

  return {
    track(sessionId, s) {
      if (disposed) return;
      const prev = sessions.get(sessionId);
      if (prev?.debounce) clearTimeout(prev.debounce);
      sessions.set(sessionId, {
        ids: { ...s.ids },
        identity: null,
        metaId: null,
        linked: false,
        postureRetired: false,
        posture: { freshness: 'current', reading: null, lastKnown: null },
        cwd: s.cwd,
        launchAt: s.launchAt,
        boundFile: null,
        offset: 0,
        splitter: new LineSplitter(),
        reading: false,
        readAgain: false,
        replayed: false,
        feedReported: false,
        debounce: null,
      });
      reconcile();
      for (const dir of folders.keys()) void examineFolder(dir);
    },
    linkPosture(sessionId, ids, threadId) {
      const s = sessions.get(sessionId);
      if (
        !s ||
        !sameIds(s.ids, ids) ||
        s.postureRetired ||
        !s.identity ||
        s.metaId !== threadId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(threadId)
      )
        return false;
      s.linked = true;
      return true;
    },
    getPosture(sessionId, ids) {
      const s = sessions.get(sessionId);
      return s && s.linked && sameIds(s.ids, ids) ? { ...s.posture } : null;
    },
    unlinkPosture(sessionId, ids) {
      const s = sessions.get(sessionId);
      if (s && sameIds(s.ids, ids)) {
        s.linked = false;
        s.postureRetired = true;
        s.identity = null;
        s.metaId = null;
        s.posture = { freshness: 'current', reading: null, lastKnown: null };
      }
    },
    untrack(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return;
      if (s.debounce) clearTimeout(s.debounce);
      sessions.delete(sessionId);
      reconcile();
    },
    boundFile(sessionId) {
      return sessions.get(sessionId)?.boundFile ?? null;
    },
    dispose() {
      disposed = true;
      if (poll) clearInterval(poll);
      poll = null;
      for (const watch of folders.values()) watch.close();
      folders.clear();
      openWarned.clear();
      for (const s of sessions.values()) {
        if (s.debounce) clearTimeout(s.debounce);
      }
      sessions.clear();
    },
  };
}
