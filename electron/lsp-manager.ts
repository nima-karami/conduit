// Every language server, every synced doc, every client, and the lifecycle between them.
// Process-facing collaborators are injected so the whole state machine unit-tests with a fake
// server and a fake clock. Rules: docs/specs/2026-09-22-language-server-go.md §2–§3,
// docs/plans/2026-09-22-language-server-go.plan.md "lsp-manager" invariants, ADR 0006.
import { posix, win32 } from 'node:path';
import type { HostPlatform, ResolvedServer } from '../src/lsp-binary';
import { toHover, toLocations, toNavTree } from '../src/lsp-convert';
import {
  type LspCalls,
  type LspCallType,
  type LspMessage,
  type LspOp,
  type LspReply,
  type LspResult,
  type LspServerState,
  type LspServerStatus,
  parseLspEnvelope,
} from '../src/lsp-protocol';
import { type LanguageServerSpec, languageInfo, serverSpecFor } from '../src/lsp-registry';
import { nextRestart } from '../src/lsp-restart-budget';
import { type ServerRoot, toLexicalPath } from '../src/lsp-root';
import { pathToFileUri } from '../src/lsp-uri';
import type { LspLog, LspServerHandle } from './lsp-server';
import { LspRequestError } from './lsp-server';
import type { LspWatcherHandle, WatchedChange } from './lsp-watcher';

export interface LspManagerDeps {
  registry: readonly LanguageServerSpec[];
  platform: HostPlatform;
  workspaceRoots(): string[];
  resolveBinary(spec: LanguageServerSpec): Promise<ResolvedServer | null>;
  resolveRoot(path: string, spec: LanguageServerSpec): Promise<ServerRoot | null>;
  startServer(o: {
    spec: LanguageServerSpec;
    resolved: ResolvedServer;
    root: string;
  }): LspServerHandle;
  watchRoot(
    root: string,
    spec: LanguageServerSpec,
    onChanges: (c: WatchedChange[]) => void,
    onMarker: () => void,
  ): LspWatcherHandle;
  /** null if > 2 MB, unreadable, or not a regular file. */
  readTarget(path: string): Promise<string | null>;
  broadcastStatus(s: LspServerStatus): void;
  log: LspLog;
}

export const IDLE_GRACE_MS = 60_000;
export const ABSENT_TTL_MS = 30_000;
export const NAV_TIMEOUT_MS = 10_000;
export const NAV_LOADING_TIMEOUT_MS = 90_000;
export const HOVER_TIMEOUT_MS = 3_000;
export const SYMBOLS_TIMEOUT_MS = 5_000;
export const INIT_WAIT_SHORT_MS = 3_000;
export const ORIGIN_LRU_MAX = 2_000;
export const TARGETS_MAX = 200;

const SCOPE = 'lsp';

type ClientKey = string;

interface DocEntry {
  path: string;
  spec: LanguageServerSpec;
  text: string;
  lspVersion: number;
  serverKey: string | null;
  clients: Map<ClientKey, { refs: number; version: number; text: string }>;
}

interface ServerRecord {
  key: string;
  spec: LanguageServerSpec;
  realRoot: string;
  lexicalRoot: string;
  adHoc: boolean;
  state: LspServerState;
  progress: string | undefined;
  handle: LspServerHandle | null;
  /** `initialized` resolved AND the didOpen replay has been sent. */
  live: boolean;
  /** Set by every host-initiated stop so its exit is never read as a crash (spec §2.2). */
  stopping: boolean;
  /** Bumped per launch; callbacks from an older process are ignored. */
  generation: number;
  restartHistory: number[];
  restartTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  watcher: LspWatcherHandle | null;
  waiters: Set<() => void>;
}

const NAV_OPS: ReadonlySet<LspOp> = new Set([
  'definition',
  'typeDefinition',
  'implementation',
  'references',
]);

const LSP_METHOD: Record<LspOp, string> = {
  definition: 'textDocument/definition',
  typeDefinition: 'textDocument/typeDefinition',
  implementation: 'textDocument/implementation',
  references: 'textDocument/references',
  hover: 'textDocument/hover',
  documentSymbol: 'textDocument/documentSymbol',
};

