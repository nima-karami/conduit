import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  ABSENT_TTL_MS,
  EVICT_EXIT_WAIT_MS,
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
import type { LspMessage, LspReply, LspServerStatus, LspTrustPrompt } from '../../src/lsp-protocol';
import {
  CSHARP_SERVER,
  GO_SERVER,
  type LanguageServerSpec,
  type ServerWeight,
} from '../../src/lsp-registry';
import { DORMANT_MS, EVICT_MIN_HIDDEN_MS } from '../../src/lsp-residency';
import { resolveServerRoot } from '../../src/lsp-root';
import type { TrustStore } from '../../src/workspace-trust';

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
  gone = false;
  readonly exited: Promise<void>;
  private resolveExited: () => void = () => {};
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

  constructor(
    readonly root: string,
    readonly binary = '',
  ) {
    this.exited = new Promise<void>((res) => {
      this.resolveExited = res;
    });
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
    if (this.gone) return;
    this.gone = true;
    this.resolveExited();
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
    onGone: () => void;
    close: ReturnType<typeof vi.fn>;
  }[];
  files: Set<string>;
  realpaths: Map<string, string>;
  targets: Map<string, string>;
  binary: { present: boolean };
  send: (wc: number, epoch: string, msg: LspMessage) => Promise<unknown>;
  /** Shows the doc first (D7: only a shown doc launches) unless `visible: false`. */
  open: (
    path: string,
    text?: string,
    o?: { wc?: number; epoch?: string; version?: number; languageId?: string; visible?: boolean },
  ) => Promise<unknown>;
  /** Replaces what one window shows. */
  show: (paths: string[], o?: { wc?: number; epoch?: string }) => Promise<unknown>;
  req: (
    path: string,
    op: LspMessage<'lsp:request'>['op'],
    o?: { wc?: number; epoch?: string; version?: number; id?: string },
  ) => Promise<LspReply>;
  ready: (i?: number) => Promise<void>;
  trust: { store: TrustStore; saves: TrustStore[] };
  trustPushes: { trusted: readonly string[]; prompt: LspTrustPrompt | null }[];
}

const flush = () => vi.advanceTimersByTimeAsync(0);

