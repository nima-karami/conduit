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

export function createClaudeFeedGap<T>(deps: FeedGapDeps<T>): ClaudeFeedGap {
  const sessions = new Map<string, SessionGap<T>>();
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
  ): Promise<void> => {
    // A new file, or one that shrank, has no span to continue: its content so far is history.
    let baseline = s.transcriptPath !== path || size < s.offset;
    let start = baseline ? 0 : s.offset;
    let bytes: Buffer;
    try {
      // A file replaced at the same path by a longer one passes the size test; the bytes that
      // ended the last span tell it apart from a file that only grew.
      if (!baseline && s.fingerprint !== null) {
        const seen = await deps.readRange(path, s.offset - s.fingerprint.length, s.offset);
        baseline = !seen.equals(s.fingerprint);
        start = baseline ? 0 : s.offset;
      }
      bytes = await deps.readRange(path, start, size);
    } catch (err) {
      deps.warn('transcript unreadable; feed gap not checked', { sessionId, error: String(err) });
      return;
    }
    // A forgotten session's check must not write into its successor's span.
    if (sessions.get(sessionId) !== s) return;
    // A line cut at the Stop stays unread until its newline lands, so it is counted exactly once.
    const complete = bytes.lastIndexOf(NEWLINE) + 1;
    const ids = matchedToolUseIds(bytes.subarray(0, complete).toString('utf8'));
    const missing = ids.filter((id) => !s.received.has(id)).length;
    for (const id of ids) s.received.delete(id);
    if (!baseline && missing > 0) deps.record(sessionId, missing);
    s.transcriptPath = path;
    s.offset = start + complete;
    if (complete > 0) {
      const previousEnd = complete >= 2 ? bytes.lastIndexOf(NEWLINE, complete - 2) : -1;
      const fingerprintStart = Math.max(previousEnd + 1, complete - FINGERPRINT_BYTES);
      s.fingerprint = Buffer.from(bytes.subarray(fingerprintStart, complete));
    } else if (baseline) {
      s.fingerprint = null;
    }
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
      sessions.clear();
    },
  };
}
