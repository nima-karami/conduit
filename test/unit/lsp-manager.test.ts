import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  ABSENT_TTL_MS,
  HOVER_TIMEOUT_MS,
  IDLE_GRACE_MS,
  INIT_WAIT_SHORT_MS,
  LspManager,
  type LspManagerDeps,
  NAV_LOADING_TIMEOUT_MS,
  NAV_TIMEOUT_MS,
  ORIGIN_LRU_MAX,
  SYMBOLS_TIMEOUT_MS,
  TARGETS_MAX,
} from '../../electron/lsp-manager';
import { type LspLog, LspRequestError, type LspServerHandle } from '../../electron/lsp-server';
import type { WatchedChange } from '../../electron/lsp-watcher';
import type { LspMessage, LspReply, LspServerStatus } from '../../src/lsp-protocol';
import { GO_SERVER } from '../../src/lsp-registry';
import { resolveServerRoot } from '../../src/lsp-root';

type Answer = (params: unknown) => unknown;

/** Ordered log of everything any fake server was sent, across servers. */
let events: string[] = [];

class FakeServer implements LspServerHandle {
  static nextPid = 100;
  readonly pid = FakeServer.nextPid++;
  readonly initialized: Promise<void>;
  loading = false;
  notifies: {
    method: string;
    params: { textDocument?: { uri?: string; version?: number; text?: string } } & Record<
      string,
      unknown
    >;
  }[] = [];
  requests: { method: string; params: unknown; timeoutMs: number }[] = [];
  answers = new Map<string, Answer>();
  cancelled: string[] = [];
  exited = false;
  stop = vi.fn(async () => {
    this.emitExit(0);
  });
  killSync = vi.fn(() => {
    this.emitExit(null);
  });
  private progressCbs: ((l: boolean, t: string | undefined) => void)[] = [];
  private exitCbs: ((e: {
    code: number | null;
    signal: string | null;
    stderrTail: string[];
  }) => void)[] = [];
  private pendingRejects = new Set<(e: Error) => void>();
  resolveInitialized: () => void = () => {};
  rejectInitialized: (e: Error) => void = () => {};

  constructor(readonly root: string) {
    this.initialized = new Promise<void>((res, rej) => {
      this.resolveInitialized = res;
      this.rejectInitialized = rej;
    });
    this.initialized.catch(() => {});
  }
  onProgress(cb: (l: boolean, t: string | undefined) => void) {
    this.progressCbs.push(cb);
  }
  onExit(cb: (e: { code: number | null; signal: string | null; stderrTail: string[] }) => void) {
    this.exitCbs.push(cb);
  }
  notify(method: string, params: unknown) {
    const p = params as FakeServer['notifies'][number]['params'];
    this.notifies.push({ method, params: p });
    events.push(`${this.pid} ${method} ${p.textDocument?.uri ?? ''}`.trim());
  }
  request<R>(
    method: string,
    params: unknown,
    opts: { timeoutMs: number; signal: AbortSignal },
  ): Promise<R> {
    this.requests.push({ method, params, timeoutMs: opts.timeoutMs });
    events.push(`${this.pid} ${method}`);
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cancelled.push(method);
        reject(new LspRequestError('timeout'));
      }, opts.timeoutMs);
      opts.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        this.cancelled.push(method);
        reject(new LspRequestError('cancelled'));
      });
      const fail = (e: Error) => {
        clearTimeout(timer);
        reject(e);
      };
      this.pendingRejects.add(fail);
      const answer = this.answers.get(method);
      if (answer) {
        clearTimeout(timer);
        Promise.resolve(answer(params)).then((r) => resolve(r as R), reject);
      }
    });
  }
  setLoading(loading: boolean, title?: string) {
    this.loading = loading;
    for (const cb of this.progressCbs) cb(loading, title);
  }
  emitExit(code: number | null = 1) {
    if (this.exited) return;
    this.exited = true;
    for (const r of this.pendingRejects) r(new LspRequestError('server-error', 'exited'));
    for (const cb of this.exitCbs) cb({ code, signal: null, stderrTail: ['boom'] });
  }
  opened(): string[] {
    return this.notifies
      .filter((n) => n.method === 'textDocument/didOpen')
      .map((n) => n.params.textDocument?.uri ?? '');
  }
}

interface Setup {
  mgr: LspManager;
  servers: FakeServer[];
  statuses: LspServerStatus[];
  deps: LspManagerDeps;
  resolveBinary: ReturnType<typeof vi.fn>;
  resolveRoot: ReturnType<typeof vi.fn>;
  startServer: ReturnType<typeof vi.fn>;
  watchers: {
    root: string;
    onChanges: (c: WatchedChange[]) => void;
    onMarker: () => void;
    close: ReturnType<typeof vi.fn>;
  }[];
  files: Set<string>;
  realpaths: Map<string, string>;
  targets: Map<string, string>;
  binary: { present: boolean };
  send: (wc: number, epoch: string, msg: LspMessage) => Promise<unknown>;
  open: (
    path: string,
    text?: string,
    o?: { wc?: number; epoch?: string; version?: number },
  ) => Promise<unknown>;
  req: (
    path: string,
    op: LspMessage<'lsp:request'>['op'],
    o?: { wc?: number; epoch?: string; version?: number; id?: string },
  ) => Promise<LspReply>;
  ready: (i?: number) => Promise<void>;
}

