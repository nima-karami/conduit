import {
  type Handle,
  HUMAN_HANDLE,
  type StoreLogRecord,
  type MessageRecord,
  type Priority,
  type RecipientState,
  type Result,
  type StoredMessage,
  type ThreadSummary,
  type ToolError,
  toolError,
} from './types';

export interface StoreIo {
  /** undefined = absent */
  readLog(): Promise<string | undefined>;
  /** One '\n'-terminated record, then fsync. */
  appendLog(line: string): Promise<void>;
  /** Atomic replace (torn-tail repair, retention compaction). */
  rewriteLog(text: string): Promise<void>;
  /** Idempotent. */
  writeBlob(sha256: string, data: Uint8Array): Promise<void>;
  readBlob(sha256: string): Promise<Uint8Array | undefined>;
  deleteBlob(sha256: string): Promise<void>;
  /** sha256 names */
  listBlobs(): Promise<string[]>;
  /** Removes blob writes a crash cut short (never visible under a sha256 name). */
  sweepPartialBlobs(): Promise<void>;
}
export interface InboxQuery {
  unreadOnly: boolean;
  threadId?: string;
  limit: number;
}
export interface RetentionResult {
  removed: number;
  tombstoned: number;
  blobsDeleted: number;
}
type RcptStatus = 'noticed' | 'read' | 'undelivered';
type BlobInput = ReadonlyArray<{ sha256: string; data: Uint8Array }>;
export interface MessageStore {
  load(): Promise<Result<void>>;
  available(): boolean;
  append(msg: MessageRecord, blobs: BlobInput): Promise<Result<void>>;
  setStatus(messageId: string, handle: Handle, status: RcptStatus): Promise<Result<void>>;
  allowMore(threadId: string): Promise<Result<void>>;
  get(messageId: string): StoredMessage | undefined;
  /** sentAt ascending */
  thread(threadId: string): StoredMessage[];
  /** lastAt descending */
  threads(): ThreadSummary[];
  inbox(handle: Handle, q: InboxQuery): { messages: StoredMessage[]; remaining: number };
  /** handle ∈ to, status queued|noticed, not expired */
  pending(handle: Handle): StoredMessage[];
  /** from ∪ to over the thread */
  participants(threadId: string): ReadonlySet<Handle>;
  /** Messages from ≠ you after the last you-post or allow, in log order. */
  agentCountSinceHuman(threadId: string): number;
  readBlob(sha256: string): Promise<Uint8Array | undefined>;
  enforceRetention(now: Date): Promise<Result<RetentionResult>>;
  onChange(cb: () => void): () => void;
}
export const RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface State {
  /** Insertion order = log order. */
  messages: Map<string, StoredMessage>;
  seqOf: Map<string, number>;
  /** Log position of the last you-post or allow per thread (loop guard, spec §2). */
  resetSeq: Map<string, number>;
  /** Kept so compaction can re-emit the allow at its log position. */
  lastAllow: Map<string, { seq: number; at: string }>;
  expiredAt: Map<string, string>;
  nextSeq: number;
}

const emptyState = (): State => ({
  messages: new Map(),
  seqOf: new Map(),
  resetSeq: new Map(),
  lastAllow: new Map(),
  expiredAt: new Map(),
  nextSeq: 0,
});

const OK: Result<void> = { ok: true, value: undefined };
const PRIORITY_RANK: Record<Priority, number> = { fyi: 0, normal: 1, urgent: 2 };

const isUnread = (r: RecipientState | undefined) =>
  r !== undefined && (r.status === 'queued' || r.status === 'noticed');

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const unavailable = (e: unknown): { ok: false; error: ToolError } => ({
  ok: false,
  error: toolError('store_unavailable', `message store unavailable: ${messageOf(e)}`),
});
const notFound = (what: string): Result<void> => ({
  ok: false,
  error: toolError('not_found', `${what} not found`),
});

/** The transition a recipient record makes, or undefined when it would be a no-op (monotonic). */
function nextRecipient(
  cur: RecipientState,
  status: RcptStatus,
  at: string,
): RecipientState | undefined {
  if (cur.status === 'read' || cur.status === 'expired') return undefined;
  if (status === 'read') return { ...cur, status: 'read', updatedAt: at };
  if (status === 'noticed') {
    if (cur.status === 'undelivered') return undefined;
    return { status: 'noticed', noticeCount: cur.noticeCount + 1, updatedAt: at };
  }
  if (cur.status === 'undelivered') return undefined;
  return { ...cur, status: 'undelivered', updatedAt: at };
}