function setup(
  o: {
    roots?: string[];
    files?: string[];
    platform?: 'linux' | 'win32';
    /** Trusted folders; everything by default so the lifecycle tests never meet a prompt. */
    trusted?: string[];
    registry?: LanguageServerSpec[];
  } = {},
): Setup {
  const trust = { store: { trusted: o.trusted ?? ['/'] } as TrustStore, saves: [] as TrustStore[] };
  const trustPushes: Setup['trustPushes'] = [];
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
  const resolveRoot = vi.fn((p: string, spec: LanguageServerSpec = GO_SERVER) =>
    resolveServerRoot(
      p,
      roots,
      spec,
      {
        exists: async (f) => files.has(f),
        realpath: async (f) => realpaths.get(f) ?? f,
        list: async () => [],
      },
      platform,
    ),
  );
  const startServer = vi.fn((x: { root: string; spec: LanguageServerSpec }) => {
    const s = new FakeServer(x.root, x.spec.binary);
    servers.push(s);
    return s;
  });
  const deps: LspManagerDeps = {
    registry: o.registry ?? [GO_SERVER],
    platform,
    workspaceRoots: () => roots,
    resolveBinary,
    resolveRoot,
    startServer,
    watchRoot: (root, _spec, onChanges, onMarker, onGone) => {
      const close = vi.fn();
      watchers.push({ root, onChanges, onMarker, onGone, close });
      return { close };
    },
    readTarget: async (p) => targets.get(p) ?? null,
    broadcastStatus: (s) => {
      statuses.push(s);
      events.push(`status ${s.state}`);
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as LspLog,
    trustStore: {
      get: () => trust.store,
      set: (s) => {
        trust.store = s;
        trust.saves.push(s);
      },
    },
    broadcastTrust: (t) => trustPushes.push(t),
    homeDir: '/home/n',
  };
  const mgr = new LspManager(deps);
  const versions = new Map<string, number>();
  const send = (wc: number, epoch: string, msg: LspMessage) => mgr.handle(wc, { epoch, msg });
  const shown = new Map<string, string[]>();
  const show: Setup['show'] = (paths, x = {}) => {
    const wc = x.wc ?? 1;
    const epoch = x.epoch ?? 'e1';
    shown.set(`${wc}:${epoch}`, paths);
    return send(wc, epoch, { type: 'lsp:visible', paths });
  };
  const open: Setup['open'] = (path, text = 'package main', x = {}) => {
    const wc = x.wc ?? 1;
    const epoch = x.epoch ?? 'e1';
    const now = shown.get(`${wc}:${epoch}`) ?? [];
    if (x.visible !== false && !now.includes(path)) void show([...now, path], { wc, epoch });
    return send(wc, epoch, {
      type: 'lsp:open',
      path,
      languageId: x.languageId ?? 'go',
      version: x.version ?? 1,
      text,
    });
  };
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
    show,
    req,
    ready,
    trust,
    trustPushes,
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
                {
                  exists: async (f) => t.files.has(f),
                  realpath: async (f) => f,
                  list: async () => [],
                },
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
  it.each(['reload', 'destroy'] as const)(
    'rejects an open resolving after client %s',
    async (action) => {
      const t = setup();
      const root = await t.deps.resolveRoot('/w/m/main.go', GO_SERVER);
      let release: () => void = () => {};
      t.resolveRoot.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(root);
          }),
      );
      const opening = t.open('/w/m/main.go', 'package main', { epoch: 'old' });
      await flush();
      if (action === 'reload') await t.send(1, 'new', { type: 'lsp:statusSnapshot' });
      else t.mgr.dropWebContents(1);
      release();
      expect(await opening).toEqual({ serverKey: null, state: 'no-root' });
      expect(t.startServer).not.toHaveBeenCalled();
      const internals = t.mgr as unknown as {
        docs: Map<string, unknown>;
        servers: Map<string, unknown>;
      };
      expect(internals.docs.size).toBe(0);
      expect(internals.servers.size).toBe(0);
    },
  );
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
    expect(await t.open('/w/m/main.go', 'package main', { wc: 7, epoch: 'y' })).toEqual({
      serverKey: null,
      state: 'no-root',
    });
  });

  it('retired epochs do not accumulate past the webContents that owned them (review #10)', async () => {
    const t = setup();
    const internals = t.mgr as unknown as { retired: Set<string> };
    for (const epoch of ['a', 'b', 'c', 'd']) {
      await t.open('/w/m/main.go', 'package main', { wc: 3, epoch });
    }
    await flush();
    expect(internals.retired.size).toBe(3);
    t.mgr.dropWebContents(3);
    await flush();
    expect(internals.retired.size).toBe(0);
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

describe('LspManager — a module whose folder resolves outside the workspace', () => {
  it('starts no server and answers root-escapes, not no-root', async () => {
    const t = setup({ files: ['/w/link/go.mod'] });
    t.realpaths.set('/w/link', '/elsewhere/mod');
    expect(await t.open('/w/link/main.go')).toEqual({ serverKey: null, state: 'no-root' });
    expect(await t.req('/w/link/main.go', 'definition')).toEqual({
      kind: 'unavailable',
      reason: 'root-escapes',
    });
    expect(await t.req('/nowhere/x.go', 'definition')).toEqual({
      kind: 'empty',
      adHocRoot: false,
    });
    expect(t.startServer).not.toHaveBeenCalled();
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
    expect(t.watchers[0]?.close).toHaveBeenCalled();
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
    expect(t.watchers[0]?.close).toHaveBeenCalled();
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
                {
                  exists: async (f) => t.files.has(f),
                  realpath: async (f) => f,
                  list: async () => [],
                },
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

  it('a waiting request never relaunches a record the idle stop already pruned', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await flush();
    const asked = t.req('/w/m/main.go', 'definition');
    await flush();
    await t.send(1, 'e1', { type: 'lsp:close', path: '/w/m/main.go' });
    await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS);
    expect(t.servers[0]?.stop).toHaveBeenCalled();
    expect((t.mgr as unknown as { servers: Map<string, unknown> }).servers.size).toBe(0);
    expect(await asked).toEqual({ kind: 'unavailable', reason: 'loading-timeout' });
    expect(t.startServer).toHaveBeenCalledTimes(1);
    t.mgr.killAllSync();
    expect(t.servers.every((s) => s.gone)).toBe(true);
  });

  it('a request that arrives while an ordered stop is in flight is answered by the restarted server (review #4)', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.ready();
    const old = t.servers[0] as FakeServer;
    let finishStop: () => void = () => {};
    old.stop.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          finishStop = () => {
            old.emitExit(0);
            res();
          };
        }),
    );
    await t.send(1, 'e1', { type: 'lsp:restart', languageId: 'go' });
    const asked = t.req('/w/m/main.go', 'definition');
    await vi.advanceTimersByTimeAsync(1_000);
    finishStop();
    await flush();
    expect(t.startServer).toHaveBeenCalledTimes(2);
    const fresh = t.servers[1] as FakeServer;
    fresh.answers.set('textDocument/definition', () => DEF);
    fresh.resolveInitialized();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await asked).kind).toBe('locations');
    expect(fresh.opened()).toEqual(['file:///w/m/main.go']);
  });

  it('restart clears a spent restart budget: the next crash restarts instead of crashing (review #8)', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.ready();
    for (const [i, delay] of [
      [1, 1000],
      [2, 4000],
      [3, 16000],
    ] as const) {
      t.servers[i - 1]?.emitExit(2);
      await vi.advanceTimersByTimeAsync(delay);
      await t.ready(i);
    }
    await t.send(1, 'e1', { type: 'lsp:restart', languageId: 'go' });
    await flush();
    expect(t.statuses.at(-1)?.state).toBe('stopped');
    const asked = t.req('/w/m/main.go', 'hover');
    await flush();
    t.servers[4]?.answers.set('textDocument/hover', () => null);
    await t.ready(4);
    await asked;
    expect(t.statuses.at(-1)?.state).toBe('ready');
    t.servers[4]?.emitExit(2);
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
    expect((t.mgr as unknown as { servers: Map<string, unknown> }).servers.size).toBe(0);
    await t.open('/w/m/main.go');
    await t.ready(1);
    expect(t.statuses.at(-1)).toMatchObject({ serverKey: 'go:/w/m', state: 'ready' });
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

  it('cancellation during a target read stops reading subsequent targets', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.ready();
    t.servers[0]?.answers.set('textDocument/references', () => [
      { uri: 'file:///w/m/a.go', range: DEF[0]?.range },
      { uri: 'file:///w/m/b.go', range: DEF[0]?.range },
    ]);
    let release: () => void = () => {};
    const read = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('package main');
        }),
    );
    t.deps.readTarget = read;
    const request = t.req('/w/m/main.go', 'references', { id: 'targets' });
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    await t.send(1, 'e1', { type: 'lsp:cancel', requestId: 'targets' });
    release();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(await request).toMatchObject({ kind: 'empty' });
  });

  it('bounds target payload bytes and stops further file reads', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.ready();
    const content = 'é'.repeat(1024 * 1024);
    const count = 8;
    t.servers[0]?.answers.set('textDocument/references', () =>
      Array.from({ length: count + 4 }, (_, i) => ({
        uri: `file:///w/m/f${i}.go`,
        range: DEF[0]?.range,
      })),
    );
    const read = vi.fn(async () => content);
    t.deps.readTarget = read;
    const reply = await t.req('/w/m/main.go', 'references');
    expect(reply).toMatchObject({ kind: 'locations', dropped: 4 });
    if (reply.kind !== 'locations') throw new Error(reply.kind);
    expect(reply.targets).toHaveLength(count);
    expect(read).toHaveBeenCalledTimes(count);
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

  it('a restart keeps a live root watch, but re-arms one whose root went away', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.ready();
    t.servers[0]?.emitExit(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await t.ready(1);
    expect(t.watchers).toHaveLength(1);

    t.watchers[0]?.onGone();
    t.servers[1]?.emitExit(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await t.ready(2);
    expect(t.watchers).toHaveLength(2);
    expect(t.watchers[1]?.root).toBe('/w/m');
    t.watchers[1]?.onChanges([{ path: '/w/m/back.go', type: 1 }]);
    expect(t.servers[2]?.notifies.at(-1)).toEqual({
      method: 'workspace/didChangeWatchedFiles',
      params: { changes: [{ uri: 'file:///w/m/back.go', type: 1 }] },
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
          languageIds: ['go'],
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

describe('LspManager — Workspace Trust (spec 2026-09-23-workspace-trust)', () => {
  const prompt = (t: Setup) => t.trustPushes.at(-1)?.prompt ?? null;
  const answer = (t: Setup, choice: 'trust' | 'trustParent' | 'deny', promptId?: string) =>
    t.send(1, 'e1', {
      type: 'lsp:trustAnswer',
      promptId: promptId ?? prompt(t)?.id ?? 'none',
      choice,
    });

  it('T1: an untrusted folder never spawns a server; its requests are restricted', async () => {
    const t = setup({ trusted: [] });
    expect(await t.open('/w/m/main.go')).toMatchObject({ serverKey: 'go:/w/m' });
    await flush();
    expect(t.startServer).not.toHaveBeenCalled();
    expect(t.statuses.at(-1)?.state).toBe('restricted');
    expect(await t.req('/w/m/main.go', 'definition')).toEqual({
      kind: 'unavailable',
      reason: 'restricted',
    });
    expect(await t.req('/w/m/main.go', 'hover')).toEqual({
      kind: 'unavailable',
      reason: 'restricted',
    });
    expect(t.startServer).not.toHaveBeenCalled();
  });

  it('raises one prompt for the workspace folder, naming its parent and the server', async () => {
    const t = setup({ trusted: [] });
    await t.open('/w/m/main.go');
    await t.open('/w/m/b.go');
    await t.req('/w/m/main.go', 'definition');
    await flush();
    expect(prompt(t)).toMatchObject({
      folder: '/w',
      parent: null,
      languageId: 'go',
      displayName: 'Go',
      runsTools: ['gopls, go list'],
    });
    expect(new Set(t.trustPushes.map((p) => p.prompt?.id).filter(Boolean)).size).toBe(1);
    expect(await t.send(1, 'e1', { type: 'lsp:trustState' })).toEqual({
      trusted: [],
      prompt: prompt(t),
    });
  });

  it('trust prompt lists one runsTools line per registry server', async () => {
    const t = setup({ trusted: [], registry: [GO_SERVER, CSHARP_SERVER] });
    await t.open('/w/m/main.go');
    await flush();
    expect(prompt(t)).toMatchObject({
      languageId: 'go',
      displayName: 'Go',
      runsTools: ['gopls, go list', 'csharp-ls, dotnet / MSBuild (evaluates project files)'],
    });
  });

  it('a missing binary is absent, not a trust question', async () => {
    const t = setup({ trusted: [] });
    t.binary.present = false;
    await t.open('/w/m/main.go');
    await flush();
    expect(t.statuses.at(-1)?.state).toBe('absent');
    expect(prompt(t)).toBeNull();
  });

  it('T2: Trust records the folder, persists it, and starts the waiting server', async () => {
    const t = setup({ trusted: [] });
    await t.open('/w/m/main.go');
    await flush();
    expect(await answer(t, 'trust')).toEqual({ ok: true });
    await flush();
    expect(t.trust.saves.at(-1)).toEqual({ trusted: ['/w'] });
    expect(t.startServer).toHaveBeenCalledTimes(1);
    expect(prompt(t)).toBeNull();
    await t.ready();
    t.servers[0]?.answers.set('textDocument/definition', () => DEF);
    expect((await t.req('/w/m/main.go', 'definition')).kind).toBe('locations');
  });

  it('the host refuses Trust Parent Folder when the parent is a filesystem root or home', async () => {
    for (const [roots, file] of [
      [['/w'], '/w/m/main.go'],
      [['/home/n/w'], '/home/n/w/m/main.go'],
      [['/home/n'], '/home/n/m/main.go'],
    ] as const) {
      const t = setup({ roots: [...roots], files: [`${roots[0]}/m/go.mod`], trusted: [] });
      await t.open(file);
      await flush();
      const asked = prompt(t);
      expect(asked?.parent).toBeNull();
      expect(await answer(t, 'trustParent', asked?.id)).toEqual({ ok: false });
      expect(t.trust.saves).toEqual([]);
      expect(prompt(t)?.id).toBe(asked?.id);
      expect(t.startServer).not.toHaveBeenCalled();
    }
  });

  it('T4: Trust Parent Folder covers every folder under the parent', async () => {
    const t = setup({
      roots: ['/p/a', '/p/b'],
      files: ['/p/a/go.mod', '/p/b/go.mod'],
      trusted: [],
    });
    await t.open('/p/a/main.go');
    await flush();
    await answer(t, 'trustParent');
    await flush();
    expect(t.trust.store).toEqual({ trusted: ['/p'] });
    await t.open('/p/b/main.go');
    await flush();
    expect(t.startServer).toHaveBeenCalledTimes(2);
    expect(prompt(t)).toBeNull();
  });

  it("Don't Trust keeps the folder restricted and never re-prompts on its own", async () => {
    const t = setup({ trusted: [] });
    await t.open('/w/m/main.go');
    await flush();
    await answer(t, 'deny');
    await flush();
    expect(prompt(t)).toBeNull();
    await t.open('/w/m/b.go');
    await t.req('/w/m/main.go', 'definition');
    await flush();
    expect(prompt(t)).toBeNull();
    expect(t.trust.saves).toEqual([]);
    expect(t.startServer).not.toHaveBeenCalled();
    expect(
      await t.send(1, 'e1', { type: 'lsp:trustRequest', path: '/w/m/main.go', languageId: 'go' }),
    ).toEqual({ ok: true, promptId: prompt(t)?.id });
    expect(prompt(t)?.folder).toBe('/w');
  });

  it('a trust request replies with the id of the prompt for THAT folder, queued or showing', async () => {
    const t = setup({ roots: ['/a', '/b'], files: ['/a/go.mod', '/b/go.mod'], trusted: ['/b'] });
    await t.open('/b/main.go');
    await flush();
    expect(
      await t.send(1, 'e1', { type: 'lsp:trustRequest', path: '/b/main.go', languageId: 'go' }),
    ).toEqual({ ok: true, promptId: null });
    t.trust.store = { trusted: [] };
    await t.send(1, 'e1', { type: 'lsp:trustRequest', path: '/b/main.go', languageId: 'go' });
    const shown = prompt(t);
    const reply = await t.send(1, 'e1', {
      type: 'lsp:trustRequest',
      path: '/a/main.go',
      languageId: 'go',
    });
    expect(prompt(t)?.id).toBe(shown?.id);
    expect(reply).toMatchObject({ ok: true });
    expect((reply as { promptId: string }).promptId).not.toBe(shown?.id);
    await answer(t, 'deny', shown?.id);
    expect(prompt(t)?.id).toBe((reply as { promptId: string }).promptId);
    expect(prompt(t)?.folder).toBe('/a');
  });

  it('T5: forged or reused prompt ids and out-of-workspace paths reach nothing', async () => {
    const t = setup({ trusted: [] });
    expect(await answer(t, 'trust', 'forged')).toEqual({ ok: false });
    await t.open('/w/m/main.go');
    await flush();
    const real = prompt(t)?.id;
    expect(await answer(t, 'trust', `${real}x`)).toEqual({ ok: false });
    expect(
      await t.send(1, 'e1', {
        type: 'lsp:trustRequest',
        path: '/elsewhere/x.go',
        languageId: 'go',
      }),
    ).toEqual({ ok: false, promptId: null });
    expect(t.trust.saves).toEqual([]);
    expect(await answer(t, 'trust', real)).toEqual({ ok: true });
    expect(await answer(t, 'trust', real)).toEqual({ ok: false });
    expect(t.trust.saves).toHaveLength(1);
  });

  it('T3: revoking trust stops that root through the ordered stop, and it stays restricted', async () => {
    const t = setup({ trusted: ['/w'] });
    await t.open('/w/m/main.go');
    await t.ready();
    expect(await t.send(1, 'e1', { type: 'lsp:trustRevoke', path: '/w' })).toEqual({ ok: true });
    await flush();
    expect(t.servers[0]?.stop).toHaveBeenCalledTimes(1);
    expect(t.trust.store).toEqual({ trusted: [] });
    expect(t.statuses.at(-1)?.state).toBe('restricted');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.startServer).toHaveBeenCalledTimes(1);
    expect(prompt(t)).toBeNull();
    expect(await t.req('/w/m/main.go', 'definition')).toEqual({
      kind: 'unavailable',
      reason: 'restricted',
    });
  });

  it('revoking trust answers requests already at gopls with restricted, not a timeout', async () => {
    const t = setup({ trusted: ['/w'] });
    await t.open('/w/m/main.go');
    await t.ready();
    const live = t.servers[0] as FakeServer;
    live.stop.mockImplementationOnce(async () => {
      setTimeout(() => live.emitExit(1), 2_000);
    });
    const inFlight = t.req('/w/m/main.go', 'definition');
    await flush();
    expect(live.requests.map((r) => r.method)).toEqual(['textDocument/definition']);
    await t.send(1, 'e1', { type: 'lsp:trustRevoke', path: '/w' });
    await flush();
    expect(await inFlight).toEqual({ kind: 'unavailable', reason: 'restricted' });
    expect(live.cancelled).toEqual(['textDocument/definition']);
  });

  it('a process exit that lands after the stop resolved does not overwrite Restricted', async () => {
    const t = setup({ trusted: ['/w'] });
    await t.open('/w/m/main.go');
    await t.ready();
    const live = t.servers[0] as FakeServer;
    // The real stop resolves when taskkill returns; the child's exit event can come after.
    live.stop.mockImplementationOnce(async () => {
      setTimeout(() => live.emitExit(1), 50);
    });
    await t.send(1, 'e1', { type: 'lsp:trustRevoke', path: '/w' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.statuses.at(-1)?.state).toBe('restricted');
    expect(t.mgr.statuses().map((s) => s.state)).toEqual(['restricted']);
  });

  it('trust state lists the trusted folders', async () => {
    const t = setup({ trusted: ['/a', '/b'] });
    expect(await t.send(1, 'e1', { type: 'lsp:trustState' })).toEqual({
      trusted: ['/a', '/b'],
      prompt: null,
    });
  });
});

describe('LspManager — a server with several language ids', () => {
  const CFAM: LanguageServerSpec = { ...GO_SERVER, languageIds: ['cpp', 'c'], binary: 'clangd' };
  const SHELL: LanguageServerSpec = { ...GO_SERVER, languageIds: ['shell'], binary: 'shls' };
  const PY: LanguageServerSpec = { ...GO_SERVER, languageIds: ['python'], binary: 'pyls' };
  const didOpens = (s: FakeServer | undefined) =>
    (s?.notifies ?? [])
      .filter((n) => n.method === 'textDocument/didOpen')
      .map((n) => {
        const td = n.params.textDocument as { uri: string; languageId: string };
        return [td.uri, td.languageId];
      });
  const didCloses = (s: FakeServer | undefined) =>
    (s?.notifies ?? [])
      .filter((n) => n.method === 'textDocument/didClose')
      .map((n) => n.params.textDocument?.uri);

  it("didOpen carries the doc's language id", async () => {
    const t = setup({ registry: [CFAM] });
    await t.open('/w/m/x.h', 'int f();', { languageId: 'c' });
    await t.open('/w/m/x.cpp', 'int f() {}', { languageId: 'cpp' });
    await t.ready();
    expect(t.servers).toHaveLength(1);
    expect(didOpens(t.servers[0])).toEqual([
      ['file:///w/m/x.h', 'c'],
      ['file:///w/m/x.cpp', 'cpp'],
    ]);
    await t.open('/w/m/y.h', 'int g();', { languageId: 'c' });
    expect(didOpens(t.servers[0]).at(-1)).toEqual(['file:///w/m/y.h', 'c']);
    expect(t.mgr.statuses().map((s) => [s.serverKey, s.languageId])).toEqual([['cpp:/w/m', 'cpp']]);
  });

  it('open with a different language id re-opens the doc', async () => {
    const t = setup({ registry: [SHELL, PY] });
    const P = '/w/m/tool';
    await t.open(P, '#!/bin/sh', { wc: 1, epoch: 'a', languageId: 'shell' });
    await t.open(P, '#!/bin/sh', { wc: 2, epoch: 'b', languageId: 'shell' });
    await t.ready(0);
    const shell = t.servers[0];
    expect(didOpens(shell)).toEqual([['file:///w/m/tool', 'shell']]);
    await t.send(1, 'a', { type: 'lsp:close', path: P });
    await t.open(P, '#!/bin/sh', { wc: 1, epoch: 'a', languageId: 'python' });
    expect(didCloses(shell)).toEqual(['file:///w/m/tool']);
    await t.ready(1);
    expect(didOpens(t.servers[1])).toEqual([['file:///w/m/tool', 'python']]);
    // Window 2's ref came across: its close and window 1's each drop one, and only then is it gone.
    await t.send(2, 'b', { type: 'lsp:close', path: P });
    expect(didCloses(t.servers[1])).toEqual([]);
    await t.send(1, 'a', { type: 'lsp:close', path: P });
    expect(didCloses(t.servers[1])).toEqual(['file:///w/m/tool']);
    await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS);
    expect(shell?.stop).toHaveBeenCalled();
  });

  it("a re-open under a new id that dies mid-resolve keeps the other windows' refs", async () => {
    const t = setup({ registry: [SHELL, PY] });
    const P = '/w/m/tool';
    await t.open(P, '#!/bin/sh', { wc: 1, epoch: 'a', languageId: 'shell' });
    await t.open(P, '#!/bin/sh', { wc: 2, epoch: 'b', languageId: 'shell' });
    await t.ready(0);
    const root = await t.deps.resolveRoot(P, PY);
    let release: () => void = () => {};
    t.resolveRoot.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r(root);
        }),
    );
    const reopening = t.open(P, '#!/usr/bin/env python3', {
      wc: 1,
      epoch: 'a',
      languageId: 'python',
    });
    await flush();
    t.mgr.dropWebContents(1);
    release();
    expect(await reopening).toEqual({ serverKey: null, state: 'no-root' });
    expect(
      await t.send(2, 'b', { type: 'lsp:change', path: P, version: 2, text: '#!/bin/sh\n' }),
    ).toEqual({ ok: true });
    expect(didCloses(t.servers[0])).toEqual([]);
  });

  it('restart by a secondary id restarts the server', async () => {
    const t = setup({ registry: [CFAM] });
    await t.open('/w/m/x.h', 'int f();', { languageId: 'c' });
    await t.ready();
    expect(await t.send(1, 'e1', { type: 'lsp:restart', languageId: 'c' })).toEqual({ ok: true });
    await flush();
    expect(t.servers[0]?.stop).toHaveBeenCalled();
  });

  it('absent TTL is per server', async () => {
    const t = setup({ registry: [CFAM], files: ['/w/a/go.mod', '/w/b/go.mod'] });
    t.binary.present = false;
    await t.open('/w/a/x.h', '', { languageId: 'c' });
    await flush();
    await t.open('/w/b/x.cpp', '', { languageId: 'cpp' });
    await flush();
    expect(t.resolveBinary).toHaveBeenCalledTimes(1);
    expect(t.mgr.statuses().map((s) => s.state)).toEqual(['absent', 'absent']);
  });

  it('resolve cached across stop/relaunch, cleared by restart and by a null resolve', async () => {
    const t = setup();
    await t.open('/w/m/main.go');
    await t.ready(0);
    expect(t.resolveBinary).toHaveBeenCalledTimes(1);
    await t.send(1, 'e1', { type: 'lsp:close', path: '/w/m/main.go' });
    await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS);
    expect(t.servers[0]?.stop).toHaveBeenCalled();
    await t.open('/w/m/main.go');
    await t.ready(1);
    expect(t.startServer).toHaveBeenCalledTimes(2);
    expect(t.resolveBinary).toHaveBeenCalledTimes(1);

    t.binary.present = false;
    await t.send(1, 'e1', { type: 'lsp:restart', languageId: 'go' });
    await flush();
    const missing = t.req('/w/m/main.go', 'definition');
    await flush();
    expect(await missing).toEqual({ kind: 'unavailable', reason: 'missing' });
    expect(t.resolveBinary).toHaveBeenCalledTimes(2);
    expect(t.mgr.statuses().map((s) => s.state)).toEqual(['absent']);

    t.binary.present = true;
    await vi.advanceTimersByTimeAsync(ABSENT_TTL_MS);
    const asked = t.req('/w/m/main.go', 'hover');
    await flush();
    expect(t.resolveBinary).toHaveBeenCalledTimes(3);
    expect(t.startServer).toHaveBeenCalledTimes(3);
    t.servers[2]?.answers.set('textDocument/hover', () => null);
    t.servers[2]?.resolveInitialized();
    expect(await asked).toEqual({ kind: 'empty', adHocRoot: false });
  });
});

describe('LspManager — residency (spec 2026-10-08-language-coverage §2.6)', () => {
  const spec = (id: string, weight: ServerWeight): LanguageServerSpec => ({
    ...GO_SERVER,
    languageIds: [id],
    binary: id,
    weight,
  });
  const LANGS = {
    rust: 'heavy',
    cpp: 'heavy',
    csharp: 'heavy',
    go: 'light',
    python: 'light',
    shell: 'light',
    lua: 'light',
    ruby: 'light',
  } as const;
  type Lang = keyof typeof LANGS;
  const P = Object.fromEntries(Object.keys(LANGS).map((l) => [l, `/w/m/a.${l}`])) as Record<
    Lang,
    string
  >;
  const mk = (o: { trusted?: string[]; roots?: string[]; files?: string[] } = {}) =>
    setup({
      registry: Object.entries(LANGS).map(([id, w]) => spec(id, w)),
      files: o.files ?? ['/w/m/go.mod', '/w/n/go.mod'],
      ...(o.trusted ? { trusted: o.trusted } : {}),
      ...(o.roots ? { roots: o.roots } : {}),
    });
  const adv = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const srv = (t: Setup, lang: Lang, nth = -1) =>
    t.servers.filter((s) => s.binary === lang).at(nth) as FakeServer;
  const started = (t: Setup) => t.servers.map((s) => s.binary);
  const stateOf = (t: Setup, lang: Lang) =>
    t.mgr.statuses().find((s) => s.languageId === lang)?.state ?? 'stopped';
  const logged = (t: Setup, level: 'info' | 'warn', text: string) =>
    (t.deps.log[level] as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[1]).includes(text),
    ).length;
  const openDoc = (
    t: Setup,
    lang: Lang,
    o: { visible?: boolean; wc?: number; epoch?: string } = {},
  ) => t.open(P[lang], `${lang} v1`, { languageId: lang, ...o });
  /** Window 1 shows `lang` (plus `alsoShow`) and nothing else; its server comes up live. */
  const bringUp = async (t: Setup, lang: Lang, alsoShow: Lang[] = []) => {
    await t.show([P[lang], ...alsoShow.map((l) => P[l])]);
    await openDoc(t, lang);
    await flush();
    srv(t, lang).resolveInitialized();
    await flush();
  };
  const holdStop = (s: FakeServer) => {
    let release: () => void = () => {};
    s.stop.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          release = () => {
            s.emitExit(0);
            r();
          };
        }),
    );
    return () => release();
  };
  /** AC-C1's setup: `.rs` shown at t0, `.cpp` at t1, then 61 s — `.rs` hidden 61 s. */
  const rustHidden61s = async (t: Setup) => {
    await bringUp(t, 'rust');
    await adv(1_000);
    await bringUp(t, 'cpp');
    await adv(EVICT_MIN_HIDDEN_MS + 1_000);
  };
  const showCs = async (t: Setup, also: Lang[] = []) => {
    await t.show([P.csharp, ...also.map((l) => P[l])]);
    await openDoc(t, 'csharp');
    await flush();
  };

  it('lsp:visible is acknowledged', async () => {
    const t = mk();
    expect(await t.show([P.go])).toEqual({ ok: true });
  });

  it('an invisible open registers the doc but starts nothing; showing it launches', async () => {
    const t = mk();
    expect(await openDoc(t, 'go', { visible: false })).toEqual({
      serverKey: 'go:/w/m',
      state: 'stopped',
    });
    await adv(5_000);
    expect(t.startServer).not.toHaveBeenCalled();
    expect(t.mgr.statuses()).toEqual([]);
    await t.show([P.go]);
    await flush();
    expect(started(t)).toEqual(['go']);
    srv(t, 'go').resolveInitialized();
    await flush();
    expect(srv(t, 'go').opened()).toEqual(['file:///w/m/a.go']);
  });

  it('a doc shown before its open launches on the open', async () => {
    const t = mk();
    await t.show([P.go]);
    await flush();
    expect(t.startServer).not.toHaveBeenCalled();
    await openDoc(t, 'go');
    await flush();
    expect(started(t)).toEqual(['go']);
  });

  it('a request on an invisible doc launches, also with a cached resolve', async () => {
    const t = mk();
    await openDoc(t, 'go', { visible: false });
    const first = t.req(P.go, 'definition');
    await flush();
    expect(started(t)).toEqual(['go']);
    srv(t, 'go').answers.set('textDocument/definition', () => DEF);
    srv(t, 'go').resolveInitialized();
    expect((await first).kind).toBe('locations');
    await adv(DORMANT_MS);
    expect(srv(t, 'go').stop).toHaveBeenCalledTimes(1);
    expect(stateOf(t, 'go')).toBe('stopped');
    const second = t.req(P.go, 'definition');
    await flush();
    expect(started(t)).toEqual(['go', 'go']);
    expect(t.resolveBinary).toHaveBeenCalledTimes(1);
    srv(t, 'go').answers.set('textDocument/definition', () => DEF);
    srv(t, 'go').resolveInitialized();
    expect((await second).kind).toBe('locations');
  });

  it('absent and restricted launches evict nothing', async () => {
    const t = mk({ roots: ['/w', '/v'], files: ['/w/m/go.mod', '/v/go.mod'], trusted: ['/w'] });
    await rustHidden61s(t);
    await t.show([]);
    await adv(EVICT_MIN_HIDDEN_MS + 1_000);
    t.binary.present = false;
    await showCs(t);
    expect(stateOf(t, 'csharp')).toBe('absent');
    t.binary.present = true;
    await adv(ABSENT_TTL_MS);
    await t.show(['/v/a.csharp']);
    await t.open('/v/a.csharp', 'cs', { languageId: 'csharp' });
    await flush();
    expect(t.mgr.statuses().find((s) => s.root === '/v')?.state).toBe('restricted');
    expect(srv(t, 'rust').stop).not.toHaveBeenCalled();
    expect(srv(t, 'cpp').stop).not.toHaveBeenCalled();
    expect(started(t)).toEqual(['rust', 'cpp']);
  });

  it('trust granted while every doc is hidden launches nothing; showing one does', async () => {
    const t = mk({ trusted: [] });
    await openDoc(t, 'go');
    await flush();
    expect(stateOf(t, 'go')).toBe('restricted');
    await t.show([]);
    const promptId = t.trustPushes.at(-1)?.prompt?.id ?? '';
    await t.send(1, 'e1', { type: 'lsp:trustAnswer', promptId, choice: 'trust' });
    await flush();
    expect(t.startServer).not.toHaveBeenCalled();
    expect(stateOf(t, 'go')).toBe('stopped');
    await t.show([P.go]);
    await flush();
    expect(started(t)).toEqual(['go']);
  });

  it('a window closed while its launch resolves the binary spawns nothing', async () => {
    const t = mk();
    let release: () => void = () => {};
    t.resolveBinary.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r({ binary: '/bin/go', toolDir: null });
        }),
    );
    await openDoc(t, 'go');
    await flush();
    t.mgr.dropWebContents(1);
    await flush();
    release();
    await flush();
    expect(t.startServer).not.toHaveBeenCalled();
    const rec = (t.mgr as unknown as { servers: Map<string, { state: string }> }).servers.get(
      'go:/w/m',
    );
    expect(rec?.state).toBe('stopped');
  });

  it('a third heavy stops the LRU heavy, waits for its exit, then spawns', async () => {
    const t = mk();
    await rustHidden61s(t);
    const rust = srv(t, 'rust');
    rust.stop.mockImplementationOnce(async () => {});
    await showCs(t);
    expect(rust.stop).toHaveBeenCalledTimes(1);
    expect(srv(t, 'cpp').stop).not.toHaveBeenCalled();
    expect(started(t)).toEqual(['rust', 'cpp']);
    rust.emitExit(0);
    await flush();
    expect(started(t)).toEqual(['rust', 'cpp', 'csharp']);
    expect(logged(t, 'warn', 'after eviction')).toBe(0);
  });

  it('an evictee that never exits holds the launch for EVICT_EXIT_WAIT_MS, then logs once', async () => {
    const t = mk();
    await rustHidden61s(t);
    srv(t, 'rust').stop.mockImplementationOnce(async () => {});
    await showCs(t);
    await adv(EVICT_EXIT_WAIT_MS - 1);
    expect(started(t)).toEqual(['rust', 'cpp']);
    await adv(1);
    expect(started(t)).toEqual(['rust', 'cpp', 'csharp']);
    expect(logged(t, 'warn', 'after eviction')).toBe(1);
  });

  it('an evictee shown while an earlier eviction is stopping is re-checked and kept', async () => {
    const t = mk();
    const order: Lang[] = ['go', 'python', 'rust', 'cpp', 'shell'];
    for (const [i, lang] of order.entries()) {
      await bringUp(t, lang, order.slice(0, i));
      await adv(1_000);
    }
    expect(logged(t, 'info', 'over budget')).toBe(1);
    await t.show([]);
    await adv(EVICT_MIN_HIDDEN_MS + 1_000);
    const release = holdStop(srv(t, 'rust'));
    await showCs(t);
    expect(srv(t, 'rust').stop).toHaveBeenCalledTimes(1);
    await t.show([P.csharp, P.go]);
    release();
    await flush();
    expect(srv(t, 'go').stop).not.toHaveBeenCalled();
    expect(started(t).at(-1)).toBe('csharp');
    expect(logged(t, 'info', 'over budget')).toBe(1);
  });

  it('an evictee shown again while it stops is relaunched when the stop ends', async () => {
    const t = mk();
    await rustHidden61s(t);
    const release = holdStop(srv(t, 'rust'));
    await showCs(t);
    await t.show([P.csharp, P.rust]);
    release();
    await flush();
    expect(started(t)).toEqual(['rust', 'cpp', 'csharp', 'rust']);
  });

  it('an evicted server keeps its docs: shown again, it replays the latest unsaved text', async () => {
    const t = mk();
    await rustHidden61s(t);
    await showCs(t);
    expect(srv(t, 'rust').gone).toBe(true);
    await t.send(1, 'e1', { type: 'lsp:change', path: P.rust, version: 2, text: 'rust v2' });
    await t.show([P.rust]);
    await flush();
    expect(started(t)).toEqual(['rust', 'cpp', 'csharp', 'rust']);
    srv(t, 'rust').resolveInitialized();
    await flush();
    const open = srv(t, 'rust').notifies.find((n) => n.method === 'textDocument/didOpen');
    expect(open?.params.textDocument?.text).toBe('rust v2');
  });

  it('a server hidden < 60 s is kept: the launch goes over budget, logged once', async () => {
    const t = mk();
    await bringUp(t, 'rust');
    await bringUp(t, 'cpp');
    await showCs(t);
    expect(started(t)).toEqual(['rust', 'cpp', 'csharp']);
    expect(srv(t, 'rust').stop).not.toHaveBeenCalled();
    await t.show(['/w/n/b.rust']);
    await t.open('/w/n/b.rust', 'r', { languageId: 'rust' });
    await flush();
    expect(started(t)).toEqual(['rust', 'cpp', 'csharp', 'rust']);
    expect(logged(t, 'info', 'over budget')).toBe(1);
  });

  it('a server with a request in flight is not evicted', async () => {
    const t = mk();
    await bringUp(t, 'rust');
    await bringUp(t, 'cpp');
    await t.show([]);
    await adv(EVICT_MIN_HIDDEN_MS + 1_000);
    const a = t.req(P.rust, 'definition');
    const b = t.req(P.cpp, 'definition');
    await flush();
    await showCs(t);
    expect(srv(t, 'rust').stop).not.toHaveBeenCalled();
    expect(srv(t, 'cpp').stop).not.toHaveBeenCalled();
    expect(started(t).at(-1)).toBe('csharp');
    await adv(NAV_TIMEOUT_MS);
    await Promise.all([a, b]);
  });

  it('dormancy: hidden and idle for DORMANT_MS stops it; a change re-arms the clock', async () => {
    const t = mk();
    await bringUp(t, 'go');
    await t.show([]);
    await adv(DORMANT_MS / 2);
    await t.send(1, 'e1', { type: 'lsp:change', path: P.go, version: 2, text: 'go v2' });
    await adv(DORMANT_MS / 2 + 1);
    expect(srv(t, 'go').stop).not.toHaveBeenCalled();
    await adv(DORMANT_MS / 2);
    expect(srv(t, 'go').stop).toHaveBeenCalledTimes(1);
    expect(stateOf(t, 'go')).toBe('stopped');
  });

  it('a dormant server shown again while it stops is relaunched', async () => {
    const t = mk();
    await bringUp(t, 'go');
    await t.show([]);
    const release = holdStop(srv(t, 'go'));
    await adv(DORMANT_MS);
    expect(srv(t, 'go').stop).toHaveBeenCalledTimes(1);
    await t.show([P.go]);
    release();
    await flush();
    expect(started(t)).toEqual(['go', 'go']);
  });

  it('visibility is the union across windows; a dropped or minimized window shows nothing', async () => {
    const t = mk();
    await openDoc(t, 'go', { wc: 1, epoch: 'a', visible: false });
    await openDoc(t, 'go', { wc: 2, epoch: 'b', visible: false });
    await flush();
    expect(t.startServer).not.toHaveBeenCalled();
    await t.show([P.go], { wc: 2, epoch: 'b' });
    await flush();
    srv(t, 'go').resolveInitialized();
    await t.show([], { wc: 1, epoch: 'a' });
    await adv(DORMANT_MS);
    expect(srv(t, 'go').stop).not.toHaveBeenCalled();
    t.mgr.setWindowMinimized(2, true);
    await adv(DORMANT_MS);
    expect(srv(t, 'go').stop).toHaveBeenCalledTimes(1);
    t.mgr.setWindowMinimized(2, false);
    await flush();
    expect(started(t)).toEqual(['go', 'go']);
    srv(t, 'go').resolveInitialized();
    await flush();
    t.mgr.dropWebContents(2);
    await adv(DORMANT_MS);
    expect(srv(t, 'go').stop).toHaveBeenCalledTimes(1);
    t.mgr.setWindowMinimized(5, true);
    t.mgr.dropWebContents(5);
    expect((t.mgr as unknown as { minimized: Set<number> }).minimized.has(5)).toBe(false);
  });

  it('two launches at once over the total cap never exceed it (one launch queue)', async () => {
    const t = mk();
    for (const lang of ['go', 'python', 'shell', 'lua'] as const) {
      await bringUp(t, lang);
      await adv(1_000);
    }
    await t.show([]);
    await adv(EVICT_MIN_HIDDEN_MS + 1_000);
    await t.show([P.ruby, P.csharp]);
    await Promise.all([openDoc(t, 'ruby'), openDoc(t, 'csharp')]);
    await flush();
    expect(started(t).slice(4).sort()).toEqual(['csharp', 'ruby']);
    expect(t.servers.filter((s) => !s.gone)).toHaveLength(4);
    expect(srv(t, 'go').stop).toHaveBeenCalled();
    expect(srv(t, 'python').stop).toHaveBeenCalled();
    expect(srv(t, 'lua').stop).not.toHaveBeenCalled();
  });
});
