import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageStore, type StoreIo } from '../../src/conduit-mcp/store';
import { createFsStoreIo } from '../../src/conduit-mcp/store-fs';
import type { MessageRecord } from '../../src/conduit-mcp/types';

/** In-memory StoreIo that records call order and the peak number of overlapping calls. */
function memIo(opts: { delayMs?: number } = {}) {
  const state = { log: undefined as string | undefined, blobs: new Map<string, Uint8Array>() };
  const calls: string[] = [];
  const failNext = new Set<string>();
  let active = 0;
  let maxActive = 0;
  const op =
    <A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
    async (...a: A): Promise<R> => {
      calls.push(name);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
        if (failNext.delete(name)) throw new Error(`${name} failed`);
        return fn(...a);
      } finally {
        active -= 1;
      }
    };
  const io: StoreIo = {
    readLog: op('readLog', () => state.log),
    appendLog: op('appendLog', (line: string) => {
      state.log = (state.log ?? '') + line;
    }),
    rewriteLog: op('rewriteLog', (text: string) => {
      state.log = text;
    }),
    writeBlob: op('writeBlob', (sha: string, data: Uint8Array) => {
      state.blobs.set(sha, data);
    }),
    readBlob: op('readBlob', (sha: string) => state.blobs.get(sha)),
    deleteBlob: op('deleteBlob', (sha: string) => {
      state.blobs.delete(sha);
    }),
    listBlobs: op('listBlobs', () => [...state.blobs.keys()]),
    sweepPartialBlobs: op('sweepPartialBlobs', () => {}),
  };
  return {
    io,
    state,
    calls,
    failNext,
    maxActive: () => maxActive,
  };
}

let seq = 0;
function msg(over: Partial<MessageRecord> = {}): MessageRecord {
  seq += 1;
  return {
    messageId: `m_${seq}`,
    threadId: 't_1',
    from: 'claude-1',
    to: ['codex-2'],
    subject: 'spec',
    kind: 'request',
    priority: 'normal',
    sentAt: new Date(Date.UTC(2026, 9, 25, 10, 0, seq)).toISOString(),
    body: `body ${seq}\nmore`,
    attachments: [],
    ...over,
  };
}

const blob = (sha: string) => ({ sha256: sha, data: new Uint8Array([1, 2, 3]) });
const att = (sha: string) => ({
  attachmentId: `a_${sha}`,
  name: 'f.txt',
  mime: 'text/plain',
  bytes: 3,
  sha256: sha,
});

