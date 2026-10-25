import { describe, expect, it } from 'vitest';
import {
  createMessageStore,
  RETENTION_MAX_AGE_MS,
  type StoreIo,
} from '../../src/conduit-mcp/store';
import type { MessageRecord } from '../../src/conduit-mcp/types';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const MAX_AGE = 10 * DAY;

function memIo(delayMs = 0) {
  const state = { log: undefined as string | undefined, blobs: new Map<string, Uint8Array>() };
  let active = 0;
  let maxActive = 0;
  const op =
    <A extends unknown[], R>(fn: (...a: A) => R) =>
    async (...a: A): Promise<R> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        return fn(...a);
      } finally {
        active -= 1;
      }
    };
  const io: StoreIo = {
    readLog: op(() => state.log),
    appendLog: op((l: string) => {
      state.log = (state.log ?? '') + l;
    }),
    rewriteLog: op((t: string) => {
      state.log = t;
    }),
    writeBlob: op((s: string, d: Uint8Array) => {
      state.blobs.set(s, d);
    }),
    readBlob: op((s: string) => state.blobs.get(s)),
    deleteBlob: op((s: string) => {
      state.blobs.delete(s);
    }),
    listBlobs: op(() => [...state.blobs.keys()]),
    sweepPartialBlobs: op(() => {}),
  };
  return { io, state, maxActive: () => maxActive };
}

let seq = 0;
function msg(at: number, over: Partial<MessageRecord> = {}): MessageRecord {
  seq += 1;
  return {
    messageId: `m_${seq}`,
    threadId: 't_1',
    from: 'claude-1',
    to: ['codex-2'],
    subject: 's',
    kind: 'inform',
    priority: 'normal',
    sentAt: new Date(at).toISOString(),
    body: `secret body ${seq}`,
    attachments: [],
    ...over,
  };
}
const withBlob = (sha: string) => ({
  attachments: [{ attachmentId: `a_${sha}`, name: 'f', mime: 'text/plain', bytes: 1, sha256: sha }],
});
const blob = (sha: string) => [{ sha256: sha, data: new Uint8Array([1]) }];

async function store(m = memIo()) {
  const s = createMessageStore(m.io, { maxAgeMs: MAX_AGE });
  await s.load();
  return { s, m };
}