const flush = () => vi.advanceTimersByTimeAsync(0);

function setup(
  o: { roots?: string[]; files?: string[]; platform?: 'linux' | 'win32' } = {},
): Setup {
  const files = new Set(o.files ?? ['/w/m/go.mod']);
  const realpaths = new Map<string, string>();
  const targets = new Map<string, string>();
  const servers: FakeServer[] = [];
  const statuses: LspServerStatus[] = [];
  const watchers: Setup['watchers'] = [];
  const binary = { present: true };
  const roots = o.roots ?? ['/w'];
  const platform = o.platform ?? 'linux';
  const resolveBinary = vi.fn(async () =>
    binary.present ? { binary: '/bin/gopls', toolDir: null } : null,
  );
  const resolveRoot = vi.fn((p: string) =>
    resolveServerRoot(
      p,
      roots,
      GO_SERVER,
      { exists: async (f) => files.has(f), realpath: async (f) => realpaths.get(f) ?? f },
      platform,
    ),
  );
  const startServer = vi.fn((x: { root: string }) => {
    const s = new FakeServer(x.root);
    servers.push(s);
    return s;
  });
  const deps: LspManagerDeps = {
    registry: [GO_SERVER],
    platform,
    workspaceRoots: () => roots,
    resolveBinary,
    resolveRoot,
    startServer,
    watchRoot: (root, _spec, onChanges, onMarker) => {
      const close = vi.fn();
      watchers.push({ root, onChanges, onMarker, close });
      return { close };
    },
    readTarget: async (p) => targets.get(p) ?? null,
    broadcastStatus: (s) => {
      statuses.push(s);
      events.push(`status ${s.state}`);
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as LspLog,
  };
  const mgr = new LspManager(deps);
  const versions = new Map<string, number>();
  const send = (wc: number, epoch: string, msg: LspMessage) => mgr.handle(wc, { epoch, msg });
  const open: Setup['open'] = (path, text = 'package main', x = {}) =>
    send(x.wc ?? 1, x.epoch ?? 'e1', {
      type: 'lsp:open',
      path,
      languageId: 'go',
      version: x.version ?? 1,
      text,
    });
  let reqId = 0;
  const req: Setup['req'] = (path, op, x = {}) =>
    send(x.wc ?? 1, x.epoch ?? 'e1', {
      type: 'lsp:request',
      requestId: x.id ?? `r${++reqId}`,
      path,
      version: x.version ?? versions.get(path) ?? 1,
      op,
      line: 3,
      character: 4,
    }) as Promise<LspReply>;
  const ready = async (i = 0) => {
    await flush();
    servers[i]?.resolveInitialized();
    await flush();
  };
  return {
    mgr,
    servers,
    statuses,
    deps,
    resolveBinary,
    resolveRoot,
    startServer,
    watchers,
    files,
    realpaths,
    targets,
    binary,
    send,
    open,
    req,
    ready,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  events = [];
});
afterEach(() => {
  vi.useRealTimers();
});

const DEF = [
  {
    uri: 'file:///w/m/helper.go',
    range: { start: { line: 2, character: 5 }, end: { line: 2, character: 11 } },
  },
];

describe('LspManager — sharing and validation', () => {
  it('E1: two docs under one module from two windows share one server', async () => {
    const t = setup();
    const a = t.open('/w/m/main.go', 'package main', { wc: 1, epoch: 'a' });
    const b = t.open('/w/m/helper.go', 'package main', { wc: 2, epoch: 'b' });
    await t.ready();
    expect(await a).toEqual({ serverKey: 'go:/w/m', state: 'starting' });
    expect(((await b) as { serverKey: string }).serverKey).toBe('go:/w/m');
    expect(t.startServer).toHaveBeenCalledTimes(1);
    expect(t.servers[0]?.opened()).toEqual(['file:///w/m/main.go', 'file:///w/m/helper.go']);
  });

  it('E1: two modules without go.work get two servers', async () => {
    const t = setup({ files: ['/w/a/go.mod', '/w/b/go.mod'] });
    await t.open('/w/a/main.go');
    await t.open('/w/b/main.go');
    await t.ready(0);
    await t.ready(1);
    expect(t.startServer).toHaveBeenCalledTimes(2);
    expect(t.servers.map((s) => s.root).sort()).toEqual(['/w/a', '/w/b']);
  });

  it('invalid envelope → typed failure, nothing started', async () => {
    const t = setup();
    expect(await t.mgr.handle(1, { epoch: '', msg: { type: 'lsp:open' } })).toEqual({
      serverKey: null,
      state: 'no-root',
    });
    expect(
      await t.mgr.handle(1, {
        epoch: 'e',
        msg: { type: 'lsp:open', path: 'rel.go', languageId: 'go', version: 1, text: '' },
      }),
    ).toEqual({
      serverKey: null,
      state: 'no-root',
    });
    expect(await t.mgr.handle(1, { epoch: 'e', msg: { type: 'lsp:request' } })).toEqual({
      kind: 'unavailable',
      reason: 'server-error',
    });
    expect(await t.mgr.handle(1, null)).toEqual({ ok: false });
    expect(t.resolveRoot).not.toHaveBeenCalled();
    expect(t.startServer).not.toHaveBeenCalled();
  });

  it('open/change/request for one path reach the server in arrival order although root resolution is async', async () => {
    const t = setup();
    await t.open('/w/m/other.go');
    await t.ready();
    t.servers[0]?.answers.set('textDocument/definition', () => DEF);
    let releaseRoot: () => void = () => {};
    t.resolveRoot.mockImplementationOnce(
      (p: string) =>
        new Promise((res) => {
          releaseRoot = () =>
            res(
              resolveServerRoot(
                p,
                ['/w'],
                GO_SERVER,
                { exists: async (f) => t.files.has(f), realpath: async (f) => f },
                'linux',
              ),
            );
        }),
    );
    events = [];
    const opened = t.open('/w/m/main.go', 'v1');
    const changed = t.send(1, 'e1', {
      type: 'lsp:change',
      path: '/w/m/main.go',
      version: 2,
      text: 'v2',
    });
    const asked = t.req('/w/m/main.go', 'definition', { version: 2 });
    await flush();
    expect(events).toEqual([]);
    releaseRoot();
    await flush();
    await Promise.all([opened, changed]);
    expect((await asked).kind).toBe('locations');
    const pid = t.servers[0]?.pid;
    expect(events).toEqual([
      `${pid} textDocument/didOpen file:///w/m/main.go`,
      `${pid} textDocument/didChange file:///w/m/main.go`,
      `${pid} textDocument/definition`,
    ]);
  });
});

describe('LspManager — clients and epochs (#2)', () => {
  it('E13: a new epoch on the same webContents retires the old epoch; the new epoch re-syncs and is answered', async () => {
    const t = setup();
    await t.open('/w/m/main.go', 'package main', { epoch: 'old' });
    await t.ready();
    const s = t.servers[0] as FakeServer;
    s.answers.set('textDocument/definition', () => DEF);
    await t.open('/w/m/main.go', 'package main', { epoch: 'new' });
    await flush();
    expect(s.notifies.filter((n) => n.method === 'textDocument/didClose')).toHaveLength(1);
    expect(s.opened()).toEqual(['file:///w/m/main.go', 'file:///w/m/main.go']);
    expect((await t.req('/w/m/main.go', 'definition', { epoch: 'new' })).kind).toBe('locations');
  });

  it('a straggler from a retired epoch is rejected and changes nothing', async () => {
    const t = setup();
    await t.open('/w/m/main.go', 'package main', { epoch: 'old' });
    await t.ready();
    await t.open('/w/m/main.go', 'package main', { epoch: 'new' });
    await flush();
    const s = t.servers[0] as FakeServer;
    const before = s.notifies.length;
    expect(
      await t.send(1, 'old', { type: 'lsp:change', path: '/w/m/main.go', version: 9, text: 'x' }),
    ).toEqual({ ok: false });
    expect(await t.open('/w/m/a.go', 'package main', { epoch: 'old' })).toEqual({
      serverKey: null,
      state: 'no-root',
    });
    expect(await t.req('/w/m/main.go', 'definition', { epoch: 'old' })).toEqual({
      kind: 'unavailable',
      reason: 'server-error',
    });
    expect(s.notifies.length).toBe(before);
  });

  it('dropWebContents drops every epoch of it', async () => {
    const t = setup();
    await t.open('/w/m/main.go', 'package main', { wc: 7, epoch: 'x' });
    await t.ready();
    t.mgr.dropWebContents(7);
    await flush();
    const s = t.servers[0] as FakeServer;
    expect(s.notifies.map((n) => n.method)).toContain('textDocument/didClose');
    expect(await t.open('/w/m/main.go', 'package main', { wc: 7, epoch: 'x' })).toEqual({
      serverKey: null,
      state: 'no-root',
    });
  });
});

describe('LspManager — stale (#3)', () => {
  it('E14: identical text in two windows: both windows are answered, whichever wrote last', async () => {
    const t = setup();
    await t.open('/w/m/main.go', 'same', { wc: 1, epoch: 'a' });
    await t.open('/w/m/main.go', 'same', { wc: 2, epoch: 'b' });
    await t.ready();
    t.servers[0]?.answers.set('textDocument/definition', () => DEF);
    await t.send(2, 'b', { type: 'lsp:change', path: '/w/m/main.go', version: 2, text: 'edited' });
    await t.send(1, 'a', { type: 'lsp:change', path: '/w/m/main.go', version: 5, text: 'edited' });
    expect(
      (await t.req('/w/m/main.go', 'definition', { wc: 1, epoch: 'a', version: 5 })).kind,
    ).toBe('locations');
    expect(
      (await t.req('/w/m/main.go', 'definition', { wc: 2, epoch: 'b', version: 2 })).kind,
    ).toBe('locations');
  });

  it('only the diverged window gets stale', async () => {
    const t = setup();
    await t.open('/w/m/main.go', 'same', { wc: 1, epoch: 'a' });
    await t.open('/w/m/main.go', 'same', { wc: 2, epoch: 'b' });
    await t.ready();
    t.servers[0]?.answers.set('textDocument/definition', () => DEF);
    await t.send(1, 'a', { type: 'lsp:change', path: '/w/m/main.go', version: 2, text: 'mine' });
    expect(await t.req('/w/m/main.go', 'definition', { wc: 2, epoch: 'b', version: 1 })).toEqual({
      kind: 'stale',
    });
    expect(
      (await t.req('/w/m/main.go', 'definition', { wc: 1, epoch: 'a', version: 2 })).kind,
    ).toBe('locations');
  });

  it('an old version from the same client → stale', async () => {
    const t = setup();
    await t.open('/w/m/main.go', 'v1');
    await t.ready();
    await t.send(1, 'e1', { type: 'lsp:change', path: '/w/m/main.go', version: 2, text: 'v2' });
    expect(await t.req('/w/m/main.go', 'definition', { version: 1 })).toEqual({ kind: 'stale' });
    expect(await t.req('/w/m/nope.go', 'definition')).toEqual({ kind: 'empty', adHocRoot: false });
  });
});

describe('LspManager — lexical root (#4)', () => {
  it('realpath differs from the doc path: gopls gets the lexical root and returned realpath locations map back', async () => {
    const t = setup({ roots: ['/s'], files: ['/s/m/go.mod'] });
    t.realpaths.set('/s', '/real');
    t.realpaths.set('/s/m', '/real/m');
    await t.open('/s/m/main.go');
    await t.ready();
    const s = t.servers[0] as FakeServer;
    expect(t.startServer.mock.calls[0]?.[0].root).toBe('/s/m');
    expect(s.opened()).toEqual(['file:///s/m/main.go']);
    s.answers.set('textDocument/definition', () => [
      { uri: 'file:///real/m/helper.go', range: DEF[0]?.range },
    ]);
    t.targets.set('/s/m/helper.go', 'package main');
    const reply = await t.req('/s/m/main.go', 'definition');
    expect(reply).toMatchObject({
      kind: 'locations',
      locations: [{ path: '/s/m/helper.go' }],
      targets: [{ path: '/s/m/helper.go' }],
    });
  });
});

describe('LspManager — replay and liveness (#5)', () => {
  it('restart: didOpen replay for every table doc precedes state ready and any queued request', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.open('/w/m/helper.go');
    await t.ready();
    t.servers[0]?.emitExit(2);
    await flush();
    expect(t.statuses.at(-1)?.state).toBe('restarting');
    const asked = t.req('/w/m/main.go', 'definition');
    await vi.advanceTimersByTimeAsync(1000);
    const s2 = t.servers[1] as FakeServer;
    s2.answers.set('textDocument/definition', () => DEF);
    events = [];
    const statesBefore = t.statuses.length;
    s2.resolveInitialized();
    await flush();
    expect((await asked).kind).toBe('locations');
    expect(events).toEqual([
      `${s2.pid} textDocument/didOpen file:///w/m/main.go`,
      `${s2.pid} textDocument/didOpen file:///w/m/helper.go`,
      'status ready',
      `${s2.pid} textDocument/definition`,
    ]);
    expect(t.statuses.slice(statesBefore).map((s) => s.state)).toEqual(['ready']);
  });

  it('change while restarting updates only the table; the replay sends the latest text and version', async () => {
    const t = setup();
    await t.open('/w/m/main.go', 'v1');
    await t.ready();
    t.servers[0]?.emitExit(2);
    await flush();
    await t.send(1, 'e1', { type: 'lsp:change', path: '/w/m/main.go', version: 2, text: 'v2' });
    await t.send(1, 'e1', { type: 'lsp:change', path: '/w/m/main.go', version: 3, text: 'v3' });
    expect(t.servers[0]?.notifies.map((n) => n.method)).toEqual(['textDocument/didOpen']);
    await vi.advanceTimersByTimeAsync(1000);
    await t.ready(1);
    const replay = t.servers[1]?.notifies.find((n) => n.method === 'textDocument/didOpen');
    expect(replay?.params.textDocument).toMatchObject({ text: 'v3', version: 3 });
    expect(t.servers[1]?.notifies.map((n) => n.method)).toEqual(['textDocument/didOpen']);
  });
});