function failureFor(type: unknown): LspResult<LspCallType> {
  switch (type) {
    case 'lsp:open':
      return { serverKey: null, state: 'no-root' };
    case 'lsp:request':
      return { kind: 'unavailable', reason: 'server-error' };
    case 'lsp:statusSnapshot':
      return { servers: [], languages: [] };
    default:
      return { ok: false };
  }
}

const EMPTY: LspReply = { kind: 'empty', adHocRoot: false };

export class LspManager {
  private readonly docs = new Map<string, DocEntry>();
  private readonly servers = new Map<string, ServerRecord>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly currentEpoch = new Map<number, string>();
  private readonly retired = new Set<ClientKey>();
  private readonly gone = new Set<number>();
  private readonly pending = new Map<string, AbortController>();
  private readonly originLru = new Map<string, string>();
  private readonly absentUntil = new Map<string, number>();
  private disposed = false;

  constructor(private readonly deps: LspManagerDeps) {}

  handle(webContentsId: number, raw: unknown): Promise<LspResult<LspCallType>> {
    const env = parseLspEnvelope(raw);
    const rawType = (raw as { msg?: { type?: unknown } } | null)?.msg?.type;
    if (!env) return Promise.resolve(failureFor(rawType));
    const client = this.admitClient(webContentsId, env.epoch);
    if (client === null || this.disposed) return Promise.resolve(failureFor(env.msg.type));
    return this.dispatch(client, env.msg);
  }

  dropWebContents(webContentsId: number): void {
    const epoch = this.currentEpoch.get(webContentsId);
    this.currentEpoch.delete(webContentsId);
    if (epoch !== undefined) this.retireClient(`${webContentsId}:${epoch}`);
    // One entry per destroyed webContents replaces every retired epoch it accumulated.
    this.gone.add(webContentsId);
    const prefix = `${webContentsId}:`;
    for (const c of this.retired) if (c.startsWith(prefix)) this.retired.delete(c);
  }

  statuses(): LspServerStatus[] {
    return [...this.servers.values()]
      .filter((r) => r.state !== 'stopped')
      .map((r) => this.statusOf(r));
  }

  killAllSync(): void {
    this.disposed = true;
    for (const ac of this.pending.values()) ac.abort();
    this.pending.clear();
    for (const rec of this.servers.values()) {
      this.clearTimers(rec);
      rec.watcher?.close();
      rec.watcher = null;
      if (rec.handle) {
        rec.stopping = true;
        rec.live = false;
        rec.handle.killSync();
      }
    }
  }

  // ---------- clients (plan finding #2) ----------

  private admitClient(webContentsId: number, epoch: string): ClientKey | null {
    const key = `${webContentsId}:${epoch}`;
    if (this.gone.has(webContentsId) || this.retired.has(key)) return null;
    const current = this.currentEpoch.get(webContentsId);
    if (current !== undefined && current !== epoch)
      this.retireClient(`${webContentsId}:${current}`);
    this.currentEpoch.set(webContentsId, epoch);
    return key;
  }

  private retireClient(client: ClientKey): void {
    this.retired.add(client);
    for (const [k, ac] of this.pending) if (k.startsWith(`${client}:`)) ac.abort();
    for (const doc of this.docs.values()) {
      if (!doc.clients.has(client)) continue;
      void this.enqueue(doc.path, () => {
        const d = this.docs.get(doc.path);
        if (!d?.clients.delete(client)) return;
        this.afterRefsDropped(d);
      });
    }
  }

  // ---------- dispatch ----------

  private dispatch(client: ClientKey, msg: LspMessage): Promise<LspResult<LspCallType>> {
    switch (msg.type) {
      case 'lsp:open':
        return this.enqueue(msg.path, () => this.open(client, msg));
      case 'lsp:change':
        return this.enqueue(msg.path, () => this.change(client, msg));
      case 'lsp:close':
        return this.enqueue(msg.path, () => this.close(client, msg));
      case 'lsp:request':
        return this.request(client, msg);
      case 'lsp:cancel': {
        const ac = this.pending.get(`${client}:${msg.requestId}`);
        ac?.abort();
        return Promise.resolve({ ok: ac !== undefined });
      }
      case 'lsp:statusSnapshot':
        return Promise.resolve({
          servers: this.statuses(),
          languages: this.deps.registry.map(languageInfo),
        });
      case 'lsp:restart':
        this.restartLanguage(msg.languageId);
        return Promise.resolve({ ok: true });
    }
  }

