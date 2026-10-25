import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../src/atomic-write';
import { adapterFor, type McpAdapter, notifiable } from '../src/conduit-mcp/adapters';
import { snapshotAttachment } from '../src/conduit-mcp/attachments';
import {
  type AttentionEvent,
  reduceAttention,
  youAttention,
} from '../src/conduit-mcp/attention-items';
import { isCountedInput, nextDraftState, settleDraft } from '../src/conduit-mcp/draft-input';
import {
  type HandleCounters,
  parseHandleCounters,
  serializeHandleCounters,
} from '../src/conduit-mcp/handles';
import { createMcpServerCore, type ToolCallResult } from '../src/conduit-mcp/json-rpc';
import {
  evaluateEnterRecheck,
  evaluateGate,
  type GateVerdict,
  IDLE_QUIET_MS,
} from '../src/conduit-mcp/notice-gate';
import { type AttentionRaise, createNotifier, type Notifier } from '../src/conduit-mcp/notifier';
import { screenVerdict } from '../src/conduit-mcp/screen-verdict';
import { assignHandle, createSessionRegistry } from '../src/conduit-mcp/session-registry';
import { createMessageStore, type StoreIo } from '../src/conduit-mcp/store';
import { createFsStoreIo } from '../src/conduit-mcp/store-fs';
import { CONDUIT_INSTRUCTIONS, CONDUIT_TOOLS } from '../src/conduit-mcp/tool-schemas';
import {
  type Caller,
  createToolHandlers,
  type DirectoryEntry,
  toToolCallResult,
} from '../src/conduit-mcp/tools';
import {
  type Handle,
  HUMAN_HANDLE,
  type McpAttentionItem,
  type McpUnavailableReason,
  type Presence,
  type ScreenVerdict,
  THREAD_AGENT_LIMIT,
  toolError,
} from '../src/conduit-mcp/types';
import type {
  McpGateState,
  McpSessionBadge,
  McpThreadMessage,
  McpThreadSummary,
  McpUiState,
} from '../src/conduit-mcp/ui-types';
import type { HostPlatform } from '../src/lsp-binary';
import { mcpLaunchWiring, mcpServerCommand } from '../src/mcp-launch';
import type { HostToWebview, WebviewToHost } from '../src/protocol';
import type { PtyHost } from '../src/pty-host';
import type { PtyWriter, SubmitOutcome } from '../src/pty-writer';
import type { SessionActivity } from '../src/session-activity';
import type { SessionManager } from '../src/session-manager';
import { PTY_SETTLE_MS } from '../src/timed-messages';
import type { AgentDefinition, SpawnSpec } from '../src/types';
import {
  createMcpEndpoint,
  type EndpointConnection,
  type McpEndpoint,
} from './conduit-mcp-endpoint';
import type { Logger } from './logger';
import { createSessionScreens, type SessionScreens } from './session-screens';

export interface ConduitMcpHostDeps {
  /** userData/conduit-mcp */
  dir: string;
  endpointPath: string;
  execPath: string;
  shimPath: string;
  platform: HostPlatform;
  e2e: boolean;
  mgr: Pick<SessionManager, 'get' | 'list' | 'setMcp'>;
  pty: Pick<PtyHost, 'isAlive' | 'generation'>;
  writer: PtyWriter;
  activity: Pick<SessionActivity, 'statusOf' | 'lastOutputAt'>;
  messagingOn(): boolean;
  projectName(projectId: string | undefined): string | null;
  broadcast(msg: HostToWebview): void;
  log: Pick<Logger, 'debug' | 'warn' | 'error'>;
  // tests only
  now?: () => number;
  randomToken?: () => string;
  storeIo?: StoreIo;
  screens?: SessionScreens;
  listen?: boolean;
  tickMs?: number;
  createEndpoint?: typeof createMcpEndpoint;
}

export type McpRendererMessage = Extract<WebviewToHost, { type: `mcp:${string}` }>;

