import type { ScreenSnapshot } from '../../src/conduit-mcp/screen-verdict';
import type { DisplayFacts, TerminalEndReason } from '../../src/contracts/frames';
import {
  HC_PINNED_VERSION,
  type HcClient,
  type HcEvent,
  type HcMethods,
  type HcNotification,
  type HcStatus,
  type HcStream,
  type HcStreamEnd,
  type HcTerminal,
  isCompatibleCore,
} from '../../src/contracts/hc';
import type { TokenStorePort } from '../../src/contracts/server-ports';
import type { RuntimeHealth } from '../../src/contracts/server-protocol';
import type { ConduitLabels, TokenRecord } from '../../src/contracts/session-identity';
import {
  type AdoptedTerminal,
  LAUNCH_SETTLE_ON_STOP_MS,
  type LaunchIds,
  type ReportedStatus,
  type RuntimeEvent,
  type RuntimeExitReason,
  type RuntimeTerminal,
  SERVER_REATTACH_HISTORY_LINES,
  type SpawnResult,
  type TerminalRuntime,
} from '../../src/contracts/terminal-runtime';
import { HcDisconnectedError, HcRpcError } from '../../src/hc-client';
import { lastNonEmptyLines } from '../../src/last-line';
import type { TermGeometry } from '../../src/protocol';
import { appendScrollback } from '../../src/scrollback-persistence';
import type { SpawnSpec } from '../../src/types';
import { ServerScreens } from './screens';

/** What the runtime records into: the ring, on the credit path (D18). */
export interface RuntimeRing {
  append(sessionId: string, data: string, size: TermGeometry | undefined): void;
  gap(sessionId: string, paint: string, size: TermGeometry): void;
}

export interface HcRuntimeDeps {
  hc: HcClient;
  tokens: TokenStorePort;
  ring: RuntimeRing;
  /** C4 InstanceNames: the subscription filter and every AttachTarget. */
  instance: string;
  hcSession: string;
  appVersion: string;
  logPath: string;
  log(message: string): void;
  launchSettleMs?: number;
  screenBacklogMaxBytes?: number;
}

/** Same bound as today's PtyHost lastLine tail. */
const TAIL_CHARS = 4096;

interface Tracked {
  sessionId: string;
  generation: number;
  launchId: string;
  address: string;
  size: TermGeometry;
  stream?: HcStream;
  ended: boolean;
  /** An in-place restart's kill: its exit is not reported (C1 `retire`). */
  retiring: boolean;
  /** `spawned` went out: the first active attach; re-attaches don't repeat it. */
  announced: boolean;
}

interface AttachPlan {
  resumed: boolean;
  size: TermGeometry;
  cause: 'attach' | 'gap';
  /** Whether the paint joins the ring; a reseed's repaint duplicates what the ring holds. */
  recordPaint: boolean;
}

const isNotFound = (error: unknown) => error instanceof HcRpcError && error.kind === 'not_found';
const isFinishedRefusal = (error: unknown) =>
  error instanceof HcRpcError && error.kind === 'finished';

export function exitReasonOf(reason: TerminalEndReason | 'spawn_pending' | null | undefined) {
  if (reason === 'exited') return 'exited' satisfies RuntimeExitReason;
  if (reason === 'holder_lost') return 'lost' satisfies RuntimeExitReason;
  return 'killed' satisfies RuntimeExitReason;
}

/** Wire words → C1 (three-process-architecture §hc invariants); any other word is no status. */
export function mapStatus(status: HcStatus | null | undefined): ReportedStatus {
  if (!status) return null;
  const app = status.app === undefined ? {} : { app: status.app };
  switch (status.state) {
    case 'idle':
    case 'working':
    case 'done':
    case 'error':
      return {
        state: status.state,
        ...app,
        ...(status.progress === undefined ? {} : { progress: status.progress }),
      };
    case 'blocked': {
      const kind = status.kind;
      return {
        state: 'blocked',
        kind: kind === 'permission' || kind === 'question' || kind === 'auth' ? kind : null,
        ...app,
      };
    }
    default:
      return null;
  }
}