  /** Per-DOCUMENT intake chain: enqueued synchronously on arrival, so one path's messages reach
   *  the server in arrival order even though root resolution is async (plan "Ordering"). */
  private enqueue<T>(path: string, step: () => T | Promise<T>): Promise<T> {
    const prev = this.chains.get(path) ?? Promise.resolve();
    const next = prev.then(step, step);
    const tail = next.catch(() => {});
    this.chains.set(path, tail);
    void tail.then(() => {
      if (this.chains.get(path) === tail) this.chains.delete(path);
    });
    return next;
  }

  // ---------- docs ----------

  private async open(
    client: ClientKey,
    msg: LspMessage<'lsp:open'>,
  ): Promise<LspCalls['lsp:open']['res']> {
    const spec = serverSpecFor(msg.languageId, this.deps.registry);
    if (!spec) return { serverKey: null, state: 'no-root' };
    let doc = this.docs.get(msg.path);
    if (!doc) {
      const key = await this.keyFor(msg.path, spec);
      if (this.disposed) return { serverKey: null, state: 'no-root' };
      doc = this.docs.get(msg.path);
      if (!doc) {
        doc = {
          path: msg.path,
          spec,
          text: msg.text,
          lspVersion: 1,
          serverKey: key,
          clients: new Map(),
        };
        this.docs.set(msg.path, doc);
      }
    }
    const wasOpen = this.totalRefs(doc) > 0;
    const entry = doc.clients.get(client);
    if (entry) {
      entry.refs++;
      entry.version = msg.version;
      entry.text = msg.text;
    } else {
      doc.clients.set(client, { refs: 1, version: msg.version, text: msg.text });
    }
    const rec = doc.serverKey ? this.servers.get(doc.serverKey) : undefined;
    if (!wasOpen) {
      doc.text = msg.text;
      if (rec?.live) this.notifyOpen(rec, doc);
    } else if (msg.text !== doc.text) {
      this.acceptText(doc, msg.text, rec);
    }
    if (!rec) return { serverKey: null, state: 'no-root' };
    this.touch(rec);
    return { serverKey: rec.key, state: rec.state };
  }

  private change(client: ClientKey, msg: LspMessage<'lsp:change'>): { ok: boolean } {
    const doc = this.docs.get(msg.path);
    const entry = doc?.clients.get(client);
    if (!doc || !entry) return { ok: false };
    entry.version = msg.version;
    entry.text = msg.text;
    if (msg.text !== doc.text) {
      this.acceptText(doc, msg.text, doc.serverKey ? this.servers.get(doc.serverKey) : undefined);
    }
    return { ok: true };
  }

  private close(client: ClientKey, msg: LspMessage<'lsp:close'>): { ok: boolean } {
    const doc = this.docs.get(msg.path);
    const entry = doc?.clients.get(client);
    if (!doc || !entry) return { ok: false };
    entry.refs--;
    if (entry.refs <= 0) doc.clients.delete(client);
    this.afterRefsDropped(doc);
    return { ok: true };
  }

  private acceptText(doc: DocEntry, text: string, rec: ServerRecord | undefined): void {
    doc.text = text;
    doc.lspVersion++;
    if (rec?.live) {
      rec.handle?.notify('textDocument/didChange', {
        textDocument: { uri: pathToFileUri(doc.path), version: doc.lspVersion },
        contentChanges: [{ text }],
      });
    }
  }

  private afterRefsDropped(doc: DocEntry): void {
    if (this.totalRefs(doc) > 0) return;
    this.docs.delete(doc.path);
    const rec = doc.serverKey ? this.servers.get(doc.serverKey) : undefined;
    if (!rec) return;
    if (rec.live) {
      rec.handle?.notify('textDocument/didClose', {
        textDocument: { uri: pathToFileUri(doc.path) },
      });
    }
    this.armIdle(rec);
  }