describe('LspManager — request timing and cancel (#8)', () => {
  it('nav while loading is sent immediately (not held for progress end) and answered', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await flush();
    const s = t.servers[0] as FakeServer;
    s.loading = true;
    s.resolveInitialized();
    await flush();
    expect(t.statuses.at(-1)?.state).toBe('loading');
    s.answers.set('textDocument/definition', () => DEF);
    expect((await t.req('/w/m/main.go', 'definition')).kind).toBe('locations');
    expect(s.requests[0]?.timeoutMs).toBeGreaterThan(NAV_TIMEOUT_MS);
  });

  it('nav while starting times out at 90 s total → loading-timeout', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await flush();
    const asked = t.req('/w/m/main.go', 'definition');
    await vi.advanceTimersByTimeAsync(NAV_LOADING_TIMEOUT_MS - 1);
    let settled = false;
    void asked.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await asked).toEqual({ kind: 'unavailable', reason: 'loading-timeout' });
    expect(t.servers[0]?.requests).toEqual([]);
  });

  it('ready nav times out at 10 s → timeout', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.ready();
    const asked = t.req('/w/m/main.go', 'definition');
    await flush();
    expect(t.servers[0]?.requests[0]?.timeoutMs).toBe(NAV_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS);
    expect(await asked).toEqual({ kind: 'unavailable', reason: 'timeout' });
  });

  it('hover while starting waits ≤ 3 s then empty', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await flush();
    const asked = t.req('/w/m/main.go', 'hover');
    await vi.advanceTimersByTimeAsync(INIT_WAIT_SHORT_MS);
    expect(await asked).toEqual({ kind: 'empty', adHocRoot: false });
    expect(t.servers[0]?.requests).toEqual([]);
  });

  it('lsp:cancel during the initialize wait aborts it (no request sent); lsp:cancel after send sends $/cancelRequest', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await flush();
    const waiting = t.req('/w/m/main.go', 'definition', { id: 'w1' });
    await flush();
    expect(await t.send(1, 'e1', { type: 'lsp:cancel', requestId: 'w1' })).toEqual({ ok: true });
    expect(await waiting).toEqual({ kind: 'empty', adHocRoot: false });
    t.servers[0]?.resolveInitialized();
    await flush();
    expect(t.servers[0]?.requests).toEqual([]);
    const sent = t.req('/w/m/main.go', 'references', { id: 'w2' });
    await flush();
    expect(t.servers[0]?.requests.map((r) => r.method)).toEqual(['textDocument/references']);
    await t.send(1, 'e1', { type: 'lsp:cancel', requestId: 'w2' });
    expect(await sent).toEqual({ kind: 'empty', adHocRoot: false });
    expect(t.servers[0]?.cancelled).toEqual(['textDocument/references']);
  });
});