export interface ConduitMcpHost {
  start(): Promise<void>;
  /**
   * Resolves once a launch of `def` can be wired: at once for an agent with no adapter, else when
   * start's listen attempt settles, bounded by ENDPOINT_READY_WAIT_MS. A session restored at app
   * start launches before start() has listened; without the wait it would read endpoint-down.
   */
  whenLaunchReady(def: AgentDefinition): Promise<void>;
  prepareLaunch(sessionId: string, def: AgentDefinition, spec: SpawnSpec): SpawnSpec;
  onSpawn(sessionId: string, cols: number, rows: number): void;
  onOutput(sessionId: string, data: string): void;
  onResize(sessionId: string, cols: number, rows: number): void;
  onExit(sessionId: string): void;
  onRendererInput(sessionId: string, data: string): void;
  /** Input the host writes outside the PTY writer (the add-dir paste): it is a draft too. */
  noteHostInput(sessionId: string, data: string): void;
  onSessionDeleted(sessionId: string): Promise<void>;
  refresh(): void;
  uiState(): McpUiState;
  handleRenderer(m: McpRendererMessage, reply: (msg: HostToWebview) => void): Promise<void>;
  tick(): Promise<void>;
  stop(): Promise<void>;
}

const TICK_MS = 500;
const RETENTION_EVERY_MS = 6 * 60 * 60 * 1000;
const BROADCAST_COALESCE_MS = 150;
const MAX_UI_THREADS = 500;
const LAUNCH_DIR = 'launch';
const HANDLES_FILE = 'handles.json';
const VERSION = '1';
/** How long a launch waits for the endpoint (conductor decision; plan Decisions). */
export const ENDPOINT_READY_WAIT_MS = 3_000;

/** Per-session runtime state; the gate's inputs that no other module owns (plan T9.2). */
interface Runtime {
  adapter: McpAdapter | undefined;
  unavailable: McpUnavailableReason | null;
  spawnedAt: number | undefined;
  hasDraft: boolean;
  inputSeq: number;
  lastInputAt: number | undefined;
  lastNoticeAt: number | undefined;
  gate: McpGateState | null;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

const handlePrefix = (h: Handle) => h.replace(/-\d+$/, '');

export function createConduitMcpHost(deps: ConduitMcpHostDeps): ConduitMcpHost {
  const now = deps.now ?? (() => Date.now());
  const randomToken = deps.randomToken ?? (() => randomBytes(32).toString('hex'));
  const store = createMessageStore(deps.storeIo ?? createFsStoreIo(deps.dir));
  const screens = deps.screens ?? createSessionScreens();
  const registry = createSessionRegistry();
  const runtime = new Map<string, Runtime>();
  const conns = new Map<number, EndpointConnection>();
  /** Every connection whose hello token resolved, initialized or not: revoke closes them all. */
  const connSession = new Map<number, string>();
  const launchDir = path.join(deps.dir, LAUNCH_DIR);
  const handlesFile = path.join(deps.dir, HANDLES_FILE);

  let counters: HandleCounters | undefined;
  let loading = true;
  let storeError: string | null = null;
  /** Set by start once the endpoint listens; until then a launch gets no wiring. */
  let endpointReady = false;
  /** start's listen attempt has finished, either way: launch waits end here. */
  let endpointSettled = false;
  const settleWaiters = new Set<() => void>();
  const settleEndpoint = () => {
    endpointSettled = true;
    for (const w of [...settleWaiters]) w();
  };
  let attention: McpAttentionItem[] = [];
  let notifier: Notifier | undefined;
  let endpoint: McpEndpoint | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const rt = (sessionId: string): Runtime => {
    let r = runtime.get(sessionId);
    if (!r) {
      r = {
        adapter: undefined,
        unavailable: null,
        spawnedAt: undefined,
        hasDraft: false,
        inputSeq: 0,
        lastInputAt: undefined,
        lastNoticeAt: undefined,
        gate: null,
      };
      runtime.set(sessionId, r);
    }
    return r;
  };

  const handleOf = (sessionId: string): Handle | undefined => deps.mgr.get(sessionId)?.mcpHandle;
  const sessionOfHandle = (h: Handle): string | null =>
    deps.mgr.list().find((s) => s.mcpHandle === h)?.id ?? null;

  const scheduleBroadcast = () => {
    if (stopped || broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      deps.broadcast({ type: 'mcp:state', state: uiState() });
    }, BROADCAST_COALESCE_MS);
  };