function isLogRecord(v: unknown): v is StoreLogRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as { v?: unknown; t?: unknown };
  return r.v === 1 && (r.t === 'msg' || r.t === 'rcpt' || r.t === 'allow' || r.t === 'expire');
}

/**
 * Splits the log into records. A final line without '\n' or that isn't a record is a torn
 * write (plan ruling 2) and is reported so load can rewrite the log before any append.
 */
function parseLog(text: string): { records: StoreLogRecord[]; valid: string[]; torn: boolean } {
  const lines = text.split('\n');
  let torn = false;
  if (lines[lines.length - 1] === '') lines.pop();
  else torn = true;
  const records: StoreLogRecord[] = [];
  const valid: string[] = [];
  lines.forEach((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    if (isLogRecord(parsed)) {
      if (i === lines.length - 1 && torn) return;
      records.push(parsed);
      valid.push(line);
    } else if (i === lines.length - 1) torn = true;
  });
  return { records, valid, torn };
}

function applyRecord(s: State, rec: StoreLogRecord): void {
  const seq = s.nextSeq++;
  switch (rec.t) {
    case 'msg': {
      const m = rec.msg;
      if (s.messages.has(m.messageId)) return;
      // No prototype: a handle named like an Object member must not read as a recipient.
      const recipients: Record<Handle, RecipientState> = Object.create(null);
      for (const h of m.to)
        recipients[h] = { status: 'queued', noticeCount: 0, updatedAt: m.sentAt };
      s.messages.set(m.messageId, { ...m, recipients, expired: false });
      s.seqOf.set(m.messageId, seq);
      if (m.from === HUMAN_HANDLE) s.resetSeq.set(m.threadId, seq);
      return;
    }
    case 'rcpt': {
      const m = s.messages.get(rec.messageId);
      const cur = m?.recipients[rec.handle];
      if (!m || !cur) return;
      const next = nextRecipient(cur, rec.status, rec.at);
      if (next) m.recipients[rec.handle] = next;
      return;
    }
    case 'allow':
      s.resetSeq.set(rec.threadId, seq);
      s.lastAllow.set(rec.threadId, { seq, at: rec.at });
      return;
    case 'expire': {
      const m = s.messages.get(rec.messageId);
      if (!m || m.expired) return;
      m.expired = true;
      s.expiredAt.set(m.messageId, rec.at);
      m.body = '';
      for (const h of Object.keys(m.recipients)) {
        const r = m.recipients[h];
        if (r.status !== 'read') m.recipients[h] = { ...r, status: 'expired', updatedAt: rec.at };
      }
      return;
    }
  }
}

function liveBlobRefs(s: State): Map<string, number> {
  const refs = new Map<string, number>();
  for (const m of s.messages.values()) {
    if (m.expired) continue;
    for (const a of m.attachments) refs.set(a.sha256, (refs.get(a.sha256) ?? 0) + 1);
  }
  return refs;
}

const bySentAt = (a: StoredMessage, b: StoredMessage) =>
  a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0;

function recipientRecords(m: StoredMessage): StoreLogRecord[] {
  const out: StoreLogRecord[] = [];
  for (const [handle, r] of Object.entries(m.recipients)) {
    const base = { v: 1, t: 'rcpt', messageId: m.messageId, handle, at: r.updatedAt } as const;
    for (let i = 0; i < r.noticeCount; i++) out.push({ ...base, status: 'noticed' });
    if (r.status === 'read' || r.status === 'undelivered') out.push({ ...base, status: r.status });
  }
  return out;
}

/**
 * The compacted log after age retention (plan ruling 7: age only), or null when nothing ages
 * out. Tombstones are written with an empty body so the text leaves the disk too.
 */
