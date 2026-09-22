// One language-server process and its JSON-RPC connection. Knows nothing about docs, clients or
// restarts — that is lsp-manager's. See docs/adr/0006-host-side-language-servers.md.
import type { EventEmitter } from 'node:events';
import {
  CancellationTokenSource,
  createMessageConnection,
  ErrorCodes,
  type MessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import type { HostPlatform } from '../src/lsp-binary';
import type { LanguageServerSpec } from '../src/lsp-registry';
import { pathToFileUri } from '../src/lsp-uri';
import type { Logger } from './logger';
import { killTree, killTreeSync, type TreeKillDeps } from './process-tree';

export interface ChildLike extends EventEmitter {
  pid?: number;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
}
export type SpawnFn = (
  file: string,
  args: readonly string[],
  opts: {
    cwd: string;
    env: Record<string, string | undefined>;
    shell: false;
    windowsHide: true;
    stdio: 'pipe';
    detached: boolean;
  },
) => ChildLike;
export type LspLog = Pick<Logger, 'info' | 'warn' | 'error'>;

export interface StartServerOptions {
  spec: LanguageServerSpec;
  binary: string;
  toolDir: string | null;
  /** The LEXICAL root (doc-path spelling). */
  root: string;
  hostEnv: Record<string, string | undefined>;
  platform: HostPlatform;
  spawn: SpawnFn;
  tree: TreeKillDeps;
  log: LspLog;
}

export class LspRequestError extends Error {
  constructor(
    readonly reason: 'timeout' | 'server-error' | 'cancelled',
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

export interface LspExit {
  code: number | null;
  signal: string | null;
  stderrTail: string[];
}

export interface LspServerHandle {
  readonly pid: number | null;
  /** `initialize` answered and `initialized` sent; rejects (server-error) on error or early exit. */
  readonly initialized: Promise<void>;
  /** Any `$/progress` begin token still open. Picks timeouts/state only — never gates a send. */
  readonly loading: boolean;
  onProgress(cb: (loading: boolean, title: string | undefined) => void): void;
  onExit(cb: (e: LspExit) => void): void;
  notify(method: string, params: unknown): void;
  /** Sends immediately. Rejects LspRequestError; an aborted signal also sends `$/cancelRequest`. */
  request<R>(
    method: string,
    params: unknown,
    opts: { timeoutMs: number; signal: AbortSignal },
  ): Promise<R>;
  /** `shutdown` → (reply | 2 s) → tree kill. No `exit` notification: see spec §2.4. */
  stop(): Promise<void>;
  killSync(): void;
}

const STDERR_LINES = 50;
const SHUTDOWN_WAIT_MS = 2_000;
const SCOPE = 'lsp';

function initializeParams(root: string) {
  const uri = pathToFileUri(root);
  const nav = { dynamicRegistration: false, linkSupport: true };
  return {
    processId: process.pid,
    clientInfo: { name: 'Conduit' },
    rootUri: uri,
    workspaceFolders: [{ uri, name: root }],
    capabilities: {
      general: { positionEncodings: ['utf-16'] },
      textDocument: {
        synchronization: { dynamicRegistration: false },
        definition: nav,
        typeDefinition: nav,
        implementation: nav,
        references: { dynamicRegistration: false },
        hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
        documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
      },
      window: { workDoneProgress: true },
      workspace: {
        didChangeWatchedFiles: { dynamicRegistration: false },
        configuration: true,
        workspaceFolders: true,
      },
    },
  };
}

export function startLanguageServer(opts: StartServerOptions): LspServerHandle {
  const { spec, binary, toolDir, root, hostEnv, platform, tree, log } = opts;
  const child = opts.spawn(binary, spec.args, {
    cwd: root,
    env: spec.childEnv(hostEnv, toolDir, platform),
    shell: false,
    windowsHide: true,
    stdio: 'pipe',
    detached: platform !== 'win32',
  });
  const pid = child.pid ?? null;
  const conn: MessageConnection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );

  const stderrTail: string[] = [];
  let partial = '';
  child.stderr.on('data', (chunk: Buffer | string) => {
    const lines = (partial + chunk.toString()).split(/\r?\n/);
    partial = lines.pop() ?? '';
    stderrTail.push(...lines);
    if (stderrTail.length > STDERR_LINES) stderrTail.splice(0, stderrTail.length - STDERR_LINES);
  });

  const openTokens = new Set<string | number>();
  const progressCbs: ((loading: boolean, title: string | undefined) => void)[] = [];
  const exitCbs: ((e: LspExit) => void)[] = [];
  let exited = false;
  let resolveExited: () => void = () => {};
  const exitedP = new Promise<void>((r) => {
    resolveExited = r;
  });

  const onChildGone = (code: number | null, signal: string | null) => {
    if (exited) return;
    exited = true;
    if (partial) stderrTail.push(partial);
    conn.dispose();
    resolveExited();
    const e = { code, signal, stderrTail: stderrTail.slice(-STDERR_LINES) };
    for (const cb of exitCbs) cb(e);
  };
  child.on('exit', (code: number | null, signal: string | null) => onChildGone(code, signal));
  child.on('error', (err: Error) => {
    log.warn(SCOPE, `${spec.binary} process error`, { error: String(err) });
    onChildGone(null, null);
  });

  conn.onRequest('workspace/configuration', (p: { items?: unknown[] }) =>
    (p?.items ?? []).map(() => null),
  );
  conn.onRequest('window/workDoneProgress/create', () => null);
  conn.onRequest('client/registerCapability', () => null);
  conn.onRequest(
    (method) => new ResponseError(ErrorCodes.MethodNotFound, `unsupported request ${method}`),
  );
  conn.onNotification(
    '$/progress',
    (p: { token: string | number; value?: { kind?: string; title?: string } }) => {
      const kind = p?.value?.kind;
      if (kind === 'begin') openTokens.add(p.token);
      else if (kind === 'end') openTokens.delete(p.token);
      else return;
      for (const cb of progressCbs) cb(openTokens.size > 0, p.value?.title);
    },
  );
  conn.onNotification('window/showMessage', (p: { message?: string }) =>
    log.info(SCOPE, `${spec.binary}: ${p?.message ?? ''}`),
  );
  conn.onNotification('window/logMessage', (p: { message?: string }) =>
    log.info(SCOPE, `${spec.binary}: ${p?.message ?? ''}`),
  );
  conn.onNotification('textDocument/publishDiagnostics', () => {});
  conn.onError(([err]) =>
    log.warn(SCOPE, `${spec.binary} connection error`, { error: String(err) }),
  );
  conn.listen();

  const initialized = (async () => {
    try {
      await Promise.race([
        conn.sendRequest('initialize', initializeParams(root)),
        exitedP.then(() => {
          throw new Error('exited before initialize');
        }),
      ]);
      await conn.sendNotification('initialized', {});
    } catch (err) {
      throw new LspRequestError('server-error', String(err instanceof Error ? err.message : err));
    }
  })();
  initialized.catch(() => {});

  const request = <R>(
    method: string,
    params: unknown,
    o: { timeoutMs: number; signal: AbortSignal },
  ): Promise<R> => {
    if (exited) return Promise.reject(new LspRequestError('server-error', 'server exited'));
    if (o.signal.aborted) return Promise.reject(new LspRequestError('cancelled'));
    const cts = new CancellationTokenSource();
    return new Promise<R>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        o.signal.removeEventListener('abort', onAbort);
        cts.dispose();
        fn();
      };
      const onAbort = () => {
        cts.cancel();
        done(() => reject(new LspRequestError('cancelled')));
      };
      const timer = setTimeout(() => {
        cts.cancel();
        done(() => reject(new LspRequestError('timeout')));
      }, o.timeoutMs);
      o.signal.addEventListener('abort', onAbort);
      exitedP.then(() => done(() => reject(new LspRequestError('server-error', 'server exited'))));
      conn.sendRequest<R>(method, params, cts.token).then(
        (r) => done(() => resolve(r)),
        (err: unknown) =>
          done(() =>
            reject(
              new LspRequestError('server-error', err instanceof Error ? err.message : String(err)),
            ),
          ),
      );
    });
  };

  const killNow = () => {
    if (pid !== null && !exited) killTreeSync(pid, tree);
  };

  return {
    pid,
    initialized,
    get loading() {
      return openTokens.size > 0;
    },
    onProgress: (cb) => {
      progressCbs.push(cb);
    },
    onExit: (cb) => {
      exitCbs.push(cb);
    },
    notify: (method, params) => {
      if (exited) return;
      conn.sendNotification(method, params).catch(() => {});
    },
    request,
    async stop() {
      if (exited) return;
      await Promise.race([
        conn.sendRequest('shutdown').catch(() => {}),
        exitedP,
        new Promise((r) => setTimeout(r, SHUTDOWN_WAIT_MS)),
      ]);
      if (pid !== null && !exited) await killTree(pid, tree);
    },
    killSync: killNow,
  };
}
