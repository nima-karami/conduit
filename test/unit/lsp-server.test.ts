import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CancellationToken,
  createMessageConnection,
  ErrorCodes,
  type MessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import {
  type ChildLike,
  type LspLog,
  LspRequestError,
  type LspServerHandle,
  type SpawnFn,
  startLanguageServer,
} from '../../electron/lsp-server';
import type { TreeKillDeps } from '../../electron/process-tree';
import type { HostPlatform } from '../../src/lsp-binary';
import { GO_SERVER } from '../../src/lsp-registry';
import { pathToFileUri } from '../../src/lsp-uri';

interface Harness {
  handle: LspServerHandle;
  peer: MessageConnection;
  child: ChildLike & EventEmitter;
  spawn: ReturnType<typeof vi.fn<SpawnFn>>;
  tree: { execFile: ReturnType<typeof vi.fn>; execFileSync: ReturnType<typeof vi.fn> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  notifications: { method: string; params: unknown }[];
  initParams: Promise<Record<string, unknown>>;
}

const live: Harness[] = [];

function start(
  opts: {
    platform?: HostPlatform;
    root?: string;
    hostEnv?: Record<string, string | undefined>;
    initialize?: (p: Record<string, unknown>) => unknown;
    configurePeer?: (peer: MessageConnection) => void;
  } = {},
): Harness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdin, stdout, stderr });
  const spawn = vi.fn<SpawnFn>(() => child);
  const peer = createMessageConnection(
    new StreamMessageReader(stdin),
    new StreamMessageWriter(stdout),
  );
  const notifications: { method: string; params: unknown }[] = [];
  let resolveInit: (p: Record<string, unknown>) => void = () => {};
  const initParams = new Promise<Record<string, unknown>>((r) => {
    resolveInit = r;
  });
  peer.onRequest('initialize', (p: Record<string, unknown>) => {
    resolveInit(p);
    return opts.initialize ? opts.initialize(p) : { capabilities: {} };
  });
  peer.onNotification((method, params) => {
    notifications.push({ method, params });
  });
  opts.configurePeer?.(peer);
  peer.listen();
  const tree = {
    execFile: vi.fn((_f: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) =>
      cb(null),
    ),
    execFileSync: vi.fn(),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handle = startLanguageServer({
    spec: GO_SERVER,
    binary: '/abs/gopls',
    toolDir: '/usr/local/go/bin',
    root: opts.root ?? '/w/mod',
    hostEnv: opts.hostEnv ?? { PATH: '/usr/bin' },
    platform: opts.platform ?? 'win32',
    spawn,
    tree: {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      kill: vi.fn(),
      ...tree,
    } as unknown as TreeKillDeps,
    log: log as unknown as LspLog,
  });
  const h = { handle, peer, child, spawn, tree, log, notifications, initParams };
  live.push(h);
  return h;
}

afterEach(() => {
  vi.useRealTimers();
  for (const h of live.splice(0)) {
    h.peer.dispose();
    h.child.emit('exit', 0, null);
  }
});