function compact(
  s: State,
  now: number,
  maxAgeMs: number,
): { records: StoreLogRecord[]; removed: number; tombstoned: number } | null {
  const isOld = (iso: string) => now - Date.parse(iso) > maxAgeMs;
  const drop = new Set<string>();
  const expire = new Set<string>();
  for (const m of s.messages.values()) {
    if (m.expired) {
      const since = s.expiredAt.get(m.messageId);
      if (since !== undefined && isOld(since)) drop.add(m.messageId);
    } else if (isOld(m.sentAt)) {
      if (Object.values(m.recipients).every((r) => r.status === 'read')) drop.add(m.messageId);
      else expire.add(m.messageId);
    }
  }
  if (drop.size === 0 && expire.size === 0) return null;

  const at = new Date(now).toISOString();
  const keptThreads = new Set<string>();
  const entries: Array<{ seq: number; records: StoreLogRecord[] }> = [];
  for (const m of s.messages.values()) {
    if (drop.has(m.messageId)) continue;
    keptThreads.add(m.threadId);
    const { recipients: _r, expired: _e, ...rec } = m;
    const gone = m.expired || expire.has(m.messageId);
    const records: StoreLogRecord[] = [
      { v: 1, t: 'msg', msg: gone ? { ...rec, body: '' } : rec },
      ...recipientRecords(m),
    ];
    if (gone) {
      const expiredAt = s.expiredAt.get(m.messageId) ?? at;
      records.push({ v: 1, t: 'expire', messageId: m.messageId, at: expiredAt });
    }
    entries.push({ seq: s.seqOf.get(m.messageId) ?? 0, records });
  }
  // The loop guard counts from the thread's last reset; when that reset was a you-post being
  // dropped here, an allow at its position keeps the count the human already reset.
  const messageAtSeq = new Map<number, StoredMessage>();
  for (const m of s.messages.values()) {
    const q = s.seqOf.get(m.messageId);
    if (q !== undefined) messageAtSeq.set(q, m);
  }
  for (const [threadId, seq] of s.resetSeq) {
    if (!keptThreads.has(threadId)) continue;
    const youPost = messageAtSeq.get(seq);
    if (youPost && !drop.has(youPost.messageId)) continue;
    const allow = s.lastAllow.get(threadId);
    const resetAt = allow?.seq === seq ? allow.at : (youPost?.sentAt ?? at);
    entries.push({ seq, records: [{ v: 1, t: 'allow', threadId, at: resetAt }] });
  }
  entries.sort((a, b) => a.seq - b.seq);
  return {
    records: entries.flatMap((e) => e.records),
    removed: drop.size,
    tombstoned: expire.size,
  };
}

const line = (rec: StoreLogRecord) => `${JSON.stringify(rec)}\n`;