function asLabels(labels: Record<string, string>): ConduitLabels {
  const role = labels['conduit.role'];
  return {
    'conduit.session': labels['conduit.session'] ?? '',
    'conduit.instance': labels['conduit.instance'] ?? '',
    'conduit.generation': labels['conduit.generation'] ?? '',
    'conduit.launch': labels['conduit.launch'] ?? '',
    ...(role === 'session' || role === 'server' ? { 'conduit.role': role } : {}),
  };
}

/** `terminal.read` is plain text; the ring holds terminal bytes. */
const asTerminalText = (text: string) => text.replace(/\r?\n/g, '\r\n');

export class HcTerminalRuntime implements TerminalRuntime {
  readonly screens: ServerScreens;
  private readonly sessions = new Map<string, Tracked>();
  private readonly byAddress = new Map<string, Tracked>();
  private readonly lastSize = new Map<string, TermGeometry>();
  private readonly lastFacts = new Map<string, DisplayFacts>();
  private readonly tails = new Map<string, string>();
  /** launchId → sessionId of every spawn this process has in flight (C1 reconcile step 2). */
  private readonly inFlight = new Map<string, string>();
  private readonly pending = new Set<Promise<unknown>>();
  /** In-flight launches the stopping transition already settled, and how. */
  private readonly settled = new Map<string, 'restart' | 'stopAll'>();
  private readonly unconfirmed = new Map<string, string>();
  private readonly listeners = new Set<(e: RuntimeEvent) => void>();
  private readonly healthListeners = new Set<(h: RuntimeHealth) => void>();
  private stopping: 'restart' | 'stopAll' | undefined;
  private clean = false;
  private sub?: { close(): void };
  private resyncing?: Promise<void>;
  private resyncAgain = false;
  private hcVersion = HC_PINNED_VERSION;
  private coreReplaced = false;
  private incompatible = false;
  private tokenStoreUnreadable = false;
  private readonly offConnection: () => void;

  constructor(private readonly deps: HcRuntimeDeps) {
    this.screens = new ServerScreens({
      sizeOf: (id) => this.sessions.get(id)?.size ?? this.lastSize.get(id),
      reseed: (id) => setImmediate(() => void this.reseed(id)),
      maxBacklog: deps.screenBacklogMaxBytes,
    });
    this.offConnection = deps.hc.onConnection((state, hello) => {
      if (hello) {
        this.hcVersion = hello.version;
        this.incompatible = !isCompatibleCore(hello);
        if (state === 'reconnected') this.coreReplaced = hello.version !== HC_PINNED_VERSION;
      }
      if (state === 'reconnected') this.resync();
      this.publishHealth();
    });
  }

  /** ShellCore.start: subscribe first, so a launch registering later arrives as `created` (D21). */
  async start(): Promise<RuntimeHealth> {
    await this.subscribe();
    await this.reconcile();
    return this.health();
  }

  health(): RuntimeHealth {
    if (this.incompatible)
      return {
        state: 'unavailable',
        reason: 'terminal engine update pending',
        logPath: this.deps.logPath,
      };
    if (this.tokenStoreUnreadable)
      return { state: 'degraded', reason: 'token store unreadable', hcVersion: this.hcVersion };
    if (this.coreReplaced)
      return { state: 'degraded', reason: 'core replaced', hcVersion: this.hcVersion };
    return { state: 'ready', hcVersion: this.hcVersion };
  }

