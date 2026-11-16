import { matchedToolUseIds } from '../../src/claude-transcript-tools';

// see plan T4.1b: a Stop settles async PostToolUse posts that land just after it
export const FEED_GAP_SETTLE_MS = 3_000;

interface FeedGapDeps<T> {
  readRange(path: string, start: number, end: number): Promise<Buffer>;
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
  // A test seam: pruning of received posts would otherwise show only as memory use.
  receivedCount(sessionId: string): number;
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
  offset: number;
  fingerprint: Buffer | null;
  received: Set<string>;
  pending: Pending<T> | null;
}

const NEWLINE = 0x0a;
// a Claude line can be megabytes of tool output; this tail is enough to tell two files apart
const FINGERPRINT_BYTES = 256;
// Posts for calls that never reach the main transcript would otherwise pile up for the
// session's whole life.
const RECEIVED_CAP = 1_000;
// see plan m4: a transcript can be hundreds of MB, and a baseline must not read all of it
const BASELINE_TAIL_BYTES = 64 * 1024;
// a span this long is not one turn's feed, so it is taken as a baseline rather than counted
const MAX_SPAN_BYTES = 32 * 1024 * 1024;
// see plan review B: a check that never returns (a stuck filesystem) must not hold the queue
const FEED_GAP_CHECK_TIMEOUT_MS = 10_000;

export function createClaudeFeedGap<T>(deps: FeedGapDeps<T>): ClaudeFeedGap {
  const sessions = new Map<string, SessionGap<T>>();
  const activeTimeouts = new Set<T>();
  // One chain: two checks reading and advancing the same span would interleave.
  let queue: Promise<void> = Promise.resolve();

  const stateOf = (sessionId: string): SessionGap<T> => {
    let s = sessions.get(sessionId);
    if (!s) {
      s = {
        transcriptPath: null,
        offset: 0,
        fingerprint: null,
        received: new Set(),
        pending: null,
      };
      sessions.set(sessionId, s);
    }
    return s;
  };

  const check = async (
    sessionId: string,
    s: SessionGap<T>,
    path: string,
    size: number,
    guard: { abandoned: boolean },
  ): Promise<void> => {
    try {
      // A new file, or one that shrank, has no span to continue: its content so far is history.
      let baseline =
        s.transcriptPath !== path || size < s.offset || size - s.offset > MAX_SPAN_BYTES;
      let start: number;
      let bytes: Buffer;
      try {
        // A file replaced at the same path by a longer one passes the size test; the bytes that
        // ended the last span tell it apart from a file that only grew.
        if (!baseline && s.fingerprint !== null) {
          const seen = await deps.readRange(path, s.offset - s.fingerprint.length, s.offset);
          baseline = !seen.equals(s.fingerprint);
        }
        start = baseline ? Math.max(0, size - BASELINE_TAIL_BYTES) : s.offset;
        bytes = await deps.readRange(path, start, size);
      } catch (err) {
        deps.warn('transcript unreadable; feed gap not checked', {
          sessionId,
          error: String(err),
        });
        return;
      }
      // A forgotten session's check must not write into its successor's span, and a timed-out
      // check must not write behind the queue's back.
      if (sessions.get(sessionId) !== s || guard.abandoned) return;
      // A line cut at the Stop stays unread until its newline lands, so it is counted exactly once.
      const complete = bytes.lastIndexOf(NEWLINE) + 1;
      const ids = matchedToolUseIds(bytes.subarray(0, complete).toString('utf8'));
      const missing = ids.filter((id) => !s.received.has(id)).length;
      if (!baseline && missing > 0) deps.record(sessionId, missing);
      for (const id of ids) s.received.delete(id);
      s.transcriptPath = path;
      s.offset = start + complete;
      if (complete > 0) {
        const previousEnd = complete >= 2 ? bytes.lastIndexOf(NEWLINE, complete - 2) : -1;
        const fingerprintStart = Math.max(previousEnd + 1, complete - FINGERPRINT_BYTES);
        s.fingerprint = Buffer.from(bytes.subarray(fingerprintStart, complete));
      } else if (baseline) {
        s.fingerprint = null;
      }
    } catch (err) {
      deps.warn('feed gap check failed; feed gap not checked', { sessionId, error: String(err) });
    }
  };

  const run = (sessionId: string, s: SessionGap<T>, path: string, size: number): Promise<void> => {
    const guard = { abandoned: false };
    const timeout: { handle: T | null } = { handle: null };
    const timedOut = new Promise<void>((resolve) => {
      timeout.handle = deps.setTimer(() => {
        guard.abandoned = true;
        deps.warn('feed gap check timed out; later checks continue', { sessionId });
        resolve();
      }, FEED_GAP_CHECK_TIMEOUT_MS);
    });
    if (timeout.handle !== null) activeTimeouts.add(timeout.handle);
    return Promise.race([check(sessionId, s, path, size, guard), timedOut]).finally(() => {
      if (timeout.handle !== null) {
        activeTimeouts.delete(timeout.handle);
        deps.clearTimer(timeout.handle);
      }
    });
  };

  const fire = (sessionId: string, s: SessionGap<T>): void => {
    const pending = s.pending;
    if (pending === null) return;
    s.pending = null;
    queue = queue
      .then(() => run(sessionId, s, pending.path, pending.size))
      .catch((err: unknown) => {
        deps.warn('feed gap check rejected; later checks continue', {
          sessionId,
          error: String(err),
        });
      });
  };

  return {
    post(sessionId, fromSubagent, toolUseId) {
      // A subagent's calls live in subagents/*.jsonl, never in the main transcript this checks.
      if (fromSubagent || toolUseId === null) return;
      const { received } = stateOf(sessionId);
      received.add(toolUseId);
      if (received.size > RECEIVED_CAP) {
        const oldest = received.values().next();
        if (!oldest.done) received.delete(oldest.value);
      }
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
    receivedCount(sessionId) {
      return sessions.get(sessionId)?.received.size ?? 0;
    },
    settled: () => queue,
    dispose() {
      for (const s of sessions.values()) if (s.pending !== null) deps.clearTimer(s.pending.timer);
      for (const handle of activeTimeouts) deps.clearTimer(handle);
      activeTimeouts.clear();
      sessions.clear();
    },
  };
}