const until = async (pred: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('condition never met');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const signal = () => new AbortController().signal;

describe('startLanguageServer', () => {
  it('spawns the resolved absolute binary with no shell, cwd = root, detached only on posix, env from childEnv (GOTOOLCHAIN=local, no relative PATH entries)', async () => {
    const posix = start({ platform: 'linux', root: '/w/m', hostEnv: { PATH: '.:bin:/usr/bin' } });
    const [file, args, o] = posix.spawn.mock.calls[0] ?? [];
    expect(file).toBe('/abs/gopls');
    expect(args).toEqual([]);
    expect(o).toMatchObject({
      cwd: '/w/m',
      shell: false,
      windowsHide: true,
      stdio: 'pipe',
      detached: true,
    });
    expect(o?.env.PATH).toBe('/usr/local/go/bin:/usr/bin');
    expect(o?.env.GOTOOLCHAIN).toBe('local');
    const win = start({ platform: 'win32' });
    expect(win.spawn.mock.calls[0]?.[2].detached).toBe(false);
  });

  it('initialized resolves after initialize and sends initialized; rootUri = pathToFileUri(root)', async () => {
    const h = start({ root: 'C:\\w\\my mod' });
    await h.handle.initialized;
    const p = await h.initParams;
    expect(p.rootUri).toBe(pathToFileUri('C:\\w\\my mod'));
    expect(p.processId).toBe(process.pid);
    expect(p.workspaceFolders).toEqual([{ uri: 'file:///C:/w/my%20mod', name: 'C:\\w\\my mod' }]);
    const caps = p.capabilities as {
      textDocument: {
        definition: { linkSupport: boolean };
        documentSymbol: { hierarchicalDocumentSymbolSupport: boolean };
      };
      general: { positionEncodings: string[] };
    };
    expect(caps.textDocument.definition.linkSupport).toBe(true);
    expect(caps.textDocument.documentSymbol.hierarchicalDocumentSymbolSupport).toBe(true);
    expect(caps.general.positionEncodings).toEqual(['utf-16']);
    await until(() => h.notifications.some((n) => n.method === 'initialized'));
  });

  it('initialize error rejects initialized', async () => {
    const h = start({
      initialize: () => new ResponseError(ErrorCodes.InternalError, 'bad capability'),
    });
    await expect(h.handle.initialized).rejects.toMatchObject({ reason: 'server-error' });
  });

  it('an exit before initialize rejects initialized', async () => {
    const h = start({ initialize: () => new Promise(() => {}) });
    h.child.emit('exit', 1, null);
    await expect(h.handle.initialized).rejects.toMatchObject({ reason: 'server-error' });
  });

  it('progress begin/end toggles loading', async () => {
    const h = start();
    await h.handle.initialized;
    const seen: [boolean, string | undefined][] = [];
    h.handle.onProgress((l, t) => seen.push([l, t]));
    await h.peer.sendNotification('$/progress', {
      token: 't1',
      value: { kind: 'begin', title: 'Loading packages' },
    });
    await until(() => h.handle.loading);
    await h.peer.sendNotification('$/progress', {
      token: 't1',
      value: { kind: 'report', message: 'x' },
    });
    await h.peer.sendNotification('$/progress', { token: 't1', value: { kind: 'end' } });
    await until(() => !h.handle.loading);
    expect(seen).toEqual([
      [true, 'Loading packages'],
      [false, undefined],
    ]);
  });

  it('a request is sent immediately while a progress token is open', async () => {
    const h = start({
      configurePeer: (peer) =>
        peer.onRequest('textDocument/definition', () => [{ uri: 'file:///x', range: {} }]),
    });
    await h.handle.initialized;
    await h.peer.sendNotification('$/progress', {
      token: 't',
      value: { kind: 'begin', title: 'Load' },
    });
    await until(() => h.handle.loading);
    await expect(
      h.handle.request('textDocument/definition', {}, { timeoutMs: 1000, signal: signal() }),
    ).resolves.toEqual([{ uri: 'file:///x', range: {} }]);
    expect(h.handle.loading).toBe(true);
  });

  it('workspace/configuration answers one null per item', async () => {
    const h = start();
    await h.handle.initialized;
    await expect(
      h.peer.sendRequest('workspace/configuration', { items: [{ section: 'gopls' }, {}] }),
    ).resolves.toEqual([null, null]);
    await expect(
      h.peer.sendRequest('window/workDoneProgress/create', { token: 'x' }),
    ).resolves.toBeNull();
    await expect(
      h.peer.sendRequest('client/registerCapability', { registrations: [] }),
    ).resolves.toBeNull();
  });

  it('unknown server request gets MethodNotFound', async () => {
    const h = start();
    await h.handle.initialized;
    await expect(h.peer.sendRequest('workspace/applyEdit', {})).rejects.toMatchObject({
      code: ErrorCodes.MethodNotFound,
    });
  });

  it('publishDiagnostics dropped, showMessage logged', async () => {
    const h = start();
    await h.handle.initialized;
    await h.peer.sendNotification('textDocument/publishDiagnostics', {
      uri: 'file:///a',
      diagnostics: [],
    });
    await h.peer.sendNotification('window/showMessage', { type: 1, message: 'hello there' });
    await until(() => h.log.info.mock.calls.length > 0);
    expect(h.log.info.mock.calls.map((c) => c[1])).toEqual(['gopls: hello there']);
  });

  it('timeout rejects LspRequestError("timeout") and sends $/cancelRequest', async () => {
    let cancelled = false;
    const h = start({
      configurePeer: (peer) =>
        peer.onRequest('textDocument/hover', (_p: unknown, token: CancellationToken) => {
          token.onCancellationRequested(() => {
            cancelled = true;
          });
          return new Promise(() => {});
        }),
    });
    await h.handle.initialized;
    const err = await h.handle
      .request('textDocument/hover', {}, { timeoutMs: 30, signal: signal() })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LspRequestError);
    expect(err).toMatchObject({ reason: 'timeout' });
    await until(() => cancelled);
  });

  it('abort signal sends $/cancelRequest and rejects cancelled', async () => {
    let cancelled = false;
    const h = start({
      configurePeer: (peer) =>
        peer.onRequest('textDocument/references', (_p: unknown, token: CancellationToken) => {
          token.onCancellationRequested(() => {
            cancelled = true;
          });
          return new Promise(() => {});
        }),
    });
    await h.handle.initialized;
    const ac = new AbortController();
    const p = h.handle.request(
      'textDocument/references',
      {},
      { timeoutMs: 10_000, signal: ac.signal },
    );
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(p).rejects.toMatchObject({ reason: 'cancelled' });
    await until(() => cancelled);
  });

  it('a pending request rejects server-error when the process exits', async () => {
    const h = start({
      configurePeer: (peer) =>
        peer.onRequest('textDocument/definition', () => new Promise(() => {})),
    });
    await h.handle.initialized;
    const p = h.handle.request(
      'textDocument/definition',
      {},
      { timeoutMs: 10_000, signal: signal() },
    );
    await new Promise((r) => setTimeout(r, 10));
    h.child.emit('exit', 2, null);
    await expect(p).rejects.toMatchObject({ reason: 'server-error' });
  });

  it('exit fires onExit with the last 50 stderr lines', async () => {
    const h = start();
    const exits: { code: number | null; stderrTail: string[] }[] = [];
    h.handle.onExit((e) => exits.push(e));
    const stderr = h.child.stderr as PassThrough;
    stderr.write(Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'));
    stderr.write('\npanic: boom');
    await new Promise((r) => setTimeout(r, 10));
    h.child.emit('exit', 2, null);
    expect(exits).toHaveLength(1);
    expect(exits[0]?.code).toBe(2);
    expect(exits[0]?.stderrTail).toHaveLength(50);
    expect(exits[0]?.stderrTail.at(-1)).toBe('panic: boom');
    expect(exits[0]?.stderrTail[0]).toBe('line 11');
  });

  it('stop sends shutdown, then killTree on reply — no exit notification is ever sent', async () => {
    let shutdowns = 0;
    const h = start({
      configurePeer: (peer) =>
        peer.onRequest('shutdown', () => {
          shutdowns++;
          return null;
        }),
    });
    await h.handle.initialized;
    await h.handle.stop();
    expect(shutdowns).toBe(1);
    expect(h.tree.execFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\taskkill.exe',
      ['/PID', '4242', '/T', '/F'],
      expect.anything(),
      expect.any(Function),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(h.notifications.map((n) => n.method)).not.toContain('exit');
  });

  it('stop kills after 2 s when shutdown is never answered', async () => {
    const h = start({
      configurePeer: (peer) => peer.onRequest('shutdown', () => new Promise(() => {})),
    });
    await h.handle.initialized;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stopped = h.handle.stop();
    await vi.advanceTimersByTimeAsync(1_900);
    expect(h.tree.execFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await stopped;
    expect(h.tree.execFile).toHaveBeenCalledTimes(1);
  });

  it('killSync calls killTreeSync with the pid', () => {
    const h = start();
    h.handle.killSync();
    expect(h.tree.execFileSync).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\taskkill.exe',
      ['/PID', '4242', '/T', '/F'],
      expect.anything(),
    );
  });
});