  onHealth(listener: (h: RuntimeHealth) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  /** ShellCore.idleState's live count: every live terminal of ours but the supervisor's (F4). */
  async liveTerminals(): Promise<number> {
    const { terminals } = await this.deps.hc.call('terminal.list', {});
    return terminals.filter((t) => t.labels['conduit.role'] !== 'server').length;
  }

  /** ShellCore.killSessions (F12 step 3): every `conduit.role=session` terminal of this instance. */
  async killSessions(): Promise<number> {
    const { terminals } = await this.deps.hc.call('terminal.list', {
      labels: { 'conduit.instance': this.deps.instance, 'conduit.role': 'session' },
    });
    await Promise.all(terminals.map((t) => this.killAddress(t.address, 'stop all')));
    return terminals.length;
  }

  async reconcile(): Promise<AdoptedTerminal[]> {
    const rows = this.deps.tokens.rows();
    if (rows.state === 'unreadable' || (rows.state === 'missing' && (await this.labelledLive()))) {
      this.clean = false;
      this.tokenStoreUnreadable = true;
      this.publishHealth();
      return [];
    }
    this.clean = true;
    this.tokenStoreUnreadable = false;
    this.publishHealth();
    const all = rows.state === 'loaded' ? rows.rows : [];
    const mine = (state: TokenRecord['state']) =>
      all.filter((r) => r.state === state && !this.inFlight.has(r.launchId));
    const adopted: AdoptedTerminal[] = [];
    for (const row of mine('live')) {
      const found = await this.lookup(row.hcAddress ?? '');
      const record = found && found.name === row.launchId ? found : undefined;
      if (!record) {
        const t = this.sessions.get(row.sessionId);
        if (t?.launchId === row.launchId) this.recordExit(t, null, 'lost');
        else this.emit({ type: 'exit', ...ofRow(row), code: null, reason: 'lost' });
        await this.deps.tokens.revoke({ launchId: row.launchId });
        continue;
      }
      const result = await this.adopt(row, record, 'gap');
      if (result) adopted.push(result);
    }
    for (const row of [...mine('reserved'), ...mine('unconfirmed')]) {
      const record = await this.lookup(row.launchId);
      if (!record) {
        if (row.state === 'reserved') await this.deps.tokens.markUnconfirmed(row.launchId);
        // Every reconcile, so a restarted server's domain can offer Retry launch / Discard.
        this.markUnconfirmedEvent(row);
        continue;
      }
      await this.deps.tokens.resolveAddress(row.launchId, record.address);
      const result = await this.adopt(row, record, 'attach');
      if (result) adopted.push(result);
    }
    for (const row of mine('superseded')) {
      const record = await this.lookup(row.launchId);
      if (!record) continue;
      if (record.state === 'live') await this.killAddress(record.address, 'superseded launch');
      else await this.remove(record.address);
      await this.deps.tokens.revoke({ launchId: row.launchId });
    }
    await this.killOrphans();
    return adopted;
  }

  async spawn(
    sessionId: string,
    spec: SpawnSpec,
    labels: ConduitLabels,
    ids: LaunchIds,
  ): Promise<SpawnResult> {
    if (this.stopping) return { ok: false, refusal: { reason: 'server_stopping' } };
    this.inFlight.set(ids.launchId, sessionId);
    const work = this.runSpawn(sessionId, spec, labels, ids);
    this.pending.add(work);
    try {
      return await work;
    } finally {
      this.pending.delete(work);
      this.inFlight.delete(ids.launchId);
      this.settled.delete(ids.launchId);
    }
  }

  async discardLaunch(sessionId: string, launchId: string): Promise<void> {
    if (this.unconfirmed.get(sessionId) === launchId) this.unconfirmed.delete(sessionId);
    await this.deps.tokens.revoke({ launchId });
  }

  async beginStopping(mode: 'restart' | 'stopAll'): Promise<void> {
    if (this.stopping !== 'stopAll') this.stopping = mode;
    const unsettled = [...this.pending];
    if (unsettled.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(unsettled),
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.deps.launchSettleMs ?? LAUNCH_SETTLE_ON_STOP_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    for (const launchId of this.inFlight.keys()) {
      if (this.settled.get(launchId) === mode) continue;
      this.settled.set(launchId, mode);
      if (mode === 'restart') await this.deps.tokens.markUnconfirmed(launchId);
      else await this.deps.tokens.markSuperseded(launchId);
    }
    if (mode !== 'stopAll') return;
    const rows = this.deps.tokens.rows();
    if (rows.state !== 'loaded') return;
    for (const row of rows.rows)
      if (row.state === 'unconfirmed') await this.deps.tokens.markSuperseded(row.launchId);
  }

  input(sessionId: string, generation: number, data: string): boolean {
    const t = this.sessions.get(sessionId);
    if (!t?.stream || t.generation !== generation) return false;
    try {
      t.stream.write(Buffer.from(data, 'utf8'));
      return true;
    } catch (error) {
      this.deps.log(`runtime: input to ${sessionId} failed: ${String(error)}`);
      return false;
    }
  }

  resize(sessionId: string, size: TermGeometry): void {
    this.lastSize.set(sessionId, size);
    const t = this.sessions.get(sessionId);
    if (!t) return;
    t.size = size;
    this.screens.resize(sessionId, size);
    try {
      t.stream?.resize(size.cols, size.rows);
    } catch (error) {
      this.deps.log(`runtime: resize of ${sessionId} failed: ${String(error)}`);
    }
  }

  facts(sessionId: string, facts: DisplayFacts): void {
    this.lastFacts.set(sessionId, facts);
    try {
      this.sessions.get(sessionId)?.stream?.facts(facts);
    } catch (error) {
      this.deps.log(`runtime: facts for ${sessionId} failed: ${String(error)}`);
    }
  }

  get(sessionId: string): RuntimeTerminal | undefined {
    const t = this.sessions.get(sessionId);
    return t && this.view(t);
  }

  screen(sessionId: string): Promise<ScreenSnapshot | null> {
    return this.screens.snapshot(sessionId);
  }

  tailLines(sessionId: string, n: number): string[] {
    return lastNonEmptyLines(this.tails.get(sessionId) ?? '', n);
  }

  async kill(sessionId: string): Promise<void> {
    const t = this.sessions.get(sessionId);
    if (t) await this.killAddress(t.address, 'kill');
  }

  async retire(sessionId: string): Promise<void> {
    const t = this.sessions.get(sessionId);
    if (!t) return;
    t.retiring = true;
    await this.killAddress(t.address, 'retire');
  }

  async close(): Promise<void> {
    this.offConnection();
    this.sub?.close();
    for (const t of this.sessions.values()) t.stream?.close();
    this.deps.hc.close();
  }

  on(listener: (e: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async runSpawn(
    sessionId: string,
    spec: SpawnSpec,
    labels: ConduitLabels,
    ids: LaunchIds,
  ): Promise<SpawnResult> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.env ?? {})) if (!/^HC_/i.test(k)) env[k] = v;
    // hc defaults to ghostty and answers XTVERSION with it (M10).
    env.TERM_PROGRAM = 'conduit';
    env.TERM_PROGRAM_VERSION = this.deps.appVersion;
    let record: HcMethods['terminal.run']['result'];
    try {
      record = await this.deps.hc.call('terminal.run', {
        argv: [spec.command, ...spec.args],
        cwd: spec.cwd,
        env,
        labels: { ...labels },
        name: ids.launchId,
        keep: false,
        no_parent: true,
        no_notify: true,
      });
    } catch (error) {
      if (!(error instanceof HcDisconnectedError)) {
        // hc refused the run outright: nothing can register under this launch id.
        await this.deps.tokens.revoke({ launchId: ids.launchId });
        throw error;
      }
      if (!this.settled.has(ids.launchId)) {
        await this.deps.tokens.markUnconfirmed(ids.launchId);
        this.markUnconfirmedEvent({ sessionId, ...ids });
      }
      return { ok: false, refusal: { reason: 'spawn_unconfirmed', launchId: ids.launchId } };
    }
    const settledBy = this.settled.get(ids.launchId);
    if (settledBy === 'stopAll') {
      await this.killAddress(record.address, 'launch replied after stop all');
      await this.deps.tokens.revoke({ launchId: ids.launchId });
    }
    // A restart's replacement adopts it by name from its unconfirmed row.
    if (settledBy) return { ok: false, refusal: { reason: 'server_stopping' } };
    await this.deps.tokens.resolveAddress(ids.launchId, record.address);
    const t = this.track(sessionId, ids, record.address, {
      cols: record.cols,
      rows: record.rows,
    });
    const size = this.lastSize.get(sessionId) ?? t.size;
    const attached =
      record.state === 'live' &&
      (await this.attach(t, {
        resumed: false,
        size,
        cause: 'attach',
        recordPaint: true,
      }));
    if (!attached) {
      const finished = await this.finishUnattached(t);
      return { ok: true, launchId: ids.launchId, finished };
    }
    return { ok: true, terminal: this.view(t) };
  }

  /** true: attached (or the connection dropped, and reconcile re-attaches); false: it finished. */
  private async attach(t: Tracked, plan: AttachPlan): Promise<boolean> {
    let attached: Awaited<ReturnType<HcClient['attach']>>;
    try {
      attached = await this.deps.hc.attach({
        terminal: t.address,
        cols: plan.size.cols,
        rows: plan.size.rows,
        ...(plan.resumed ? { resumed: true, history: SERVER_REATTACH_HISTORY_LINES } : {}),
        ...this.display(t.sessionId),
      });
    } catch (error) {
      if (isFinishedRefusal(error)) return false;
      if (error instanceof HcDisconnectedError) return true;
      throw error;
    }
    if (t.ended) {
      attached.stream.close();
      return true;
    }
    const { stream } = attached;
    const previous = t.stream;
    t.stream = stream;
    t.size = plan.size;
    previous?.close();
    if (!t.announced) {
      t.announced = true;
      this.emit({
        type: 'spawned',
        sessionId: t.sessionId,
        generation: t.generation,
        size: t.size,
      });
    }
    this.wire(t, stream, plan);
    return true;
  }

  private wire(t: Tracked, stream: HcStream, plan: AttachPlan): void {
    const decoder = new TextDecoder();
    // D20: hc has no end-of-paint marker yet; until M8 fixes a rule, a paint is the bytes
    // that arrive before the event loop turns over after the first one.
    let paint: string[] | undefined = [];
    let paintTimer: ReturnType<typeof setImmediate> | undefined;
    const endPaint = () => {
      if (!paint) return;
      const data = paint.join('');
      paint = undefined;
      clearImmediate(paintTimer);
      if (t.ended && t.stream !== stream) return;
      this.screens.paint(t.sessionId, data, plan.size);
      this.emit({
        type: 'paint',
        sessionId: t.sessionId,
        generation: t.generation,
        data,
        size: plan.size,
        cause: plan.cause,
      });
    };
    stream.onData((bytes) => {
      const text = decoder.decode(bytes, { stream: true });
      if (paint) {
        if (plan.recordPaint) {
          if (plan.cause === 'gap' && paint.length === 0)
            this.deps.ring.gap(t.sessionId, text, plan.size);
          else this.deps.ring.append(t.sessionId, text, plan.size);
        }
        paint.push(text);
        stream.credit(bytes.byteLength);
        clearImmediate(paintTimer);
        paintTimer = setImmediate(endPaint);
        return;
      }
      this.deps.ring.append(t.sessionId, text, t.size);
      stream.credit(bytes.byteLength);
      this.tails.set(
        t.sessionId,
        appendScrollback(this.tails.get(t.sessionId) ?? '', text, TAIL_CHARS),
      );
      this.screens.feed(t.sessionId, text);
      this.emit({ type: 'data', sessionId: t.sessionId, generation: t.generation, data: text });
    });
    stream.onClose((end) => {
      endPaint();
      if (t.stream !== stream) return;
      t.stream = undefined;
      this.streamEnded(t, end);
    });
  }

  private streamEnded(t: Tracked, end: HcStreamEnd): void {
    // `detached` is our own close; `disconnected` waits for the reconnect's reconcile (F10).
    if (end.reason === 'detached' || end.reason === 'disconnected') return;
    this.recordExit(t, end.exit_code ?? null, exitReasonOf(end.reason));
  }

  /** C1: an ended program's output is only in `terminal.read`; record it and its exit at once. */
  private async finishUnattached(t: Tracked): Promise<{
    exitCode: number | null;
    reason: RuntimeExitReason;
  }> {
    let exitCode: number | null = null;
    let reason: RuntimeExitReason = 'lost';
    try {
      const record = await this.deps.hc.call('terminal.get', { terminal: t.address });
      exitCode = record.exit_code ?? null;
      reason = exitReasonOf(record.reason);
      const read = await this.deps.hc.call('terminal.read', {
        terminal: t.address,
        lines: SERVER_REATTACH_HISTORY_LINES,
      });
      if (read.text) this.deps.ring.append(t.sessionId, asTerminalText(read.text), t.size);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    this.recordExit(t, exitCode, reason);
    return { exitCode, reason };
  }

  private recordExit(t: Tracked, code: number | null, reason: RuntimeExitReason): void {
    if (t.ended) return;
    t.ended = true;
    if (this.sessions.get(t.sessionId) === t) this.sessions.delete(t.sessionId);
    if (this.byAddress.get(t.address) === t) this.byAddress.delete(t.address);
    this.tails.delete(t.sessionId);
    if (!t.retiring)
      this.emit({ type: 'exit', sessionId: t.sessionId, generation: t.generation, code, reason });
    if (reason !== 'lost') void this.remove(t.address);
  }

  private async adopt(
    row: TokenRecord,
    record: HcTerminal,
    cause: 'attach' | 'gap',
  ): Promise<AdoptedTerminal | undefined> {
    if (this.unconfirmed.get(row.sessionId) === row.launchId)
      this.unconfirmed.delete(row.sessionId);
    const existing = this.byAddress.get(record.address);
    const t =
      existing ??
      this.track(row.sessionId, row, record.address, { cols: record.cols, rows: record.rows });
    if (existing?.stream) return undefined;
    const size = { cols: record.cols, rows: record.rows };
    const attached =
      record.state === 'live' &&
      (await this.attach(t, {
        resumed: true,
        size,
        cause,
        recordPaint: true,
      }));
    if (!attached) {
      await this.finishUnattached(t);
      return undefined;
    }
    return { ...this.view(t), labels: asLabels(record.labels) };
  }

  private async reseed(sessionId: string): Promise<void> {
    const t = this.sessions.get(sessionId);
    if (!t?.stream) return;
    try {
      await this.attach(t, {
        resumed: false,
        size: t.size,
        cause: 'attach',
        recordPaint: false,
      });
    } catch (error) {
      this.deps.log(`runtime: screen reseed of ${sessionId} failed: ${String(error)}`);
    }
  }

  private track(sessionId: string, ids: LaunchIds, address: string, size: TermGeometry): Tracked {
    const t: Tracked = {
      sessionId,
      generation: ids.generation,
      launchId: ids.launchId,
      address,
      size,
      ended: false,
      retiring: false,
      announced: false,
    };
    this.sessions.set(sessionId, t);
    this.byAddress.set(address, t);
    return t;
  }

  private view(t: Tracked): RuntimeTerminal {
    return {
      sessionId: t.sessionId,
      generation: t.generation,
      launchId: t.launchId,
      state: 'live',
      size: t.size,
      target: { hcSession: this.deps.hcSession, terminal: t.address },
    };
  }

  private display(sessionId: string): { display?: DisplayFacts } {
    const facts = this.lastFacts.get(sessionId);
    return facts ? { display: facts } : {};
  }

  private markUnconfirmedEvent(row: { sessionId: string; generation: number; launchId: string }) {
    this.unconfirmed.set(row.sessionId, row.launchId);
    this.emit({
      type: 'unconfirmed',
      sessionId: row.sessionId,
      generation: row.generation,
      launchId: row.launchId,
    });
  }

  private async subscribe(): Promise<void> {
    this.sub?.close();
    this.sub = await this.deps.hc.subscribe(
      { labels: { 'conduit.instance': this.deps.instance } },
      (n) => this.notified(n),
    );
  }

  private resync(): void {
    if (this.resyncing) {
      this.resyncAgain = true;
      return;
    }
    this.resyncing = (async () => {
      do {
        this.resyncAgain = false;
        try {
          await this.subscribe();
          await this.reconcile();
          this.emit({ type: 'resynced' });
        } catch (error) {
          this.deps.log(`runtime: resync failed: ${String(error)}`);
        }
      } while (this.resyncAgain);
    })().finally(() => {
      this.resyncing = undefined;
    });
  }

  private notified(n: HcNotification): void {
    if (n.method === 'missed' || n.method === 'ended') this.resync();
    else if (n.method === 'event')
      void this.event(n.params).catch((error) =>
        this.deps.log(`runtime: hc event failed: ${String(error)}`),
      );
  }

  private async event(e: HcEvent): Promise<void> {
    if (e.type === 'created') return this.created(e.data);
    if (e.type === 'unknown') return;
    const t = this.byAddress.get(e.terminal);
    if (!t) return;
    if (e.type === 'finished' || e.type === 'lost') {
      // With a stream, its CLOSE carries the end; without one (a reconnect pending) this does.
      if (!t.stream) this.recordExit(t, e.data.exit_code, exitReasonOf(e.data.reason));
    } else if (e.type === 'status')
      this.emit({
        type: 'status',
        sessionId: t.sessionId,
        status: e.data.reported ? mapStatus(e.data.status) : null,
      });
    else if (e.type === 'title')
      this.emit({ type: 'title', sessionId: t.sessionId, title: e.data.title });
    else if (e.type === 'size') {
      t.size = { cols: e.data.cols, rows: e.data.rows };
      this.emit({ type: 'size', sessionId: t.sessionId, size: t.size });
    } else if (e.type === 'foreground')
      this.emit({ type: 'foreground', sessionId: t.sessionId, foreground: e.data });
  }

  /** Late confirmation, a superseded launch's late terminal, or an orphan (C1 reconcile, D21). */
  private async created(record: HcTerminal): Promise<void> {
    if (record.labels['conduit.role'] !== 'session' || !this.clean) return;
    const launchId = record.name ?? record.labels['conduit.launch'];
    if (!launchId || this.inFlight.has(launchId) || this.byAddress.has(record.address)) return;
    const rows = this.deps.tokens.rows();
    if (rows.state !== 'loaded') return;
    const row = rows.rows.find((r) => r.launchId === launchId);
    if (!row) return this.killAddress(record.address, 'no token row');
    if (row.state === 'superseded') {
      await this.killAddress(record.address, 'superseded launch');
      await this.deps.tokens.revoke({ launchId });
      return;
    }
    if (row.state === 'live') return;
    await this.deps.tokens.resolveAddress(launchId, record.address);
    if (this.unconfirmed.get(row.sessionId) === launchId) this.unconfirmed.delete(row.sessionId);
    const t = this.track(row.sessionId, row, record.address, {
      cols: record.cols,
      rows: record.rows,
    });
    const attached =
      record.state === 'live' &&
      (await this.attach(t, {
        resumed: false,
        size: this.lastSize.get(row.sessionId) ?? t.size,
        cause: 'attach',
        recordPaint: true,
      }));
    if (!attached) await this.finishUnattached(t);
  }

  private async killOrphans(): Promise<void> {
    const rows = this.deps.tokens.rows();
    if (rows.state !== 'loaded' && rows.state !== 'missing') return;
    const known = new Set(rows.state === 'loaded' ? rows.rows.map((r) => r.launchId) : []);
    const { terminals } = await this.deps.hc.call('terminal.list', {
      labels: { 'conduit.instance': this.deps.instance, 'conduit.role': 'session' },
    });
    for (const t of terminals) {
      const launchId = t.name ?? t.labels['conduit.launch'] ?? '';
      if (known.has(launchId) || this.inFlight.has(launchId) || this.byAddress.has(t.address))
        continue;
      await this.killAddress(t.address, 'no token row');
    }
  }

  private async labelledLive(): Promise<boolean> {
    const { terminals } = await this.deps.hc.call('terminal.list', {
      labels: { 'conduit.instance': this.deps.instance, 'conduit.role': 'session' },
    });
    return terminals.length > 0;
  }

  private async lookup(terminal: string): Promise<HcTerminal | undefined> {
    if (!terminal) return undefined;
    try {
      return await this.deps.hc.call('terminal.get', { terminal });
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private async killAddress(address: string, why: string): Promise<void> {
    this.deps.log(`runtime: kill ${address} (${why})`);
    try {
      await this.deps.hc.call('terminal.kill', { terminal: address });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  private async remove(address: string): Promise<void> {
    try {
      await this.deps.hc.call('terminal.rm', { terminal: address });
    } catch (error) {
      if (!isNotFound(error)) this.deps.log(`runtime: rm ${address} failed: ${String(error)}`);
    }
  }

  private publishHealth(): void {
    const health = this.health();
    for (const listener of this.healthListeners) listener(health);
  }

  private emit(e: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(e);
      } catch (error) {
        this.deps.log(`runtime: ${e.type} listener threw: ${String(error)}`);
      }
    }
  }
}

function ofRow(row: TokenRecord) {
  return { sessionId: row.sessionId, generation: row.generation };
}