  const dispatch = (e: AttentionEvent) => {
    const next = reduceAttention(attention, e);
    if (next.length !== attention.length || next.some((x, i) => x !== attention[i])) {
      attention = next;
      scheduleBroadcast();
    }
  };

  // Store changes carry no detail, so the clearing events are derived from current state.
  const deriveAttentionFromStore = () => {
    for (const item of attention) {
      if (item.messageId) {
        const status = store.get(item.messageId)?.recipients[item.handle]?.status;
        if (status && status !== 'queued') {
          dispatch({ t: 'status', messageId: item.messageId, handle: item.handle, status });
        }
      }
      if (
        item.reason === 'thread-paused' &&
        item.threadId &&
        store.agentCountSinceHuman(item.threadId) < THREAD_AGENT_LIMIT
      ) {
        dispatch({ t: 'thread-reset', threadId: item.threadId });
      }
    }
  };
  store.onChange(() => {
    deriveAttentionFromStore();
    scheduleBroadcast();
  });

  const loadCounters = (): HandleCounters => {
    if (counters) return counters;
    let text: string | undefined;
    try {
      // Once per run, at the first launch with an adapter (plan Global constraints, sync IO).
      text = fs.readFileSync(handlesFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        deps.log.warn('conduit-mcp', 'handles.json unreadable', { err: String(err) });
      }
    }
    counters = parseHandleCounters(text);
    return counters;
  };

  const presenceOf = (sessionId: string): Presence => {
    if (!deps.pty.isAlive(sessionId)) return 'exited';
    return deps.activity.statusOf(sessionId).busy ? 'busy' : 'idle';
  };

  const directory = (): DirectoryEntry[] =>
    deps.mgr.list().flatMap((s) =>
      s.mcpHandle
        ? [
            {
              handle: s.mcpHandle,
              sessionId: s.id,
              label: s.name,
              agent: handlePrefix(s.mcpHandle),
              project: deps.projectName(s.projectId),
              home: s.home,
              roots: [...s.roots],
              presence: presenceOf(s.id),
              messaging: registry.isLive(s.id) ? 'connected' : 'unavailable',
            },
          ]
        : [],
    );

  const tools = createToolHandlers({
    store,
    directory,
    messagingOn: () => deps.messagingOn(),
    now: () => new Date(now()),
    newId: (prefix) => `${prefix}_${base32(randomBytes(10))}`,
    snapshot: (sender, p) => snapshotAttachment(sender, p),
    onStored: (msg) => {
      if (msg.from === HUMAN_HANDLE) dispatch({ t: 'thread-reset', threadId: msg.threadId });
      scheduleBroadcast();
    },
    onThreadLimit: (threadId, by) => {
      dispatch({ t: 'thread-limit', threadId, handle: by, at: new Date(now()).toISOString() });
    },
    warn: (message, data) => deps.log.warn('conduit-mcp', message, data),
  });

  // ---- gate -------------------------------------------------------------------------------

  const screenOf = async (sessionId: string, adapter: McpAdapter, expect?: string) => {
    const snap = await screens.snapshot(sessionId);
    const verdict: ScreenVerdict = snap ? screenVerdict(adapter.screen, snap, expect) : 'unknown';
    return verdict;
  };