  private totalRefs(doc: DocEntry): number {
    let n = 0;
    for (const c of doc.clients.values()) n += c.refs;
    return n;
  }

  private notifyOpen(rec: ServerRecord, doc: DocEntry): void {
    rec.handle?.notify('textDocument/didOpen', {
      textDocument: {
        uri: pathToFileUri(doc.path),
        languageId: doc.spec.languageId,
        version: doc.lspVersion,
        text: doc.text,
      },
    });
  }

  /** resolveRoot first, then the out-of-root origin LRU (spec §2.3); ensures the record. */
  private async keyFor(path: string, spec: LanguageServerSpec): Promise<string | null> {
    const root = await this.deps.resolveRoot(path, spec);
    if (root) return this.ensureRecord(root, spec).key;
    const origin = this.originLru.get(path);
    return origin !== undefined && this.servers.has(origin) ? origin : null;
  }

  // ---------- servers ----------

  private ensureRecord(root: ServerRoot, spec: LanguageServerSpec): ServerRecord {
    const existing = this.servers.get(root.key);
    if (existing) return existing;
    const rec: ServerRecord = {
      key: root.key,
      spec,
      realRoot: root.realRoot,
      lexicalRoot: root.root,
      adHoc: root.adHoc,
      state: 'stopped',
      progress: undefined,
      handle: null,
      live: false,
      stopping: false,
      generation: 0,
      restartHistory: [],
      restartTimer: null,
      idleTimer: null,
      watcher: null,
      waiters: new Set(),
    };
    this.servers.set(root.key, rec);
    return rec;
  }

  /** Any open or request for the key: cancel the idle stop and (re)start what isn't running. */
  private touch(rec: ServerRecord): void {
    if (rec.idleTimer) {
      clearTimeout(rec.idleTimer);
      rec.idleTimer = null;
    }
    if (this.disposed) return;
    const absentExpired =
      rec.state === 'absent' && Date.now() >= (this.absentUntil.get(rec.spec.languageId) ?? 0);
    if (rec.state === 'stopped' || absentExpired) {
      this.setState(rec, 'starting');
      void this.launch(rec);
    }
  }

  private async launch(rec: ServerRecord): Promise<void> {
    if (this.disposed) return;
    const gen = ++rec.generation;
    rec.stopping = false;
    rec.live = false;
    const languageId = rec.spec.languageId;
    const resolved =
      Date.now() < (this.absentUntil.get(languageId) ?? 0)
        ? null
        : await this.deps.resolveBinary(rec.spec);
    if (this.disposed || gen !== rec.generation || rec.stopping) return;
    if (!resolved) {
      if (Date.now() >= (this.absentUntil.get(languageId) ?? 0)) {
        this.absentUntil.set(languageId, Date.now() + ABSENT_TTL_MS);
      }
      this.setState(rec, 'absent');
      return;
    }
    this.absentUntil.delete(languageId);
    const handle = this.deps.startServer({ spec: rec.spec, resolved, root: rec.lexicalRoot });
    rec.handle = handle;
    this.setState(rec, rec.state === 'restarting' ? 'restarting' : 'starting');
    handle.onExit((e) => this.onExit(rec, gen, e));
    handle.onProgress((loading, title) => {
      if (gen !== rec.generation || !rec.live) return;
      this.setState(rec, loading ? 'loading' : 'ready', loading ? title : undefined);
    });
    rec.watcher ??= this.deps.watchRoot(
      rec.lexicalRoot,
      rec.spec,
      (changes) => this.forwardWatched(rec, changes),
      () => this.rehome(rec),
    );
    try {
      await handle.initialized;
    } catch (err) {
      if (this.disposed || gen !== rec.generation || rec.stopping) return;
      this.deps.log.warn(SCOPE, `${rec.spec.binary} failed to initialize`, { error: String(err) });
      rec.generation++;
      rec.handle = null;
      handle.killSync();
      this.crash(rec);
      return;
    }
    if (this.disposed || gen !== rec.generation || rec.stopping) return;
    for (const doc of this.docs.values()) {
      if (doc.serverKey === rec.key && this.totalRefs(doc) > 0) this.notifyOpen(rec, doc);
    }
    rec.live = true;
    this.setState(rec, handle.loading ? 'loading' : 'ready');
  }