export function createMessageStore(io: StoreIo, opts?: { maxAgeMs?: number }): MessageStore {
  const maxAgeMs = opts?.maxAgeMs ?? RETENTION_MAX_AGE_MS;
  let state = emptyState();
  let isAvailable = false;
  const listeners = new Set<() => void>();
  let chain: Promise<unknown> = Promise.resolve();

  // Every StoreIo call runs on this one chain (plan ruling 2); it survives a rejected step.
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const emit = () => {
    for (const cb of listeners) cb();
  };

  async function write(rec: StoreLogRecord): Promise<Result<void>> {
    try {
      await io.appendLog(line(rec));
    } catch (e) {
      return unavailable(e);
    }
    applyRecord(state, rec);
    emit();
    return OK;
  }

  const all = () => [...state.messages.values()];

  return {
    load: () =>
      enqueue(async () => {
        try {
          const { records, valid, torn } = parseLog((await io.readLog()) ?? '');
          if (torn) await io.rewriteLog(valid.map((l) => `${l}\n`).join(''));
          const next = emptyState();
          for (const rec of records) applyRecord(next, rec);
          const refs = liveBlobRefs(next);
          for (const sha of await io.listBlobs()) if (!refs.has(sha)) await io.deleteBlob(sha);
          await io.sweepPartialBlobs();
          state = next;
          isAvailable = true;
        } catch (e) {
          isAvailable = false;
          return unavailable(e);
        }
        emit();
        return OK;
      }),

    available: () => isAvailable,

    append: (msg, blobs) =>
      enqueue(async () => {
        if (!isAvailable) return unavailable('not loaded');
        try {
          for (const b of blobs) await io.writeBlob(b.sha256, b.data);
        } catch (e) {
          return unavailable(e);
        }
        return write({ v: 1, t: 'msg', msg });
      }),

    setStatus: (messageId, handle, status) =>
      enqueue(async () => {
        if (!isAvailable) return unavailable('not loaded');
        const cur = state.messages.get(messageId)?.recipients[handle];
        if (!cur) return notFound(`recipient ${handle} of ${messageId}`);
        const at = new Date().toISOString();
        if (!nextRecipient(cur, status, at)) return OK;
        return write({ v: 1, t: 'rcpt', messageId, handle, status, at });
      }),

    allowMore: (threadId) =>
      enqueue(async () => {
        if (!isAvailable) return unavailable('not loaded');
        if (!all().some((m) => m.threadId === threadId)) return notFound(`thread ${threadId}`);
        return write({ v: 1, t: 'allow', threadId, at: new Date().toISOString() });
      }),

    get: (id) => state.messages.get(id),

    thread: (threadId) =>
      all()
        .filter((m) => m.threadId === threadId)
        .sort(bySentAt),

    threads() {
      const groups = new Map<string, StoredMessage[]>();
      for (const m of all()) {
        const g = groups.get(m.threadId);
        if (g) g.push(m);
        else groups.set(m.threadId, [m]);
      }
      const out: ThreadSummary[] = [];
      for (const [threadId, group] of groups) {
        const ms = group.sort(bySentAt);
        const participants = new Set<Handle>();
        const unreadFor = new Set<Handle>();
        let topPriority: Priority = 'fyi';
        for (const m of ms) {
          participants.add(m.from);
          for (const h of m.to) {
            participants.add(h);
            if (!m.expired && isUnread(m.recipients[h])) unreadFor.add(h);
          }
          if (PRIORITY_RANK[m.priority] > PRIORITY_RANK[topPriority]) topPriority = m.priority;
        }
        out.push({
          threadId,
          subject: ms.find((m) => m.subject !== '')?.subject ?? '',
          firstLine: ms[0].body.split('\n')[0],
          participants: [...participants],
          topPriority,
          lastAt: ms[ms.length - 1].sentAt,
          messageCount: ms.length,
          unreadFor: [...unreadFor],
        });
      }
      return out.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
    },

    inbox(handle, q) {
      const matches = all()
        .filter((m) => q.threadId === undefined || m.threadId === q.threadId)
        .filter((m) =>
          q.unreadOnly
            ? !m.expired && isUnread(m.recipients[handle])
            : Object.hasOwn(m.recipients, handle) || m.from === handle,
        )
        .sort(bySentAt);
      const messages = matches.slice(0, Math.max(0, q.limit));
      return { messages, remaining: matches.length - messages.length };
    },

    pending: (handle) =>
      all()
        .filter((m) => !m.expired && isUnread(m.recipients[handle]))
        .sort(bySentAt),

    participants(threadId) {
      const out = new Set<Handle>();
      for (const m of all()) {
        if (m.threadId !== threadId) continue;
        out.add(m.from);
        for (const h of m.to) out.add(h);
      }
      return out;
    },

    agentCountSinceHuman(threadId) {
      const since = state.resetSeq.get(threadId) ?? -1;
      let n = 0;
      for (const m of all()) {
        if (m.threadId !== threadId || m.from === HUMAN_HANDLE) continue;
        if ((state.seqOf.get(m.messageId) ?? -1) > since) n += 1;
      }
      return n;
    },

    readBlob: (sha256) => enqueue(() => io.readBlob(sha256)),

    enforceRetention: (now) =>
      enqueue(async (): Promise<Result<RetentionResult>> => {
        if (!isAvailable) return unavailable('not loaded');
        const plan = compact(state, now.getTime(), maxAgeMs);
        let blobsDeleted = 0;
        try {
          let next = state;
          if (plan) {
            await io.rewriteLog(plan.records.map(line).join(''));
            next = emptyState();
            for (const rec of plan.records) applyRecord(next, rec);
            state = next;
          }
          const refs = liveBlobRefs(next);
          for (const sha of await io.listBlobs()) {
            if (refs.has(sha)) continue;
            await io.deleteBlob(sha);
            blobsDeleted += 1;
          }
        } catch (e) {
          return unavailable(e);
        }
        if (plan) emit();
        return {
          ok: true,
          value: { removed: plan?.removed ?? 0, tombstoned: plan?.tombstoned ?? 0, blobsDeleted },
        };
      }),

    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