  /** The full gate; precheck and beforeText run exactly this (plan T9.2 "Gate inputs"). */
  const evaluate = async (sessionId: string): Promise<GateVerdict> => {
    const r = rt(sessionId);
    const session = deps.mgr.get(sessionId);
    if (!r.adapter || !session) return { open: false, reason: 'not-running' };
    const screen = await screenOf(sessionId, r.adapter);
    const t = now();
    r.hasDraft = settleDraft({
      hasDraft: r.hasDraft,
      screen,
      now: t,
      lastInputAt: r.lastInputAt,
      quietMs: IDLE_QUIET_MS,
    });
    const verdict = evaluateGate({
      now: t,
      settleMs: PTY_SETTLE_MS,
      messagingOn: deps.messagingOn(),
      paused: session.mcpNoticesPaused === true,
      running: deps.pty.isAlive(sessionId),
      spawnedAt: r.spawnedAt,
      connectionLive: registry.isLive(sessionId),
      busy: deps.activity.statusOf(sessionId).busy,
      lastOutputAt: deps.activity.lastOutputAt(sessionId),
      screen,
      hasDraft: r.hasDraft,
      lastNoticeAt: r.lastNoticeAt,
    });
    const gate: McpGateState = verdict.open ? 'open' : verdict.reason;
    if (r.gate !== gate) {
      r.gate = gate;
      scheduleBroadcast();
    }
    return verdict;
  };

  const submitNotice = async (sessionId: string, text: string): Promise<SubmitOutcome> => {
    const r = rt(sessionId);
    let gen: number | undefined;
    let seq = 0;
    const outcome = await deps.writer.submit(sessionId, text, {
      beforeText: async () => {
        const v = await evaluate(sessionId);
        gen = deps.pty.generation(sessionId);
        seq = r.inputSeq;
        return v.open;
      },
      beforeEnter: async () => {
        const session = deps.mgr.get(sessionId);
        if (!r.adapter || !session) return false;
        const v = evaluateEnterRecheck({
          messagingOn: deps.messagingOn(),
          paused: session.mcpNoticesPaused === true,
          running: deps.pty.isAlive(sessionId),
          sameGeneration: gen !== undefined && deps.pty.generation(sessionId) === gen,
          connectionLive: registry.isLive(sessionId),
          screen: await screenOf(sessionId, r.adapter, text),
          inputSinceText: r.inputSeq !== seq,
        });
        if (!v.open)
          deps.log.debug('conduit-mcp', 'notice withheld', { sessionId, reason: v.reason });
        return v.open;
      },
    });
    if (outcome === 'submitted' || outcome === 'withheld') r.lastNoticeAt = now();
    const handle = handleOf(sessionId);
    if (outcome === 'submitted' && handle) dispatch({ t: 'notice-submitted', handle });
    return outcome;
  };

  const notifierSessions = () =>
    deps.mgr.list().flatMap((s) => {
      const r = runtime.get(s.id);
      if (!s.mcpHandle || !r?.adapter || !notifiable(r.adapter) || r.unavailable) return [];
      return [{ sessionId: s.id, handle: s.mcpHandle, busy: deps.activity.statusOf(s.id).busy }];
    });

  const raise = (item: AttentionRaise) => {
    const messageId = item.kind === 'unsent-notice' ? null : item.messageId;
    dispatch({
      t: 'raise',
      raise: item,
      sessionId: sessionOfHandle(item.handle),
      threadId: messageId ? (store.get(messageId)?.threadId ?? null) : null,
      at: new Date(now()).toISOString(),
    });
  };

  const makeNotifier = () =>
    createNotifier(
      {
        sessions: notifierSessions,
        pending: (h) => store.pending(h),
        precheck: evaluate,
        submit: submitNotice,
        markNoticed: async (h, ids) => {
          for (const id of ids) {
            const r = await store.setStatus(id, h, 'noticed');
            if (!r.ok)
              deps.log.warn('conduit-mcp', 'markNoticed failed', { id, code: r.error.code });
          }
        },
        raise,
      },
      { rearmAll: true },
    );

  // ---- connections ------------------------------------------------------------------------