  private onExit(
    rec: ServerRecord,
    gen: number,
    e: { code: number | null; signal: string | null; stderrTail: string[] },
  ): void {
    if (gen !== rec.generation) return;
    const wasLive = rec.live;
    rec.live = false;
    rec.handle = null;
    this.deps.log.info(SCOPE, `${rec.spec.binary} exited`, {
      root: rec.lexicalRoot,
      code: e.code,
      signal: e.signal,
      stderr: e.stderrTail.join('\n'),
    });
    if (rec.stopping) {
      if (rec.state !== 'stopped') this.setState(rec, 'stopped');
      return;
    }
    if (this.disposed) return;
    // Exiting before `initialize` completed IS the initialize failure (spec §2.2 → crashed).
    // This exit owns it: the generation bump stops `launch`'s catch from handling it twice.
    const next = wasLive ? nextRestart(rec.restartHistory, Date.now()) : null;
    if (!wasLive) rec.generation++;
    if (!next) {
      this.crash(rec);
      return;
    }
    rec.restartHistory = next.history;
    this.setState(rec, 'restarting');
    rec.restartTimer = setTimeout(() => {
      rec.restartTimer = null;
      void this.launch(rec);
    }, next.delayMs);
  }

  /** Nothing restarts a crashed server but the palette, so its root needs no watching. */
  private crash(rec: ServerRecord): void {
    rec.watcher?.close();
    rec.watcher = null;
    this.setState(rec, 'crashed');
  }

  private hasDocs(rec: ServerRecord): boolean {
    for (const d of this.docs.values()) if (d.serverKey === rec.key) return true;
    return false;
  }

  private armIdle(rec: ServerRecord): void {
    for (const d of this.docs.values())
      if (d.serverKey === rec.key && this.totalRefs(d) > 0) return;
    if (rec.idleTimer) clearTimeout(rec.idleTimer);
    rec.idleTimer = setTimeout(() => {
      rec.idleTimer = null;
      void this.stopRecord(rec);
    }, IDLE_GRACE_MS);
  }

  private async stopRecord(rec: ServerRecord): Promise<void> {
    this.clearTimers(rec);
    rec.stopping = true;
    rec.live = false;
    const handle = rec.handle;
    this.wake(rec);
    if (handle) await handle.stop();
    // A launch that began while the stop was in flight owns the record now.
    if (!rec.stopping) return;
    rec.watcher?.close();
    rec.watcher = null;
    if (rec.state !== 'stopped') this.setState(rec, 'stopped');
    // A stopped record no doc points at is dead weight; the next open recreates it.
    if (!rec.stopping) return;
    if (this.hasDocs(rec)) return;
    if (this.servers.get(rec.key) === rec) this.servers.delete(rec.key);
  }

  private restartLanguage(languageId: string): void {
    this.absentUntil.delete(languageId);
    for (const rec of this.servers.values()) {
      if (rec.spec.languageId !== languageId) continue;
      rec.restartHistory = [];
      if (rec.state !== 'stopped') void this.stopRecord(rec);
    }
  }

  private clearTimers(rec: ServerRecord): void {
    if (rec.idleTimer) clearTimeout(rec.idleTimer);
    if (rec.restartTimer) clearTimeout(rec.restartTimer);
    rec.idleTimer = null;
    rec.restartTimer = null;
  }

  private forwardWatched(rec: ServerRecord, changes: WatchedChange[]): void {
    if (!rec.live) return;
    rec.handle?.notify('workspace/didChangeWatchedFiles', {
      changes: changes.map((c) => ({ uri: pathToFileUri(c.path), type: c.type })),
    });
  }