async function loaded(m = memIo()) {
  const store = createMessageStore(m.io);
  expect(await store.load()).toEqual({ ok: true, value: undefined });
  return { store, m };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('createMessageStore', () => {
  it('append then reload restores messages and states', async () => {
    const { store, m } = await loaded();
    const a = msg();
    expect((await store.append(a, [])).ok).toBe(true);
    await store.setStatus(a.messageId, 'codex-2', 'noticed');
    await store.setStatus(a.messageId, 'codex-2', 'noticed');
    await store.setStatus(a.messageId, 'codex-2', 'read');
    const fresh = createMessageStore(m.io);
    await fresh.load();
    expect(fresh.get(a.messageId)?.recipients['codex-2']).toMatchObject({
      status: 'read',
      noticeCount: 2,
    });
    expect(fresh.get(a.messageId)?.body).toBe(a.body);
  });

  it('a handle named like an Object.prototype member is no recipient', async () => {
    const { store } = await loaded();
    const a = msg();
    await store.append(a, []);
    for (const h of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(store.inbox(h, { unreadOnly: false, limit: 50 }).messages).toEqual([]);
      expect(store.inbox(h, { unreadOnly: true, limit: 50 }).messages).toEqual([]);
      expect(store.pending(h)).toEqual([]);
      expect(store.get(a.messageId)?.recipients[h]).toBeUndefined();
      expect((await store.setStatus(a.messageId, h, 'read')).ok).toBe(false);
    }
  });

  it('torn tail is truncated by rewriteLog before the first append', async () => {
    const m = memIo();
    const first = msg();
    m.state.log = `${JSON.stringify({ v: 1, t: 'msg', msg: first })}\n{"v":1,"t":"msg","ms`;
    const { store } = await loaded(m);
    await store.append(msg(), []);
    const lines = (m.state.log ?? '').split('\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(m.calls.indexOf('rewriteLog')).toBeGreaterThan(-1);
    expect(m.calls.indexOf('rewriteLog')).toBeLessThan(m.calls.indexOf('appendLog'));
  });

  it('a complete but unparsable final line is also treated as torn', async () => {
    const m = memIo();
    m.state.log = `${JSON.stringify({ v: 1, t: 'msg', msg: msg() })}\nnot json\n`;
    await loaded(m);
    expect(m.calls).toContain('rewriteLog');
    expect((m.state.log ?? '').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('IO calls never overlap', async () => {
    const { store, m } = await loaded(memIo({ delayMs: 2 }));
    const a = msg();
    await store.append(a, []);
    await Promise.all([
      store.append(msg(), [blob('b1')]),
      store.setStatus(a.messageId, 'codex-2', 'noticed'),
      store.allowMore('t_1'),
      store.append(msg(), [blob('b2')]),
      store.readBlob('b1'),
    ]);
    expect(m.maxActive()).toBe(1);
  });

  it('appendLog failure → store_unavailable, nothing in memory', async () => {
    const { store, m } = await loaded();
    const a = msg();
    m.failNext.add('appendLog');
    const r = await store.append(a, []);
    expect(r).toMatchObject({ ok: false, error: { code: 'store_unavailable', retryable: true } });
    expect(store.get(a.messageId)).toBeUndefined();
    expect(store.threads()).toEqual([]);
  });

  it('a rejected IO call does not break the queue', async () => {
    const { store, m } = await loaded();
    m.failNext.add('appendLog');
    const [r1, r2] = await Promise.all([store.append(msg(), []), store.append(msg(), [])]);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(true);
    expect(store.threads()[0].messageCount).toBe(1);
  });

  it('readLog failure → available() false and append → store_unavailable', async () => {
    const m = memIo();
    m.failNext.add('readLog');
    const store = createMessageStore(m.io);
    expect(await store.load()).toMatchObject({ ok: false, error: { code: 'store_unavailable' } });
    expect(store.available()).toBe(false);
    expect(await store.append(msg(), [])).toMatchObject({
      ok: false,
      error: { code: 'store_unavailable' },
    });
    expect(m.calls).not.toContain('appendLog');
  });

  it('blobs are written before the log line', async () => {
    const { store, m } = await loaded();
    m.calls.length = 0;
    await store.append(msg({ attachments: [att('b1'), att('b2')] }), [blob('b1'), blob('b2')]);
    expect(m.calls).toEqual(['writeBlob', 'writeBlob', 'appendLog']);
  });

  it('orphan blob (refcount 0) deleted on load', async () => {
    const { store, m } = await loaded();
    await store.append(msg({ attachments: [att('kept')] }), [blob('kept')]);
    m.state.blobs.set('orphan', new Uint8Array([9]));
    const fresh = createMessageStore(m.io);
    await fresh.load();
    expect([...m.state.blobs.keys()]).toEqual(['kept']);
    expect(await fresh.readBlob('kept')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('read is never downgraded to noticed', async () => {
    const { store } = await loaded();
    const a = msg();
    await store.append(a, []);
    await store.setStatus(a.messageId, 'codex-2', 'read');
    await store.setStatus(a.messageId, 'codex-2', 'noticed');
    expect(store.get(a.messageId)?.recipients['codex-2']).toMatchObject({
      status: 'read',
      noticeCount: 0,
    });
  });

  it('undelivered only for unread recipients', async () => {
    const { store } = await loaded();
    const a = msg({ to: ['codex-2', 'claude-3'] });
    await store.append(a, []);
    await store.setStatus(a.messageId, 'codex-2', 'read');
    await store.setStatus(a.messageId, 'codex-2', 'undelivered');
    await store.setStatus(a.messageId, 'claude-3', 'undelivered');
    const r = store.get(a.messageId)?.recipients;
    expect(r?.['codex-2'].status).toBe('read');
    expect(r?.['claude-3'].status).toBe('undelivered');
  });

  it('setStatus for an unknown message or non-recipient → not_found', async () => {
    const { store } = await loaded();
    const a = msg();
    await store.append(a, []);
    expect(await store.setStatus('m_nope', 'codex-2', 'read')).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await store.setStatus(a.messageId, 'claude-1', 'read')).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('pending excludes read, expired and other recipients', async () => {
    const { store } = await loaded();
    const queued = msg();
    const noticed = msg();
    const read = msg();
    const other = msg({ to: ['claude-3'] });
    for (const x of [queued, noticed, read, other]) await store.append(x, []);
    await store.setStatus(noticed.messageId, 'codex-2', 'noticed');
    await store.setStatus(read.messageId, 'codex-2', 'read');
    expect(store.pending('codex-2').map((x) => x.messageId)).toEqual([
      queued.messageId,
      noticed.messageId,
    ]);
  });

  it('agentCountSinceHuman resets on a you-post and on allow', async () => {
    const { store } = await loaded();
    await store.append(msg(), []);
    await store.append(msg(), []);
    expect(store.agentCountSinceHuman('t_1')).toBe(2);
    await store.append(msg({ from: 'you', to: ['claude-1'] }), []);
    expect(store.agentCountSinceHuman('t_1')).toBe(0);
    await store.append(msg(), []);
    expect(store.agentCountSinceHuman('t_1')).toBe(1);
    await store.allowMore('t_1');
    expect(store.agentCountSinceHuman('t_1')).toBe(0);
    await store.append(msg({ threadId: 't_2' }), []);
    expect(store.agentCountSinceHuman('t_1')).toBe(0);
  });

  it('participants = from ∪ to over the thread', async () => {
    const { store } = await loaded();
    await store.append(msg(), []);
    await store.append(msg({ from: 'codex-2', to: ['claude-1', 'you'] }), []);
    await store.append(msg({ threadId: 't_2', from: 'claude-9', to: ['claude-8'] }), []);
    expect([...store.participants('t_1')].sort()).toEqual(['claude-1', 'codex-2', 'you']);
    expect(store.participants('t_none').size).toBe(0);
  });

  it('threads sorted by lastAt desc with unreadFor', async () => {
    const { store } = await loaded();
    const a = msg({ threadId: 't_a', subject: 'alpha', priority: 'fyi' });
    const b = msg({ threadId: 't_b', subject: '', body: 'first line\nsecond', to: ['you'] });
    const c = msg({ threadId: 't_a', priority: 'urgent', to: ['codex-2', 'claude-3'] });
    for (const x of [a, b, c]) await store.append(x, []);
    await store.setStatus(a.messageId, 'codex-2', 'read');
    await store.setStatus(c.messageId, 'codex-2', 'read');
    const ts = store.threads();
    expect(ts.map((t) => t.threadId)).toEqual(['t_a', 't_b']);
    expect(ts[0]).toMatchObject({
      subject: 'alpha',
      topPriority: 'urgent',
      lastAt: c.sentAt,
      messageCount: 2,
      unreadFor: ['claude-3'],
    });
    expect(ts[1]).toMatchObject({ firstLine: 'first line', unreadFor: ['you'] });
  });

  it('thread is sentAt ascending', async () => {
    const { store } = await loaded();
    const late = msg({ sentAt: '2026-10-25T12:00:00.000Z' });
    const early = msg({ sentAt: '2026-10-25T09:00:00.000Z' });
    await store.append(late, []);
    await store.append(early, []);
    expect(store.thread('t_1').map((x) => x.messageId)).toEqual([early.messageId, late.messageId]);
  });

  it('inbox remaining counts beyond limit', async () => {
    const { store } = await loaded();
    const ms = [msg(), msg(), msg(), msg({ to: ['claude-3'] })];
    for (const x of ms) await store.append(x, []);
    await store.setStatus(ms[0].messageId, 'codex-2', 'read');
    const unread = store.inbox('codex-2', { unreadOnly: true, limit: 1 });
    expect(unread.messages.map((x) => x.messageId)).toEqual([ms[1].messageId]);
    expect(unread.remaining).toBe(1);
    const all = store.inbox('codex-2', { unreadOnly: false, limit: 10 });
    expect(all.messages).toHaveLength(3);
    expect(all.remaining).toBe(0);
    expect(store.inbox('claude-1', { unreadOnly: false, limit: 10 }).messages).toHaveLength(4);
  });

  it('onChange fires after a stored change and unsubscribes', async () => {
    const { store } = await loaded();
    let n = 0;
    const off = store.onChange(() => {
      n += 1;
    });
    await store.append(msg(), []);
    off();
    await store.append(msg(), []);
    expect(n).toBe(1);
  });
});

describe('createFsStoreIo', () => {
  it('round-trips the log and blobs through a store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-mcp-store-'));
    tmpDirs.push(dir);
    const sha = 'a'.repeat(64);
    const store = createMessageStore(createFsStoreIo(dir));
    expect((await store.load()).ok).toBe(true);
    const a = msg({ attachments: [att(sha)] });
    await store.append(a, [{ sha256: sha, data: new Uint8Array([7, 8]) }]);
    await store.setStatus(a.messageId, 'codex-2', 'noticed');
    expect(fs.readFileSync(path.join(dir, 'messages.log'), 'utf8').split('\n')).toHaveLength(3);

    const io2 = createFsStoreIo(dir);
    expect(await io2.listBlobs()).toEqual([sha]);
    const again = createMessageStore(io2);
    await again.load();
    expect(again.get(a.messageId)?.recipients['codex-2'].status).toBe('noticed');
    expect(await again.readBlob(sha)).toEqual(new Uint8Array([7, 8]));
    await io2.rewriteLog('');
    expect(await io2.readLog()).toBe('');
    await io2.deleteBlob(sha);
    expect(await io2.readBlob(sha)).toBeUndefined();
  });

  it('a blob is fsynced before its rename and a failed write leaves no temp', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-mcp-store-'));
    tmpDirs.push(dir);
    const io = createFsStoreIo(dir);
    const order: string[] = [];
    const open = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...a) => {
      const h = await open(...a);
      const sync = h.sync.bind(h);
      h.sync = async () => {
        order.push('sync');
        return sync();
      };
      return h;
    });
    const rename = fs.promises.rename.bind(fs.promises);
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (a, b) => {
      order.push('rename');
      return rename(a, b);
    });
    try {
      await io.writeBlob('b'.repeat(64), new Uint8Array([1, 2]));
      expect(order).toEqual(['sync', 'rename']);
      renameSpy.mockRejectedValueOnce(new Error('EPERM'));
      await expect(io.writeBlob('c'.repeat(64), new Uint8Array([3]))).rejects.toThrow('EPERM');
    } finally {
      openSpy.mockRestore();
      renameSpy.mockRestore();
    }
    expect(fs.readdirSync(path.join(dir, 'blobs'))).toEqual(['b'.repeat(64)]);
  });

  it('load sweeps partial blob temps left by a crash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-mcp-store-'));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'blobs'));
    const stray = path.join(dir, 'blobs', `${'d'.repeat(64)}.4242.tmp`);
    fs.writeFileSync(stray, 'partial');
    const store = createMessageStore(createFsStoreIo(dir));
    expect((await store.load()).ok).toBe(true);
    expect(fs.existsSync(stray)).toBe(false);
  });

  it('an absent directory reads as an empty store', async () => {
    const dir = path.join(os.tmpdir(), `conduit-mcp-absent-${process.pid}-${Date.now()}`);
    tmpDirs.push(dir);
    const io = createFsStoreIo(dir);
    expect(await io.readLog()).toBeUndefined();
    expect(await io.listBlobs()).toEqual([]);
  });
});