  const notInSession = (): ToolCallResult =>
    toToolCallResult({
      ok: false,
      error: toolError('not_in_session', 'this MCP connection is not a Conduit session'),
    });

  const callTool = async (sessionId: string | null, name: string, args: unknown) => {
    const handle = sessionId ? handleOf(sessionId) : undefined;
    if (!sessionId || !handle) return notInSession();
    if (!store.available()) {
      return toToolCallResult({
        ok: false,
        error: toolError('store_unavailable', storeError ?? 'message store unavailable'),
      });
    }
    const caller: Caller = { handle, sessionId };
    switch (name) {
      case 'list_sessions':
        return toToolCallResult(tools.listSessions(caller));
      case 'send_message':
        return toToolCallResult(await tools.sendMessage(caller, args));
      case 'read_inbox':
        return toToolCallResult(await tools.readInbox(caller, args));
      case 'read_attachment':
        return toToolCallResult(await tools.readAttachment(caller, args));
      default:
        return toToolCallResult({
          ok: false,
          error: toolError('invalid_argument', `unknown tool: ${name}`),
        });
    }
  };

  const onConnection = (conn: EndpointConnection) => {
    const resolved = registry.resolve(conn.token);
    conns.set(conn.id, conn);
    if (resolved) connSession.set(conn.id, resolved);
    // The token is checked on every use, not once at hello: it dies with the PTY (spec §3.1),
    // and a connection that outlived it speaks for nobody.
    const current = (): string | null =>
      resolved && registry.resolve(conn.token) === resolved ? resolved : null;
    const core = createMcpServerCore({
      serverInfo: { name: 'conduit', version: VERSION },
      instructions: CONDUIT_INSTRUCTIONS,
      tools: () => (current() ? CONDUIT_TOOLS : []),
      call: (name, args) => callTool(current(), name, args),
    });
    conn.onLine((line) => {
      void core.handleLine(line).then(
        (reply) => {
          if (reply === undefined) return;
          conn.send(reply);
          const sessionId = current();
          if (resolved && !sessionId) {
            conn.close();
            return;
          }
          // Live only once the CLI has completed initialize: a shim that merely dialled in is
          // not yet a CLI that can take a turn (spec §2 gate, "MCP connection is live").
          if (sessionId && isInitialize(line)) {
            registry.connect(conn.id, sessionId);
            scheduleBroadcast();
          }
        },
        (err) => deps.log.error('conduit-mcp', 'request failed', { err: String(err) }),
      );
    });
    conn.onClose(() => {
      conns.delete(conn.id);
      connSession.delete(conn.id);
      registry.disconnect(conn.id);
      scheduleBroadcast();
    });
  };

  // ---- ui state ---------------------------------------------------------------------------

  const badgeOf = (sessionId: string, handle: Handle): McpSessionBadge => {
    const r = runtime.get(sessionId);
    const pending = store.pending(handle);
    const unavailable = r?.unavailable ?? null;
    const gate: McpGateState | null =
      unavailable !== null
        ? null
        : r?.adapter && !notifiable(r.adapter)
          ? 'pull-only'
          : deps.mgr.get(sessionId)?.mcpNoticesPaused
            ? 'paused'
            : (r?.gate ?? null);
    return {
      handle,
      unread: pending.length,
      urgent: pending.filter((m) => m.priority === 'urgent').length,
      paused: deps.mgr.get(sessionId)?.mcpNoticesPaused === true,
      unavailable,
      connected: registry.isLive(sessionId),
      gate,
    };
  };

