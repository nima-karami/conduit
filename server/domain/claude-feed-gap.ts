import { matchedToolUseIds } from '../../src/claude-transcript-tools';

// see plan T4.1b: a Stop settles async PostToolUse posts that land just after it
export const FEED_GAP_SETTLE_MS = 3_000;

interface FeedGapDeps<T> {
  readFile(path: string): Promise<Buffer>;
  sizeOf(path: string): number;
  setTimer(fn: () => void, ms: number): T;
  clearTimer(handle: T): void;
  record(sessionId: string, gap: number): void;
  warn(msg: string, data?: object): void;
}

export interface ClaudeFeedGap {
  post(sessionId: string, fromSubagent: boolean, toolUseId: string | null): void;
  stop(sessionId: string, transcriptPath: string): void;
  forget(sessionId: string): void;
  settled(): Promise<void>;
  dispose(): void;
}

interface Pending<T> {
  path: string;
  size: number;
  timer: T;
}

interface SessionGap<T> {
  transcriptPath: string | null;
  lastUuid: string | null;
  received: Set<string>;
  pending: Pending<T> | null;
}

export function createClaudeFeedGap<T>(deps: FeedGapDeps<T>): ClaudeFeedGap {
  const sessions = new Map<string, SessionGap<T>>();
  // One chain: two checks reading and advancing the same span would interleave.
  let queue: Promise<void> = Promise.resolve();

  const stateOf = (sessionId: string): SessionGap<T> => {
    let s = sessions.get(sessionId);
    if (!s) {
      s = { transcriptPath: null, lastUuid: null, received: new Set(), pending: null };
      sessions.set(sessionId, s);
    }
    return s;
  };

  const check = async (
    sessionId: string,
    s: SessionGap<T>,
    path: string,
    size: number,
  ): Promise<void> => {
    let bytes: Buffer;
    try {
      bytes = await deps.readFile(path);
    } catch (err) {
      deps.warn('transcript unreadable; feed gap not checked', { sessionId, error: String(err) });
      return;
    }
    // A forgotten session's check must not write into its successor's span.
    if (sessions.get(sessionId) !== s) return;
    // Only the bytes that existed at Stop belong to this span; later lines are the next turn's.
    const text = bytes.subarray(0, size).toString('utf8');
    const fresh = s.transcriptPath !== path;
    const scan = matchedToolUseIds(text, fresh ? null : s.lastUuid);
    if (fresh) {
      s.transcriptPath = path;
      s.lastUuid = scan.lastUuid;
      return;
    }
    const missing = scan.ids.filter((id) => !s.received.has(id)).length;
    for (const id of scan.ids) s.received.delete(id);
    if (missing > 0) deps.record(sessionId, missing);
    s.transcriptPath = path;
    s.lastUuid = scan.lastUuid;
  };

  const fire = (sessionId: string, s: SessionGap<T>): void => {
    const pending = s.pending;
    if (pending === null) return;
    s.pending = null;
    queue = queue.then(() => check(sessionId, s, pending.path, pending.size));
  };

  return {
    post(sessionId, fromSubagent, toolUseId) {
      // A subagent's calls live in subagents/*.jsonl, never in the main transcript this checks.
      if (fromSubagent || toolUseId === null) return;
      stateOf(sessionId).received.add(toolUseId);
    },
    stop(sessionId, transcriptPath) {
      const s = stateOf(sessionId);
      let size: number;
      try {
        size = deps.sizeOf(transcriptPath);
      } catch (err) {
        deps.warn('transcript not statable at Stop; feed gap not checked', {
          sessionId,
          error: String(err),
        });
        return;
      }
      if (s.pending !== null) deps.clearTimer(s.pending.timer);
      const timer = deps.setTimer(() => fire(sessionId, s), FEED_GAP_SETTLE_MS);
      s.pending = { path: transcriptPath, size, timer };
    },
    forget(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return;
      if (s.pending !== null) deps.clearTimer(s.pending.timer);
      sessions.delete(sessionId);
    },
    settled: () => queue,
    dispose() {
      for (const s of sessions.values()) if (s.pending !== null) deps.clearTimer(s.pending.timer);
      sessions.clear();
    },
  };
}