describe('enforceRetention (age only)', () => {
  it('defaults to 30 days', () => {
    expect(RETENTION_MAX_AGE_MS).toBe(30 * DAY);
  });

  it('old fully-read message removed and its blob deleted at refcount 0', async () => {
    const { s, m } = await store();
    const old = msg(T0, withBlob('b1'));
    const fresh = msg(T0 + MAX_AGE);
    await s.append(old, blob('b1'));
    await s.append(fresh, []);
    await s.setStatus(old.messageId, 'codex-2', 'read');
    const r = await s.enforceRetention(new Date(T0 + MAX_AGE + 1));
    expect(r).toEqual({ ok: true, value: { removed: 1, tombstoned: 0, blobsDeleted: 1 } });
    expect(s.get(old.messageId)).toBeUndefined();
    expect(s.get(fresh.messageId)).toBeDefined();
    expect(m.state.blobs.has('b1')).toBe(false);
  });

  it('old unread message becomes an expired tombstone', async () => {
    const { s, m } = await store();
    const old = msg(T0, { ...withBlob('b1'), to: ['codex-2', 'claude-3'] });
    await s.append(old, blob('b1'));
    await s.setStatus(old.messageId, 'claude-3', 'read');
    const r = await s.enforceRetention(new Date(T0 + MAX_AGE + 1));
    expect(r).toEqual({ ok: true, value: { removed: 0, tombstoned: 1, blobsDeleted: 1 } });
    const t = s.get(old.messageId);
    expect(t?.expired).toBe(true);
    expect(t?.body).toBe('');
    expect(t?.recipients['codex-2'].status).toBe('expired');
    expect(t?.recipients['claude-3'].status).toBe('read');
    expect(s.pending('codex-2')).toEqual([]);
    expect(m.state.log).not.toContain('secret body');
  });

  it('shared blob survives while another message refs it', async () => {
    const { s, m } = await store();
    const old = msg(T0, withBlob('shared'));
    const fresh = msg(T0 + MAX_AGE, withBlob('shared'));
    await s.append(old, blob('shared'));
    await s.append(fresh, blob('shared'));
    await s.setStatus(old.messageId, 'codex-2', 'read');
    const r = await s.enforceRetention(new Date(T0 + MAX_AGE + 1));
    expect(r).toMatchObject({ ok: true, value: { removed: 1, blobsDeleted: 0 } });
    expect(m.state.blobs.has('shared')).toBe(true);
  });

  it('a tombstone older than maxAgeMs past expiry is dropped', async () => {
    const { s } = await store();
    const old = msg(T0);
    await s.append(old, []);
    await s.enforceRetention(new Date(T0 + MAX_AGE + 1));
    expect(s.get(old.messageId)?.expired).toBe(true);
    const keep = await s.enforceRetention(new Date(T0 + 2 * MAX_AGE));
    expect(keep).toMatchObject({ ok: true, value: { removed: 0, tombstoned: 0 } });
    expect(s.get(old.messageId)).toBeDefined();
    const r = await s.enforceRetention(new Date(T0 + 2 * MAX_AGE + 2));
    expect(r).toMatchObject({ ok: true, value: { removed: 1, tombstoned: 0 } });
    expect(s.get(old.messageId)).toBeUndefined();
  });

  it('retention runs through the IO queue', async () => {
    const { s, m } = await store(memIo(2));
    await s.append(msg(T0), []);
    await Promise.all([
      s.enforceRetention(new Date(T0 + MAX_AGE + 1)),
      s.append(msg(T0 + MAX_AGE), blob('b2')),
      s.enforceRetention(new Date(T0 + MAX_AGE + 2)),
    ]);
    expect(m.maxActive()).toBe(1);
  });

  it('compaction survives reload', async () => {
    const { s, m } = await store();
    const old = msg(T0, { to: ['codex-2', 'claude-3'] });
    const readOld = msg(T0);
    const fresh = msg(T0 + MAX_AGE, withBlob('b3'));
    await s.append(old, []);
    await s.append(readOld, []);
    await s.append(fresh, blob('b3'));
    await s.setStatus(old.messageId, 'claude-3', 'noticed');
    await s.setStatus(old.messageId, 'claude-3', 'noticed');
    await s.setStatus(readOld.messageId, 'codex-2', 'read');
    await s.setStatus(fresh.messageId, 'codex-2', 'noticed');
    await s.allowMore('t_1');
    await s.append(msg(T0 + MAX_AGE), []);
    const before = s.agentCountSinceHuman('t_1');
    await s.enforceRetention(new Date(T0 + MAX_AGE + 1));

    const again = createMessageStore(m.io, { maxAgeMs: MAX_AGE });
    await again.load();
    expect(again.threads()).toEqual(s.threads());
    expect(again.thread('t_1')).toEqual(s.thread('t_1'));
    expect(again.get(old.messageId)?.recipients['claude-3']).toMatchObject({
      status: 'expired',
      noticeCount: 2,
    });
    expect(again.get(fresh.messageId)?.recipients['codex-2']).toMatchObject({
      status: 'noticed',
      noticeCount: 1,
    });
    expect(again.agentCountSinceHuman('t_1')).toBe(before);
    expect(before).toBe(1);
    expect(await again.readBlob('b3')).toEqual(new Uint8Array([1]));
  });

  it('dropping a read you-post keeps its loop-guard reset', async () => {
    const { s, m } = await store();
    const unreadAgent = msg(T0);
    const youPost = msg(T0 + 1, { from: 'you', to: ['codex-2'] });
    await s.append(unreadAgent, []);
    await s.append(youPost, []);
    await s.setStatus(youPost.messageId, 'codex-2', 'read');
    await s.append(msg(T0 + MAX_AGE), []);
    expect(s.agentCountSinceHuman('t_1')).toBe(1);

    const r = await s.enforceRetention(new Date(T0 + MAX_AGE + 2));
    expect(r).toMatchObject({ ok: true, value: { removed: 1, tombstoned: 1 } });
    expect(s.get(youPost.messageId)).toBeUndefined();
    expect(s.get(unreadAgent.messageId)?.expired).toBe(true);
    expect(s.agentCountSinceHuman('t_1')).toBe(1);

    const again = createMessageStore(m.io, { maxAgeMs: MAX_AGE });
    await again.load();
    expect(again.agentCountSinceHuman('t_1')).toBe(1);
  });

  it('nothing old → no rewrite and no change', async () => {
    const { s, m } = await store();
    await s.append(msg(T0), []);
    const log = m.state.log;
    expect(await s.enforceRetention(new Date(T0 + 1))).toEqual({
      ok: true,
      value: { removed: 0, tombstoned: 0, blobsDeleted: 0 },
    });
    expect(m.state.log).toBe(log);
  });
});