describe('LspManager — absent and crash', () => {
  it('E5: missing binary → absent status, request → missing; open ok', async () => {
    const t = setup();
    t.binary.present = false;
    const opened = await t.open('/w/m/main.go');
    await flush();
    expect((opened as { serverKey: string }).serverKey).toBe('go:/w/m');
    expect(t.statuses.at(-1)?.state).toBe('absent');
    expect(await t.req('/w/m/main.go', 'definition')).toEqual({
      kind: 'unavailable',
      reason: 'missing',
    });
    expect(t.startServer).not.toHaveBeenCalled();
  });

  it('absent cached 30 s; re-probe starts and replays', async () => {
    const t = setup();
    t.binary.present = false;
    await t.open('/w/m/main.go');
    await flush();
    t.binary.present = true;
    await t.open('/w/m/b.go');
    await t.req('/w/m/main.go', 'definition');
    expect(t.resolveBinary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ABSENT_TTL_MS);
    const asked = t.req('/w/m/main.go', 'definition');
    await flush();
    expect(t.resolveBinary).toHaveBeenCalledTimes(2);
    const s = t.servers[0] as FakeServer;
    s.answers.set('textDocument/definition', () => DEF);
    s.resolveInitialized();
    await flush();
    expect(s.opened()).toEqual(['file:///w/m/main.go', 'file:///w/m/b.go']);
    expect((await asked).kind).toBe('locations');
  });

  it('E6: unexpected exit restarts after 1 s with replay; 4th exit in 5 min → crashed', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.ready();
    for (const [i, delay] of [
      [1, 1000],
      [2, 4000],
      [3, 16000],
    ] as const) {
      t.servers[i - 1]?.emitExit(2);
      await flush();
      expect(t.statuses.at(-1)?.state).toBe('restarting');
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(t.startServer).toHaveBeenCalledTimes(i);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.startServer).toHaveBeenCalledTimes(i + 1);
      await t.ready(i);
      expect(t.servers[i]?.opened()).toEqual(['file:///w/m/main.go']);
    }
    t.servers[3]?.emitExit(2);
    await flush();
    expect(t.statuses.at(-1)?.state).toBe('crashed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.startServer).toHaveBeenCalledTimes(4);
    expect(await t.req('/w/m/main.go', 'definition')).toEqual({
      kind: 'unavailable',
      reason: 'crashed',
    });
  });

  it('a pending request of a dead server → server-error', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.ready();
    const asked = t.req('/w/m/main.go', 'definition');
    await flush();
    t.servers[0]?.emitExit(2);
    expect(await asked).toMatchObject({ kind: 'unavailable', reason: 'server-error' });
  });

  it('an initialize failure → crashed, the process is killed', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await flush();
    t.servers[0]?.rejectInitialized(new LspRequestError('server-error', 'bad'));
    await flush();
    expect(t.statuses.at(-1)?.state).toBe('crashed');
    expect(t.servers[0]?.killSync).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.startServer).toHaveBeenCalledTimes(1);
  });

  it('a server that exits before answering initialize is crashed, with no restart armed (review #2)', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await flush();
    const asked = t.req('/w/m/main.go', 'definition');
    await flush();
    const s = t.servers[0] as FakeServer;
    s.emitExit(1);
    s.rejectInitialized(new LspRequestError('server-error', 'exited before initialize'));
    await flush();
    expect(await asked).toEqual({ kind: 'unavailable', reason: 'crashed' });
    expect(t.statuses.at(-1)?.state).toBe('crashed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.startServer).toHaveBeenCalledTimes(1);
    expect(t.statuses.map((x) => x.state)).not.toContain('restarting');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('LspManager — ordered stops and quit (#1)', () => {
  it('an exit after idle stop / restart command / re-home never restarts', async () => {
    const idle = setup();
    await idle.open('/w/m/main.go');
    await idle.ready();
    await idle.send(1, 'e1', { type: 'lsp:close', path: '/w/m/main.go' });
    await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS);
    expect(idle.servers[0]?.stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(idle.startServer).toHaveBeenCalledTimes(1);
    expect(idle.statuses.at(-1)?.state).toBe('stopped');

    const cmd = setup();
    await cmd.open('/w/m/main.go');
    await cmd.ready();
    await cmd.send(1, 'e1', { type: 'lsp:restart', languageId: 'go' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cmd.startServer).toHaveBeenCalledTimes(1);

    const rehome = setup({ files: ['/w/go.mod'] });
    await rehome.open('/w/m/main.go');
    await rehome.ready();
    rehome.files.add('/w/m/go.mod');
    rehome.watchers[0]?.onMarker();
    await flush();
    await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS);
    await rehome.ready(1);
    expect(rehome.servers[0]?.stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rehome.startServer).toHaveBeenCalledTimes(2);
  });

  it('E7: an exit after killAllSync does not restart, and pending restart timers are cleared', async () => {
    const t = setup({ files: ['/w/a/go.mod', '/w/b/go.mod'] });
    await t.open('/w/a/main.go');
    await t.open('/w/b/main.go');
    await t.ready(0);
    await t.ready(1);
    t.servers[0]?.emitExit(2);
    await flush();
    expect(t.statuses.at(-1)?.state).toBe('restarting');
    t.mgr.killAllSync();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.startServer).toHaveBeenCalledTimes(2);
  });

  it('E7: an open whose resolveRoot resolves after killAllSync never calls startServer', async () => {
    const t = setup();
    let release: () => void = () => {};
    t.resolveRoot.mockImplementationOnce(
      (p: string) =>
        new Promise((res) => {
          release = () =>
            res(
              resolveServerRoot(
                p,
                ['/w'],
                GO_SERVER,
                { exists: async (f) => t.files.has(f), realpath: async (f) => f },
                'linux',
              ),
            );
        }),
    );
    const opened = t.open('/w/m/main.go');
    await flush();
    t.mgr.killAllSync();
    release();
    await flush();
    expect(await opened).toEqual({ serverKey: null, state: 'no-root' });
    expect(t.resolveBinary).not.toHaveBeenCalled();
    expect(t.startServer).not.toHaveBeenCalled();
  });

  it('a restart delay that elapses after killAllSync never calls startServer', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.ready();
    t.servers[0]?.emitExit(2);
    await vi.advanceTimersByTimeAsync(500);
    t.mgr.killAllSync();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.startServer).toHaveBeenCalledTimes(1);
  });

  it('a restart command during binary resolution never spawns the in-flight launch', async () => {
    const t = setup();
    let release: () => void = () => {};
    t.resolveBinary.mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = () => res({ binary: '/bin/gopls', toolDir: null });
        }),
    );
    await t.open('/w/m/main.go');
    await flush();
    await t.send(1, 'e1', { type: 'lsp:restart', languageId: 'go' });
    release();
    await flush();
    expect(t.startServer).not.toHaveBeenCalled();
    expect(t.statuses.at(-1)?.state).toBe('stopped');
  });

  it('a binary resolution that finishes after killAllSync never calls startServer', async () => {
    const t = setup();
    let release: () => void = () => {};
    t.resolveBinary.mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = () => res({ binary: '/bin/gopls', toolDir: null });
        }),
    );
    await t.open('/w/m/main.go');
    await flush();
    t.mgr.killAllSync();
    release();
    await flush();
    expect(t.startServer).not.toHaveBeenCalled();
  });

  it('killAllSync calls killSync on every live server', async () => {
    const t = setup({ files: ['/w/a/go.mod', '/w/b/go.mod'] });
    await t.open('/w/a/main.go');
    await t.open('/w/b/main.go');
    await t.ready(0);
    await t.ready(1);
    t.mgr.killAllSync();
    expect(t.servers.map((s) => s.killSync.mock.calls.length)).toEqual([1, 1]);
    expect(await t.open('/w/a/x.go')).toEqual({ serverKey: null, state: 'no-root' });
  });
});