  /** A root marker changed under this server: recompute keys for its docs (spec §2.2). */
  private rehome(rec: ServerRecord): void {
    for (const doc of [...this.docs.values()]) {
      if (doc.serverKey !== rec.key) continue;
      void this.enqueue(doc.path, async () => {
        const root = await this.deps.resolveRoot(doc.path, doc.spec);
        if (this.disposed || !root || root.key === doc.serverKey) return;
        if (this.docs.get(doc.path) !== doc) return;
        const old = doc.serverKey ? this.servers.get(doc.serverKey) : undefined;
        if (old?.live) {
          old.handle?.notify('textDocument/didClose', {
            textDocument: { uri: pathToFileUri(doc.path) },
          });
        }
        const next = this.ensureRecord(root, doc.spec);
        doc.serverKey = next.key;
        if (next.live) this.notifyOpen(next, doc);
        this.touch(next);
        if (old) this.armIdle(old);
      });
    }
  }

  private setState(rec: ServerRecord, state: LspServerState, progress?: string): void {
    rec.state = state;
    rec.progress = progress;
    this.wake(rec);
    this.deps.broadcastStatus(this.statusOf(rec));
  }

  private wake(rec: ServerRecord): void {
    const waiters = [...rec.waiters];
    rec.waiters.clear();
    for (const w of waiters) w();
  }

  private statusOf(rec: ServerRecord): LspServerStatus {
    const s: LspServerStatus = {
      serverKey: rec.key,
      languageId: rec.spec.languageId,
      root: rec.lexicalRoot,
      state: rec.state,
      pid: rec.handle?.pid ?? null,
    };
    if (rec.progress !== undefined) s.progress = rec.progress;
    return s;
  }

  // ---------- requests (plan finding #8) ----------

  private async request(client: ClientKey, msg: LspMessage<'lsp:request'>): Promise<LspReply> {
    const pendingKey = `${client}:${msg.requestId}`;
    const ac = new AbortController();
    this.pending.set(pendingKey, ac);
    const startedAt = Date.now();
    try {
      const prepared = await this.enqueue(msg.path, () => this.prepareRequest(client, msg));
      if ('kind' in prepared) return prepared;
      const { rec, doc } = prepared;
      const isNav = NAV_OPS.has(msg.op);
      const waitMs = isNav ? NAV_LOADING_TIMEOUT_MS : INIT_WAIT_SHORT_MS;
      const ready = await this.waitLive(rec, startedAt + waitMs, ac.signal);
      if (ac.signal.aborted) return EMPTY;
      if (ready !== 'live') {
        if (ready === 'crashed') return { kind: 'unavailable', reason: 'crashed' };
        if (ready === 'absent') return { kind: 'unavailable', reason: 'missing' };
        return isNav ? { kind: 'unavailable', reason: 'loading-timeout' } : EMPTY;
      }
      return await this.send(client, msg, rec, doc, startedAt, ac.signal);
    } finally {
      this.pending.delete(pendingKey);
    }
  }

  private prepareRequest(
    client: ClientKey,
    msg: LspMessage<'lsp:request'>,
  ): LspReply | { rec: ServerRecord; doc: DocEntry } {
    const doc = this.docs.get(msg.path);
    const entry = doc?.clients.get(client);
    if (!doc || !entry) return EMPTY;
    if (msg.version !== entry.version || entry.text !== doc.text) return { kind: 'stale' };
    const rec = doc.serverKey ? this.servers.get(doc.serverKey) : undefined;
    if (!rec) return { kind: 'unavailable', reason: 'no-root' };
    this.touch(rec);
    if (rec.state === 'crashed') return { kind: 'unavailable', reason: 'crashed' };
    if (rec.state === 'absent') return { kind: 'unavailable', reason: 'missing' };
    return { rec, doc };
  }