  function uiState(): McpUiState {
    const sessions: Record<string, McpSessionBadge> = {};
    for (const s of deps.mgr.list()) if (s.mcpHandle) sessions[s.id] = badgeOf(s.id, s.mcpHandle);
    const all = store.available() ? store.threads() : [];
    const threads: McpThreadSummary[] = all.slice(0, MAX_UI_THREADS).map((t) => ({
      ...t,
      paused: store.agentCountSinceHuman(t.threadId) >= THREAD_AGENT_LIMIT,
      unreadForYou: t.unreadFor.includes(HUMAN_HANDLE),
    }));
    const youPending = store.available() ? store.pending(HUMAN_HANDLE) : [];
    return {
      enabled: deps.messagingOn(),
      storeError,
      loading,
      sessions,
      threads,
      attention: [...attention, ...youAttention(all, new Date(now()).toISOString())],
      youUnread: youPending.length,
      youUrgent: youPending.filter((m) => m.priority === 'urgent').length,
    };
  }

  // ---- lifecycle --------------------------------------------------------------------------

  const configFileOf = (sessionId: string) => path.join(launchDir, `${sessionId}.json`);

  const removeConfig = (sessionId: string) =>
    fs.promises.rm(configFileOf(sessionId), { force: true }).catch((err: unknown) => {
      deps.log.warn('conduit-mcp', 'launch config not removed', { sessionId, err: String(err) });
    });

  const closeConnectionsOf = (sessionId: string) => {
    for (const [id, s] of connSession) if (s === sessionId) conns.get(id)?.close();
  };

  const loadStore = async () => {
    const r = await store.load();
    storeError = r.ok ? null : r.error.message;
    if (r.ok) {
      const ret = await store.enforceRetention(new Date(now()));
      if (!ret.ok) deps.log.warn('conduit-mcp', 'retention failed', { code: ret.error.code });
    } else {
      deps.log.warn('conduit-mcp', 'store load failed', { message: r.error.message });
    }
    loading = false;
    scheduleBroadcast();
  };

  /** Input that is not a notice: it closes the gate as a draft and withholds an in-flight Enter. */
  const noteInput = (sessionId: string, data: string): boolean => {
    const r = runtime.get(sessionId);
    if (!r || !isCountedInput(data)) return false;
    r.inputSeq += 1;
    r.lastInputAt = now();
    r.hasDraft = nextDraftState(r.hasDraft, data);
    return true;
  };

  const tick = async () => {
    if (!notifier || stopped) return;
    // Badge gate state for every notifiable session, then the notifier's own pass.
    for (const s of notifierSessions()) await evaluate(s.sessionId);
    await notifier.tick();
  };