describe('LspManager — restart command', () => {
  it('restart {languageId} marks stopping, stops all, clears budget and absent cache, broadcasts stopped', async () => {
    const t = setup({ files: ['/w/a/go.mod', '/w/b/go.mod'] });
    await t.open('/w/a/main.go');
    await t.open('/w/b/main.go');
    await t.ready(0);
    await t.ready(1);
    t.servers[0]?.emitExit(2);
    await vi.advanceTimersByTimeAsync(1000);
    await t.ready(2);
    expect(await t.send(1, 'e1', { type: 'lsp:restart', languageId: 'go' })).toEqual({ ok: true });
    await flush();
    expect(t.servers[1]?.stop).toHaveBeenCalled();
    expect(t.servers[2]?.stop).toHaveBeenCalled();
    const last = t.statuses.slice(-2).map((s) => [s.serverKey, s.state]);
    expect(last).toEqual(
      expect.arrayContaining([
        ['go:/w/a', 'stopped'],
        ['go:/w/b', 'stopped'],
      ]),
    );
    const asked = t.req('/w/a/main.go', 'definition');
    await flush();
    expect(t.startServer).toHaveBeenCalledTimes(4);
    const fresh = t.servers[3] as FakeServer;
    fresh.answers.set('textDocument/definition', () => DEF);
    fresh.resolveInitialized();
    await flush();
    expect((await asked).kind).toBe('locations');
    fresh.emitExit(2);
    await flush();
    expect(t.statuses.at(-1)?.state).toBe('restarting');
  });

  it('restart clears the absent cache', async () => {
    const t = setup();
    t.binary.present = false;
    await t.open('/w/m/main.go');
    await flush();
    t.binary.present = true;
    await t.send(1, 'e1', { type: 'lsp:restart', languageId: 'go' });
    await flush();
    const asked = t.req('/w/m/main.go', 'definition');
    await flush();
    expect(t.startServer).toHaveBeenCalledTimes(1);
    t.servers[0]?.answers.set('textDocument/definition', () => DEF);
    t.servers[0]?.resolveInitialized();
    expect((await asked).kind).toBe('locations');
  });
});