  private waitLive(
    rec: ServerRecord,
    deadline: number,
    signal: AbortSignal,
  ): Promise<'live' | 'timeout' | 'crashed' | 'absent'> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (r: 'live' | 'timeout' | 'crashed' | 'absent') => {
        if (timer) clearTimeout(timer);
        rec.waiters.delete(check);
        signal.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const onAbort = () => finish('timeout');
      const check = () => {
        if (rec.live) return finish('live');
        if (rec.state === 'crashed') return finish('crashed');
        if (rec.state === 'absent') return finish('absent');
        if (Date.now() >= deadline || this.disposed) return finish('timeout');
        if (rec.state === 'stopped') {
          // An idle stop means the record's last tab closed: relaunching for this request would
          // start a server no tab holds, on a record that may already be pruned from `servers`.
          if (this.servers.get(rec.key) !== rec || !this.hasDocs(rec)) return finish('timeout');
          // An ordered stop finished under this request: it still wants an answer, so it starts
          // the server again rather than waiting out its whole budget on one that is gone.
          rec.waiters.add(check);
          this.touch(rec);
          return;
        }
        rec.waiters.add(check);
      };
      timer = setTimeout(() => finish('timeout'), Math.max(0, deadline - Date.now()));
      signal.addEventListener('abort', onAbort);
      check();
    });
  }

  private async send(
    client: ClientKey,
    msg: LspMessage<'lsp:request'>,
    rec: ServerRecord,
    doc: DocEntry,
    startedAt: number,
    signal: AbortSignal,
  ): Promise<LspReply> {
    const handle = rec.handle;
    if (!handle) return { kind: 'unavailable', reason: 'server-error' };
    const isNav = NAV_OPS.has(msg.op);
    const loadingAtSend = rec.state === 'loading';
    const timeoutMs = isNav
      ? loadingAtSend
        ? Math.max(1, startedAt + NAV_LOADING_TIMEOUT_MS - Date.now())
        : NAV_TIMEOUT_MS
      : msg.op === 'hover'
        ? HOVER_TIMEOUT_MS
        : SYMBOLS_TIMEOUT_MS;
    const textDocument = { uri: pathToFileUri(msg.path) };
    const position = { line: msg.line, character: msg.character };
    const params =
      msg.op === 'documentSymbol'
        ? { textDocument }
        : msg.op === 'references'
          ? { textDocument, position, context: { includeDeclaration: true } }
          : { textDocument, position };
    let result: unknown;
    try {
      result = await handle.request(LSP_METHOD[msg.op], params, { timeoutMs, signal });
    } catch (err) {
      const reason = err instanceof LspRequestError ? err.reason : 'server-error';
      if (reason === 'cancelled') return EMPTY;
      if (reason === 'timeout') {
        return {
          kind: 'unavailable',
          reason: isNav && loadingAtSend ? 'loading-timeout' : 'timeout',
        };
      }
      return { kind: 'unavailable', reason: 'server-error', detail: String(err) };
    }
    if (msg.op === 'hover') {
      const hover = toHover(result as Parameters<typeof toHover>[0]);
      return hover ? { kind: 'hover', ...hover } : EMPTY;
    }
    if (msg.op === 'documentSymbol') {
      const base = (this.deps.platform === 'win32' ? win32 : posix).basename(doc.path);
      return {
        kind: 'symbols',
        tree: toNavTree(result as Parameters<typeof toNavTree>[0], doc.text, base),
      };
    }
    return this.locationsReply(client, rec, result as Parameters<typeof toLocations>[0]);
  }

  private async locationsReply(
    client: ClientKey,
    rec: ServerRecord,
    result: Parameters<typeof toLocations>[0],
  ): Promise<LspReply> {
    const locations = toLocations(result).map((l) => ({
      path: toLexicalPath(l.path, rec.realRoot, rec.lexicalRoot, this.deps.platform),
      range: l.range,
    }));
    if (locations.length === 0) return { kind: 'empty', adHocRoot: rec.adHoc };
    for (const l of locations) this.rememberOrigin(l.path, rec.key);
    const distinct = [...new Set(locations.map((l) => l.path))].filter(
      (p) => !this.docs.get(p)?.clients.has(client),
    );
    const targets: { path: string; text: string }[] = [];
    let dropped = Math.max(0, distinct.length - TARGETS_MAX);
    for (const path of distinct.slice(0, TARGETS_MAX)) {
      const text = await this.deps.readTarget(path);
      if (text === null) dropped++;
      else targets.push({ path, text });
    }
    return { kind: 'locations', locations, targets, dropped };
  }

  private rememberOrigin(path: string, key: string): void {
    this.originLru.delete(path);
    this.originLru.set(path, key);
    if (this.originLru.size > ORIGIN_LRU_MAX) {
      const oldest = this.originLru.keys().next().value;
      if (oldest !== undefined) this.originLru.delete(oldest);
    }
  }
}
