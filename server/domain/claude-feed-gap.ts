import { countMatchedToolUses } from '../../src/claude-transcript-tools';

// see plan T4.1b: a Stop settles async PostToolUse posts that land just after it
export const FEED_GAP_SETTLE_MS = 3_000;

interface FeedGapDeps<T> {
  readFile(path: string): Promise<string>;
  setTimer(fn: () => void, ms: number): T;
  clearTimer(handle: T): void;
  record(sessionId: string, gap: number): void;
  warn(msg: string, data?: object): void;
}

export interface ClaudeFeedGap {
  post(sessionId: string, fromSubagent: boolean): void;
  stop(sessionId: string, transcriptPath: string): void;
  settled(): Promise<void>;
  dispose(): void;
}

interface SessionGap<T> {
  transcriptPath: string | null;
  lastUuid: string | null;
  posts: number;
  timer: T | null;
}

export function createClaudeFeedGap<T>(deps: FeedGapDeps<T>): ClaudeFeedGap {
  const sessions = new Map<string, SessionGap<T>>();
  // One chain: two checks reading and advancing the same span would interleave.
  let queue: Promise<void> = Promise.resolve();

  const stateOf = (sessionId: string): SessionGap<T> => {
    let s = sessions.get(sessionId);
    if (!s) {
      s = { transcriptPath: null, lastUuid: null, posts: 0, timer: null };
      sessions.set(sessionId, s);
    }
    return s;
  };

  const check = async (sessionId: string, s: SessionGap<T>, path: string): Promise<void> => {
    const seen = s.posts;
    let text: string;
    try {
      text = await deps.readFile(path);
    } catch (err) {
      deps.warn('transcript unreadable; feed gap not checked', { sessionId, error: String(err) });
      return;
    }
    // A new transcript (resume or fork) starts a span: its earlier calls are history, not a gap.
    const fresh = s.transcriptPath !== path;
    const { count, lastUuid } = countMatchedToolUses(text, fresh ? null : s.lastUuid);
    s.posts -= seen;
    if (!fresh && count - seen > 0) deps.record(sessionId, count - seen);
    s.transcriptPath = path;
    s.lastUuid = lastUuid;
  };

  return {
    post(sessionId, fromSubagent) {
      // A subagent's calls live in subagents/*.jsonl, never in the main transcript this checks.
      if (!fromSubagent) stateOf(sessionId).posts += 1;
    },
    stop(sessionId, transcriptPath) {
      const s = stateOf(sessionId);
      if (s.timer !== null) deps.clearTimer(s.timer);
      s.timer = deps.setTimer(() => {
        s.timer = null;
        queue = queue.then(() => check(sessionId, s, transcriptPath));
      }, FEED_GAP_SETTLE_MS);
    },
    settled: () => queue,
    dispose() {
      for (const s of sessions.values()) {
        if (s.timer !== null) deps.clearTimer(s.timer);
        s.timer = null;
      }
    },
  };
}