describe('LspManager — lifetime (#13)', () => {
  it('E8: last tab closes → stop after 60 s; an open before 60 s cancels', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.ready();
    await t.send(1, 'e1', { type: 'lsp:close', path: '/w/m/main.go' });
    await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS - 1);
    await t.open('/w/m/main.go');
    await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS * 2);
    expect(t.servers[0]?.stop).not.toHaveBeenCalled();
    await t.send(1, 'e1', { type: 'lsp:close', path: '/w/m/main.go' });
    await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS - 1);
    expect(t.servers[0]?.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.servers[0]?.stop).toHaveBeenCalledTimes(1);
    expect(t.statuses.at(-1)?.state).toBe('stopped');
    expect(t.watchers[0]?.close).toHaveBeenCalled();
    expect(t.mgr.statuses()).toEqual([]);
  });

  it('there is no session input: LspManagerDeps has no sessionRoots', () => {
    expectTypeOf<LspManagerDeps>().not.toHaveProperty('sessionRoots');
  });
});

describe('LspManager — replies, re-home and status', () => {
  it('locations: an out-of-root path goes to the LRU; a later open of it attaches to that server', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.ready();
    const s = t.servers[0] as FakeServer;
    s.answers.set('textDocument/definition', () => [
      { uri: 'file:///goroot/src/fmt/print.go', range: DEF[0]?.range },
    ]);
    t.targets.set('/goroot/src/fmt/print.go', 'package fmt');
    const reply = await t.req('/w/m/main.go', 'definition');
    expect(reply).toMatchObject({
      kind: 'locations',
      locations: [{ path: '/goroot/src/fmt/print.go' }],
    });
    expect(await t.open('/goroot/src/fmt/print.go', 'package fmt')).toEqual({
      serverKey: 'go:/w/m',
      state: 'ready',
    });
    expect(s.opened()).toContain('file:///goroot/src/fmt/print.go');
    expect(await t.open('/elsewhere/x.go')).toEqual({ serverKey: null, state: 'no-root' });
    expect(await t.req('/elsewhere/x.go', 'definition')).toEqual({
      kind: 'unavailable',
      reason: 'no-root',
    });
  });

  it('the origin LRU is bounded: the oldest out-of-root origin is evicted', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.ready();
    const s = t.servers[0] as FakeServer;
    let batch: number[] = [];
    s.answers.set('textDocument/references', () =>
      batch.map((i) => ({ uri: `file:///goroot/f${i}.go`, range: DEF[0]?.range })),
    );
    batch = [0];
    await t.req('/w/m/main.go', 'references');
    batch = Array.from({ length: ORIGIN_LRU_MAX }, (_, i) => i + 1);
    await t.req('/w/m/main.go', 'references');
    expect(await t.open('/goroot/f0.go')).toEqual({ serverKey: null, state: 'no-root' });
    expect(await t.open(`/goroot/f${ORIGIN_LRU_MAX}.go`)).toEqual({
      serverKey: 'go:/w/m',
      state: 'ready',
    });
  });

  it('targets exclude paths open by the requesting client; over 200 or unreadable are dropped and counted', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.ready();
    const s = t.servers[0] as FakeServer;
    const locs = Array.from({ length: TARGETS_MAX + 5 }, (_, i) => ({
      uri: `file:///w/m/f${i}.go`,
      range: DEF[0]?.range,
    }));
    locs.push({ uri: 'file:///w/m/main.go', range: DEF[0]?.range });
    for (let i = 0; i < TARGETS_MAX; i++)
      if (i !== 3) t.targets.set(`/w/m/f${i}.go`, 'package main');
    s.answers.set('textDocument/references', () => locs);
    const reply = await t.req('/w/m/main.go', 'references');
    if (reply.kind !== 'locations') throw new Error(reply.kind);
    expect(reply.locations).toHaveLength(TARGETS_MAX + 6);
    expect(reply.targets.map((x) => x.path)).not.toContain('/w/m/main.go');
    expect(reply.targets).toHaveLength(TARGETS_MAX - 1);
    expect(reply.dropped).toBe(6);
    expect(s.requests[0]?.params).toMatchObject({ context: { includeDeclaration: true } });
  });

  it('empty result under an ad-hoc root → {kind:"empty", adHocRoot:true}', async () => {
    const t = setup({ files: [] });
    await t.open('/w/loose/main.go');
    await t.ready();
    t.servers[0]?.answers.set('textDocument/definition', () => null);
    expect(t.servers[0]?.root).toBe('/w');
    expect(await t.req('/w/loose/main.go', 'definition')).toEqual({
      kind: 'empty',
      adHocRoot: true,
    });
  });

  it('a marker event re-homes a doc', async () => {
    const t = setup({ files: [] });
    await t.open('/w/m/main.go');
    await t.ready();
    t.files.add('/w/m/go.mod');
    t.watchers[0]?.onMarker();
    await flush();
    expect(t.servers[0]?.notifies.map((n) => n.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didClose',
    ]);
    await t.ready(1);
    expect(t.servers[1]?.root).toBe('/w/m');
    expect(t.servers[1]?.opened()).toEqual(['file:///w/m/main.go']);
  });

  it('watcher changes forward as didChangeWatchedFiles once live', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await flush();
    t.watchers[0]?.onChanges([{ path: '/w/m/early.go', type: 1 }]);
    expect(t.servers[0]?.notifies).toEqual([]);
    await t.ready();
    t.watchers[0]?.onChanges([{ path: '/w/m/helper.go', type: 2 }]);
    expect(t.servers[0]?.notifies.at(-1)).toEqual({
      method: 'workspace/didChangeWatchedFiles',
      params: { changes: [{ uri: 'file:///w/m/helper.go', type: 2 }] },
    });
  });

  it('documentSymbol → NavTreeNode from the synced text', async () => {
    const t = setup();
    const text = 'package main\n\nfunc main() {}\n';
    await t.open('/w/m/main.go', text);
    await t.ready();
    t.servers[0]?.answers.set('textDocument/documentSymbol', () => [
      {
        name: 'main',
        kind: 12,
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 14 } },
        selectionRange: { start: { line: 2, character: 5 }, end: { line: 2, character: 9 } },
      },
    ]);
    const reply = await t.req('/w/m/main.go', 'documentSymbol');
    expect(reply).toEqual({
      kind: 'symbols',
      tree: {
        text: 'main.go',
        kind: 'module',
        spans: [{ start: 0, length: text.length }],
        childItems: [{ text: 'main', kind: 'function', spans: [{ start: 14, length: 14 }] }],
      },
    });
  });

  it('hover → markdown', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.ready();
    t.servers[0]?.answers.set('textDocument/hover', () => ({
      contents: { kind: 'markdown', value: 'func Greet() string' },
    }));
    expect(await t.req('/w/m/main.go', 'hover')).toEqual({
      kind: 'hover',
      markdown: 'func Greet() string',
    });
    t.servers[0]?.answers.set('textDocument/documentSymbol', () => []);
    await t.req('/w/m/main.go', 'documentSymbol');
    expect(t.servers[0]?.requests.map((r) => r.timeoutMs)).toEqual([
      HOVER_TIMEOUT_MS,
      SYMBOLS_TIMEOUT_MS,
    ]);
  });

  it('statusSnapshot lists servers with pid and languages from the registry', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.ready();
    expect(await t.send(1, 'e1', { type: 'lsp:statusSnapshot' })).toEqual({
      servers: [
        {
          serverKey: 'go:/w/m',
          languageId: 'go',
          root: '/w/m',
          state: 'ready',
          pid: t.servers[0]?.pid,
        },
      ],
      languages: [
        {
          languageId: 'go',
          displayName: 'Go',
          binary: 'gopls',
          installHint: 'go install golang.org/x/tools/gopls@latest',
          moduleMarker: 'go.mod',
        },
      ],
    });
  });

  it('every transition broadcasts a status with pid', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await flush();
    const s = t.servers[0] as FakeServer;
    s.loading = true;
    s.resolveInitialized();
    await flush();
    s.setLoading(false);
    expect(t.statuses.map((x) => [x.state, x.pid])).toEqual([
      ['starting', null],
      ['starting', s.pid],
      ['loading', s.pid],
      ['ready', s.pid],
    ]);
  });
});