  return {
    async start() {
      try {
        // Configs left by a crash: they name a dead session and can't be reused.
        await fs.promises.rm(launchDir, { recursive: true, force: true });
        await fs.promises.mkdir(launchDir, { recursive: true });
      } catch (err) {
        deps.log.warn('conduit-mcp', 'launch dir sweep failed', { err: String(err) });
      }
      // Listening first: a launch wired before then would point its shim at nothing, and one
      // wired while the store loads only meets store_unavailable, which it can retry.
      if (deps.listen !== false) {
        const create = deps.createEndpoint ?? createMcpEndpoint;
        endpoint = create({ path: deps.endpointPath, onConnection, log: deps.log });
        const r = await endpoint.listen();
        endpointReady = r.ok;
      } else endpointReady = true;
      settleEndpoint();
      scheduleBroadcast();
      await loadStore();
      notifier = makeNotifier();
      const tickMs = deps.tickMs ?? TICK_MS;
      if (tickMs > 0 && !stopped) {
        tickTimer = setInterval(() => {
          tick().catch((err: unknown) => {
            deps.log.error('conduit-mcp', 'notice tick failed', { err: String(err) });
          });
        }, tickMs);
        tickTimer.unref?.();
        retentionTimer = setInterval(() => {
          void store.enforceRetention(new Date(now()));
        }, RETENTION_EVERY_MS);
        retentionTimer.unref?.();
      }
    },

    whenLaunchReady(def) {
      if (endpointSettled || !adapterFor(def, { e2e: deps.e2e })) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(done, ENDPOINT_READY_WAIT_MS);
        function done() {
          clearTimeout(timer);
          settleWaiters.delete(done);
          resolve();
        }
        settleWaiters.add(done);
      });
    },

    prepareLaunch(sessionId, def, spec) {
      const adapter = adapterFor(def, { e2e: deps.e2e });
      const session = deps.mgr.get(sessionId);
      if (!adapter || !session) return spec;
      const r = rt(sessionId);
      r.adapter = adapter;
      r.unavailable = null;
      registry.revoke(sessionId);

      const takenByOthers = new Set(
        deps.mgr
          .list()
          .filter((s) => s.id !== sessionId && s.mcpHandle)
          .map((s) => s.mcpHandle as Handle),
      );
      const a = assignHandle({
        current: session.mcpHandle,
        prefix: adapter.id,
        takenByOthers,
        counters: loadCounters(),
      });
      if (a.allocated) {
        // Counter first, then the handle (plan ruling 10): a crash between burns a number.
        try {
          fs.mkdirSync(deps.dir, { recursive: true });
          atomicWriteFileSync(handlesFile, serializeHandleCounters(a.counters));
        } catch (err) {
          deps.log.error('conduit-mcp', 'handles.json write failed', { err: String(err) });
          r.unavailable = 'launch-io';
          scheduleBroadcast();
          return spec;
        }
        counters = a.counters;
        deps.mgr.setMcp(sessionId, { mcpHandle: a.handle });
      }

      const unavailable = (reason: McpUnavailableReason) => {
        r.unavailable = reason;
        scheduleBroadcast();
        return spec;
      };
      if (!deps.messagingOn()) return unavailable('messaging-off');
      if (!endpointReady) return unavailable('endpoint-down');
      const configFile = configFileOf(sessionId);
      const wiring = mcpLaunchWiring({
        adapter,
        platform: deps.platform,
        resolvedCommand: spec.command,
        server: mcpServerCommand(deps.execPath, deps.shimPath, deps.endpointPath),
        configFile,
      });
      if (!wiring.ok) return unavailable(wiring.reason);
      if (wiring.configJson !== null) {
        try {
          fs.mkdirSync(launchDir, { recursive: true });
          atomicWriteFileSync(configFile, wiring.configJson);
        } catch (err) {
          deps.log.error('conduit-mcp', 'launch config write failed', { err: String(err) });
          return unavailable('launch-io');
        }
      }
      const token = randomToken();
      registry.mint(sessionId, token);
      scheduleBroadcast();
      return {
        ...spec,
        args: [...spec.args, ...wiring.args],
        env: { ...spec.env, CONDUIT_SESSION_TOKEN: token },
      };
    },

    onSpawn(sessionId, cols, rows) {
      const r = runtime.get(sessionId);
      if (!r?.adapter || r.unavailable) return;
      r.spawnedAt = now();
      r.hasDraft = false;
      r.lastInputAt = undefined;
      screens.start(sessionId, cols, rows);
    },

    onOutput(sessionId, data) {
      screens.feed(sessionId, data);
    },

    onResize(sessionId, cols, rows) {
      screens.resize(sessionId, cols, rows);
    },

    onExit(sessionId) {
      if (!runtime.has(sessionId)) return;
      registry.revoke(sessionId);
      closeConnectionsOf(sessionId);
      void removeConfig(sessionId);
      screens.dispose(sessionId);
      const r = rt(sessionId);
      r.spawnedAt = undefined;
      scheduleBroadcast();
    },

    onRendererInput(sessionId, data) {
      if (!noteInput(sessionId, data)) return;
      const handle = handleOf(sessionId);
      if (handle) dispatch({ t: 'renderer-input', handle });
    },

    noteHostInput(sessionId, data) {
      noteInput(sessionId, data);
    },

    async onSessionDeleted(sessionId) {
      const handle = handleOf(sessionId);
      registry.revoke(sessionId);
      closeConnectionsOf(sessionId);
      screens.dispose(sessionId);
      notifier?.forget(sessionId);
      deps.writer.forget(sessionId);
      runtime.delete(sessionId);
      await removeConfig(sessionId);
      if (!handle) return;
      for (const m of store.pending(handle)) {
        const r = await store.setStatus(m.messageId, handle, 'undelivered');
        if (!r.ok) deps.log.warn('conduit-mcp', 'undelivered mark failed', { code: r.error.code });
      }
      dispatch({ t: 'session-gone', handle });
      scheduleBroadcast();
    },

    refresh() {
      scheduleBroadcast();
    },

    uiState,

    async handleRenderer(m, reply) {
      switch (m.type) {
        case 'mcp:compose': {
          const result = await tools.sendMessage(
            { handle: HUMAN_HANDLE, sessionId: null },
            {
              to: m.to,
              body: m.body,
              priority: m.priority,
              kind: m.kind,
              ...(m.subject !== undefined ? { subject: m.subject } : {}),
              ...(m.threadId !== undefined ? { thread_id: m.threadId } : {}),
            },
          );
          reply({ type: 'mcp:sent', requestId: m.requestId, result });
          return;
        }
        case 'mcp:thread:get': {
          const msgs = store.thread(m.threadId);
          const messages: McpThreadMessage[] = msgs.map((x) => ({
            ...x,
            attachmentsExpired: x.expired && x.attachments.length > 0,
          }));
          reply({
            type: 'mcp:thread',
            requestId: m.requestId,
            thread:
              messages.length === 0
                ? null
                : {
                    threadId: m.threadId,
                    paused: store.agentCountSinceHuman(m.threadId) >= THREAD_AGENT_LIMIT,
                    messages,
                  },
          });
          return;
        }
        case 'mcp:attachment:get': {
          const msg = store.get(m.messageId);
          const att = msg?.attachments.find((a) => a.attachmentId === m.attachmentId);
          const data = msg && att && !msg.expired ? await store.readBlob(att.sha256) : undefined;
          reply({
            type: 'mcp:attachment',
            requestId: m.requestId,
            result:
              att && data
                ? {
                    ok: true,
                    value: {
                      name: att.name,
                      mime: att.mime,
                      bytes: att.bytes,
                      base64: Buffer.from(data).toString('base64'),
                    },
                  }
                : { ok: false, error: 'not_found' },
          });
          return;
        }
        case 'mcp:markRead':
          for (const id of m.messageIds) {
            const msg = store.get(id);
            const st = msg?.recipients[HUMAN_HANDLE]?.status;
            if (!st || st === 'read' || st === 'expired') continue;
            const r = await store.setStatus(id, HUMAN_HANDLE, 'read');
            if (!r.ok) deps.log.warn('conduit-mcp', 'markRead failed', { code: r.error.code });
          }
          return;
        case 'mcp:allowMore': {
          const r = await store.allowMore(m.threadId);
          if (!r.ok) deps.log.warn('conduit-mcp', 'allowMore failed', { code: r.error.code });
          return;
        }
        case 'mcp:pause':
          deps.mgr.setMcp(m.sessionId, { mcpNoticesPaused: m.paused });
          scheduleBroadcast();
          return;
        case 'mcp:retry':
          // Reload only a store that failed (plan ruling 2): a live one may have queued writes.
          if (!store.available()) {
            loading = true;
            scheduleBroadcast();
            await loadStore();
          } else scheduleBroadcast();
          return;
      }
    },

    tick,

    async stop() {
      stopped = true;
      settleEndpoint();
      if (tickTimer) clearInterval(tickTimer);
      if (retentionTimer) clearInterval(retentionTimer);
      if (broadcastTimer) clearTimeout(broadcastTimer);
      broadcastTimer = undefined;
      for (const c of conns.values()) c.close();
      await endpoint?.close();
    },
  };
}

/** The core already answered an unparsable line with -32700, so here it is simply not an initialize. */
function isInitialize(line: string): boolean {
  try {
    const v = JSON.parse(line) as { method?: unknown };
    return v.method === 'initialize';
  } catch {
    return false;
  }
}
