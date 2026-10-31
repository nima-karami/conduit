import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../src/atomic-write';
import { adapterFor, MCP_ADAPTERS, type McpAdapter, notifiable } from '../src/conduit-mcp/adapters';
import { snapshotAttachment } from '../src/conduit-mcp/attachments';
import {
  type AttentionEvent,
  reduceAttention,
  youAttention,
} from '../src/conduit-mcp/attention-items';
import { createCallFlow } from '../src/conduit-mcp/call-flow';
import {
  bindsTypedLine,
  type ClientKind,
  clientKindOf,
  initializeClientName,
  pickNoticeAdapterId,
} from '../src/conduit-mcp/client-info';
import { type ControlDeps, createControlHandlers } from '../src/conduit-mcp/control-tools';
import {
  isCountedInput,
  nextDraftState,
  settleDraft,
  stripTerminalReplies,
} from '../src/conduit-mcp/draft-input';
import {
  cliKindOfHandle,
  type HandleCounters,
  parseHandleCounters,
  serializeHandleCounters,
} from '../src/conduit-mcp/handles';
import type { AgentCli, UserInstallState } from '../src/conduit-mcp/install-types';
import {
  createMcpServerCore,
  TOOLS_LIST_CHANGED,
  type ToolCallContext,
  type ToolCallResult,
} from '../src/conduit-mcp/json-rpc';
import {
  awaitEnterVerdict,
  ECHO_POLL_MS,
  evaluateEnterRecheck,
  evaluateGate,
  type GateVerdict,
  IDLE_QUIET_MS,
} from '../src/conduit-mcp/notice-gate';
import { type AttentionRaise, createNotifier, type Notifier } from '../src/conduit-mcp/notifier';
import { type ScreenSnapshot, screenVerdict } from '../src/conduit-mcp/screen-verdict';
import { assignHandle, createSessionRegistry } from '../src/conduit-mcp/session-registry';
import { createMessageStore, type StoreIo } from '../src/conduit-mcp/store';
import { createFsStoreIo } from '../src/conduit-mcp/store-fs';
import {
  type CliPolicyLayers,
  coercePolicyPatch,
  type GlobalPolicy,
  gateToolCall,
  isMessagingTool,
  isToolName,
  type Move,
  type ResolvedPolicy,
  resolvePolicy,
  TOOL_NAMES,
  type ToolName,
} from '../src/conduit-mcp/tool-policy';
import { CONDUIT_INSTRUCTIONS, toolSchemas } from '../src/conduit-mcp/tool-schemas';
import {
  type Caller,
  createToolHandlers,
  type DirectoryEntry,
  toToolCallResult,
} from '../src/conduit-mcp/tools';
import {
  createTypedLineTracker,
  DETECT_GRACE_MS,
  type TypedLineTracker,
  UNTYPED_ENTER_KEEP_MS,
} from '../src/conduit-mcp/typed-command';
import {
  type Handle,
  HUMAN_HANDLE,
  type McpAttentionItem,
  type McpUnavailableReason,
  type Presence,
  type Result,
  type ScreenVerdict,
  THREAD_AGENT_LIMIT,
  toolError,
} from '../src/conduit-mcp/types';
import type {
  McpGateState,
  McpNotConnected,
  McpSessionBadge,
  McpThreadMessage,
  McpThreadSummary,
  McpUiState,
} from '../src/conduit-mcp/ui-types';
import { inputBoxTop } from '../src/input-box-rows';
import type { HostPlatform } from '../src/lsp-binary';
import { mcpLaunchWiring, mcpServerCommand } from '../src/mcp-launch';
import type { HostToWebview, WebviewToHost } from '../src/protocol';
import type { PtyHost } from '../src/pty-host';
import type { PtyWriter, SubmitOutcome } from '../src/pty-writer';
import type { SessionActivity } from '../src/session-activity';
import type { SessionManager } from '../src/session-manager';
import { PTY_SETTLE_MS } from '../src/timed-messages';
import type { AgentDefinition, SpawnSpec } from '../src/types';
import type { WindowPresence } from '../src/window-presence';
import {
  createMcpEndpoint,
  type EndpointConnection,
  type McpEndpoint,
} from './conduit-mcp-endpoint';
import type { Logger } from './logger';
import { readCursorLaunchEntry } from './mcp-install';
import { createSessionScreens, type SessionScreens } from './session-screens';

export interface ConduitMcpHostDeps {
  /** userData/conduit-mcp */
  dir: string;
  endpointPath: string;
  execPath: string;
  shimPath: string;
  homeDir: string;
  platform: HostPlatform;
  e2e: boolean;
  mgr: Pick<SessionManager, 'get' | 'list' | 'setMcp' | 'setMcpToolPolicy'>;
  /** settings.mcpToolPolicy and settings.mcpToolPolicyByCli, read per call. */
  toolPolicy(): { global: GlobalPolicy; byCli: CliPolicyLayers };
  /** The session's owner window id; null when it has none. */
  ownerWindowOf(sessionId: string): number | null;
  presence: Pick<WindowPresence, 'isReady' | 'isOnScreen'>;
  sendToOwner(sessionId: string, msg: HostToWebview): void;
  /** Taskbar flash unless the owner window is focused (main gates it on settings.osAttention). */
  flashOwner(sessionId: string): void;
  /** The CLI's user-scope install state, shown with a not-connected session (spec §2.4). */
  installState(cli: AgentCli): UserInstallState;
  /** Default DETECT_GRACE_MS. */
  detectGraceMs?: number;
  /** effectiveDef(session, registry), bound in main. */
  defOf(sessionId: string): AgentDefinition | undefined;
  /** Registered agent ids, for the open_session schema enum. */
  agentIds(): string[];
  /** Main's side of the control tools: paths, commands, and creating sessions/opening files. */
  control: Omit<ControlDeps, 'claimHandle' | 'now' | 'info' | 'agentIds'>;
  pty: Pick<PtyHost, 'isAlive' | 'generation'>;
  writer: PtyWriter;
  activity: Pick<SessionActivity, 'statusOf' | 'lastOutputAt'>;
  messagingOn(): boolean;
  projectName(projectId: string | undefined): string | null;
  broadcast(msg: HostToWebview): void;
  log: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  // tests only
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  randomToken?: () => string;
  storeIo?: StoreIo;
  screens?: SessionScreens;
  listen?: boolean;
  tickMs?: number;
  createEndpoint?: typeof createMcpEndpoint;
  /** Default randomBytes(12).toString('hex'). */
  newAskId?: () => string;
  /** Default setTimeout / clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export type McpRendererMessage = Extract<WebviewToHost, { type: `mcp:${string}` }>;

export interface ConduitMcpHost {
  start(): Promise<void>;
  /**
   * Resolves once a launch of `def` can be wired: at once for an agent with no adapter, else when
   * start's listen attempt settles, bounded by ENDPOINT_READY_WAIT_MS. A session restored at app
   * start launches before start() has listened; without the wait it would read endpoint-down.
   */
  whenLaunchReady(): Promise<void>;
  prepareLaunch(sessionId: string, def: AgentDefinition, spec: SpawnSpec): SpawnSpec;
  onSpawn(sessionId: string, cols: number, rows: number): void;
  onOutput(sessionId: string, data: string): void;
  onResize(sessionId: string, cols: number, rows: number): void;
  onExit(sessionId: string): void;
  onRendererInput(sessionId: string, data: string): void;
  /** After an install action: re-reads the install state behind every notConnected entry. */
  onInstallChanged(): void;
  /** Input the host writes outside the PTY writer (the add-dir paste): it is a draft too. */
  noteHostInput(sessionId: string, data: string): void;
  onSessionDeleted(sessionId: string): Promise<void>;
  /** Navigation start, renderer gone, or closed: that window's asks end `cancelled`. */
  onWindowReset(windowId: number): void;
  /** The session now belongs to another window: its asks end `cancelled`. */
  onSessionMoved(sessionId: string): void;
  refresh(): void;
  uiState(): McpUiState;
  /** `senderId`: the window the message came from; an ask answer counts only from its own window. */
  handleRenderer(
    m: McpRendererMessage,
    reply: (msg: HostToWebview) => void,
    senderId: number,
  ): Promise<void>;
  tick(): Promise<void>;
  stop(): Promise<void>;
}

const TICK_MS = 500;
const SUBMIT_CONFIRM_WAIT_MS = 2_000;
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
  /** The definition's adapter; a shell has none and takes its notice adapter from its live client. */
  defAdapter: McpAdapter | undefined;
  unavailable: McpUnavailableReason | null;
  spawnedAt: number | undefined;
  /** Last PTY size, for a screen model started later than spawn (D6). */
  size: { cols: number; rows: number } | undefined;
  /** Bumped per prepareLaunch: the banner's once-per-PTY-generation key, known before the PTY exists. */
  launch: number;
  /** Only for token-bearing sessions without a definition adapter. */
  tracker: TypedLineTracker | undefined;
  /**
   * The agent CLI the last typed command line ran (null: some other line), until a client of that
   * CLI binds it. Spec §2.4 A1.
   */
  lastLine: { cli: AgentCli | null; at: number } | undefined;
  /** The connection a shell's notices are bound to; typed lines are its prompts while it lives. */
  bound: number | undefined;
  detect: { cli: AgentCli; at: number } | undefined;
  notConnected: McpNotConnected | undefined;
  hasDraft: boolean;
  inputSeq: number;
  lastInputAt: number | undefined;
  lastNoticeAt: number | undefined;
  gate: McpGateState | null;
  /** Last gate a notice attempt logged; the per-tick badge pass doesn't log (volume). */
  loggedGate: McpGateState | null;
}

/** Claude's rules + `❯`/`!` row around the cursor, by the same shape the renderer unlinks. */
function ruledBoxOnScreen(s: ScreenSnapshot, cols: number): boolean {
  // Snapshot rows are trimmed; an empty `❯ ` row needs its blank cells back to read as a prompt.
  const rowAt = (y: number) => {
    const text = s.lines[y]?.padEnd(cols);
    return text === undefined ? undefined : { text, bg0: '', dim0: false, bgLast: '' };
  };
  return inputBoxTop(rowAt, s.cursorY, { cols, rows: s.lines.length }) !== null;
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
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const randomToken = deps.randomToken ?? (() => randomBytes(32).toString('hex'));
  const detectGraceMs = deps.detectGraceMs ?? DETECT_GRACE_MS;
  const store = createMessageStore(deps.storeIo ?? createFsStoreIo(deps.dir));
  const screens = deps.screens ?? createSessionScreens();
  const registry = createSessionRegistry();
  const runtime = new Map<string, Runtime>();
  const conns = new Map<number, EndpointConnection>();
  /** Every connection whose hello token resolved, initialized or not: revoke closes them all. */
  const connSession = new Map<number, string>();
  /** Requests each connection is still answering, and the ones to close once that reaches 0. */
  const answering = new Map<number, number>();
  const draining = new Set<number>();
  /** The tool-name key each connection last listed; list_changed fires only when it moves. */
  const lastListed = new Map<number, string>();
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
        defAdapter: undefined,
        unavailable: null,
        spawnedAt: undefined,
        size: undefined,
        launch: 0,
        tracker: undefined,
        lastLine: undefined,
        bound: undefined,
        detect: undefined,
        notConnected: undefined,
        hasDraft: false,
        inputSeq: 0,
        lastInputAt: undefined,
        lastNoticeAt: undefined,
        gate: null,
        loggedGate: null,
      };
      runtime.set(sessionId, r);
    }
    return r;
  };

  const handleOf = (sessionId: string): Handle | undefined => deps.mgr.get(sessionId)?.mcpHandle;
  /** Initialized connections' client kinds; seq is initialize order. */
  const connKinds = new Map<number, { kind: ClientKind; seq: number }>();
  let connSeq = 0;
  /** Oldest → newest. */
  const liveKinds = (sessionId: string): ClientKind[] =>
    registry
      .connectionsOf(sessionId)
      .flatMap((c) => {
        const k = connKinds.get(c);
        return k ? [k] : [];
      })
      .sort((a, b) => a.seq - b.seq)
      .map((k) => k.kind);
  /** The bound connection's kind while it is live (spec §2.4 A1); [] when nothing is bound. */
  const boundKinds = (sessionId: string, r: Runtime | undefined): ClientKind[] => {
    const bound = r?.bound;
    if (bound === undefined || !registry.connectionsOf(sessionId).includes(bound)) return [];
    const k = connKinds.get(bound);
    return k ? [k.kind] : [];
  };
  /** Spec 2026-10-27-conduit-mcp-install §2.4: the definition's adapter, else the bound client's. */
  const noticeAdapterOf = (sessionId: string): McpAdapter | null => {
    const r = runtime.get(sessionId);
    const id = pickNoticeAdapterId(r?.defAdapter?.id, boundKinds(sessionId, r));
    return MCP_ADAPTERS.find((a) => a.id === id) ?? null;
  };
  const unbind = (r: Runtime) => {
    r.bound = undefined;
    r.lastLine = undefined;
    scheduleBroadcast();
  };
  const hasDefAdapter = (sessionId: string): boolean => {
    const def = deps.defOf(sessionId);
    return def !== undefined && adapterFor(def, { e2e: deps.e2e }) !== undefined;
  };
  /**
   * A lazily named shell is listed only while a CLI is live in it or it has message history, so a
   * health check (`claude mcp list`) doesn't enrol it for good (plan amendment B2).
   */
  const listedSessions = () => {
    let talked: Set<Handle> | undefined;
    const hasHistory = (h: Handle) => {
      talked ??= new Set(store.available() ? store.threads().flatMap((t) => t.participants) : []);
      return talked.has(h);
    };
    return deps.mgr.list().flatMap((s) => {
      const handle = s.mcpHandle;
      if (!handle) return [];
      const listed = hasDefAdapter(s.id) || registry.isLive(s.id) || hasHistory(handle);
      return listed ? [{ session: s, handle }] : [];
    });
  };
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
    listedSessions().map(({ session: s, handle }) => ({
      handle,
      sessionId: s.id,
      label: s.name,
      // A profile session is its definition's agent whatever client name it sends, as for notices.
      agent: (hasDefAdapter(s.id) ? undefined : liveKinds(s.id).at(-1)) ?? handlePrefix(handle),
      project: deps.projectName(s.projectId),
      home: s.home,
      roots: [...s.roots],
      presence: presenceOf(s.id),
      messaging: registry.isLive(s.id) ? 'connected' : 'unavailable',
    }));

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

  const screenOf = async (
    sessionId: string,
    adapter: McpAdapter,
    expect?: string,
    ruledBoxCols?: number,
  ) => {
    const snap = await screens.snapshot(sessionId);
    const verdict: ScreenVerdict = snap ? screenVerdict(adapter.screen, snap, expect) : 'unknown';
    if (verdict !== 'empty-input' || ruledBoxCols === undefined) return verdict;
    return snap && ruledBoxOnScreen(snap, ruledBoxCols) ? verdict : 'unknown';
  };
  /**
   * A shell bound to a `claude` client admits a notice only into Claude's ruled input box: its bare
   * `❯ ` row is also a starship/pure shell prompt (spec §2.4 A1, SF-1 ruling). NaN cols never match.
   */
  const ruledBoxColsOf = (sessionId: string, r: Runtime): number | undefined =>
    !r.defAdapter && boundKinds(sessionId, r)[0] === 'claude'
      ? (r.size?.cols ?? Number.NaN)
      : undefined;

  /**
   * The full gate; precheck and beforeText run exactly this (plan T9.2 "Gate inputs"). Returns the
   * adapter it judged the screen with, so the Enter recheck reads that same adapter's echo.
   */
  const evaluateWith = async (
    sessionId: string,
    forNotice = false,
  ): Promise<{ verdict: GateVerdict; adapter: McpAdapter | null }> => {
    const r = rt(sessionId);
    const session = deps.mgr.get(sessionId);
    const adapter = noticeAdapterOf(sessionId);
    if (!adapter || !session) return { verdict: { open: false, reason: 'not-running' }, adapter };
    const screen = await screenOf(sessionId, adapter, undefined, ruledBoxColsOf(sessionId, r));
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
    if (forNotice && r.loggedGate !== gate) {
      deps.log.info('conduit-mcp', 'gate', {
        sessionId,
        handle: handleOf(sessionId),
        from: r.loggedGate,
        to: gate,
      });
      r.loggedGate = gate;
    }
    if (r.gate !== gate) {
      r.gate = gate;
      scheduleBroadcast();
    }
    return { verdict, adapter };
  };
  const evaluate = async (sessionId: string, forNotice = false): Promise<GateVerdict> =>
    (await evaluateWith(sessionId, forNotice)).verdict;

  /**
   * Log-only: whether the CLI took the Enter, read as its prompt coming back empty. An Enter a TUI
   * turned into a newline leaves the notice in its input. Not `busy`: the echo itself sets it.
   */
  const confirmSubmit = async (sessionId: string, adapter: McpAdapter, handle?: Handle) => {
    const start = now();
    for (;;) {
      const taken = (await screenOf(sessionId, adapter)) === 'empty-input';
      const waitedMs = now() - start;
      if (taken) {
        deps.log.info('conduit-mcp', 'notice submit confirmed', { sessionId, handle, waitedMs });
        return;
      }
      if (waitedMs >= SUBMIT_CONFIRM_WAIT_MS || !deps.pty.isAlive(sessionId)) {
        deps.log.warn('conduit-mcp', 'notice submit unconfirmed', { sessionId, handle, waitedMs });
        return;
      }
      await sleep(ECHO_POLL_MS);
    }
  };

  const submitNotice = async (sessionId: string, text: string): Promise<SubmitOutcome> => {
    const r = rt(sessionId);
    const handle = handleOf(sessionId);
    let gen: number | undefined;
    let seq = 0;
    /** The adapter whose screen admitted the text; its echo decides the Enter, whoever connects since. */
    let typedFor: McpAdapter | null = null;
    const recheck = async (adapter: McpAdapter): Promise<GateVerdict> => {
      const session = deps.mgr.get(sessionId);
      if (!session) return { open: false, reason: 'not-running' };
      return evaluateEnterRecheck({
        messagingOn: deps.messagingOn(),
        paused: session.mcpNoticesPaused === true,
        running: deps.pty.isAlive(sessionId),
        sameGeneration: gen !== undefined && deps.pty.generation(sessionId) === gen,
        connectionLive: registry.isLive(sessionId),
        screen: await screenOf(sessionId, adapter, text),
        inputSinceText: r.inputSeq !== seq,
      });
    };
    const outcome = await deps.writer.submit(sessionId, text, {
      beforeText: async () => {
        const { verdict, adapter } = await evaluateWith(sessionId, true);
        gen = deps.pty.generation(sessionId);
        seq = r.inputSeq;
        typedFor = adapter;
        return verdict.open;
      },
      beforeEnter: async () => {
        const adapter = typedFor;
        if (!adapter) return false;
        deps.log.info('conduit-mcp', 'notice typed', { sessionId, handle });
        const { verdict, waitedMs } = await awaitEnterVerdict(() => recheck(adapter), {
          now,
          sleep,
        });
        deps.log.info('conduit-mcp', 'notice echo', {
          sessionId,
          handle,
          verdict: verdict.open ? 'echoed' : verdict.reason,
          waitedMs,
        });
        return verdict.open;
      },
    });
    deps.log.info('conduit-mcp', 'notice result', { sessionId, handle, outcome });
    if (outcome === 'submitted' || outcome === 'withheld') r.lastNoticeAt = now();
    if (outcome === 'submitted' && handle) dispatch({ t: 'notice-submitted', handle });
    if (outcome === 'submitted' && typedFor) {
      confirmSubmit(sessionId, typedFor, handle).catch((err: unknown) => {
        deps.log.warn('conduit-mcp', 'notice confirm failed', { sessionId, err: String(err) });
      });
    }
    return outcome;
  };

  /**
   * The session's handle, allocating one when it has none. Shared by launch and by an MCP open,
   * which must return the handle before the renderer has spawned anything (spec 2026-10-27 §3.1).
   * Null on a handles.json write failure, which marks the session launch-io.
   */
  const claimHandle = (sessionId: string, prefix: string): Handle | null => {
    const session = deps.mgr.get(sessionId);
    if (!session) return null;
    const takenByOthers = new Set(
      deps.mgr
        .list()
        .filter((s) => s.id !== sessionId && s.mcpHandle)
        .map((s) => s.mcpHandle as Handle),
    );
    const a = assignHandle({
      current: session.mcpHandle,
      prefix,
      takenByOthers,
      counters: loadCounters(),
    });
    if (!a.allocated) return a.handle;
    // Counter first, then the handle (plan ruling 10): a crash between burns a number.
    try {
      fs.mkdirSync(deps.dir, { recursive: true });
      atomicWriteFileSync(handlesFile, serializeHandleCounters(a.counters));
    } catch (err) {
      deps.log.error('conduit-mcp', 'handles.json write failed', { err: String(err) });
      rt(sessionId).unavailable = 'launch-io';
      scheduleBroadcast();
      return null;
    }
    counters = a.counters;
    deps.mgr.setMcp(sessionId, { mcpHandle: a.handle });
    scheduleBroadcast();
    return a.handle;
  };

  const control = createControlHandlers({
    ...deps.control,
    agentIds: () => deps.agentIds(),
    claimHandle: (sessionId) => {
      const def = deps.defOf(sessionId);
      const adapter = def && adapterFor(def, { e2e: deps.e2e });
      return adapter ? claimHandle(sessionId, adapter.id) : null;
    },
    now,
    info: (message, data) => deps.log.info('conduit-mcp', message, data),
  });

  /** Session > CLI kind (the persisted handle's prefix) > global, per field (spec §3.1). */
  const resolveFor = (sessionId: string, tool: ToolName): ResolvedPolicy => {
    const { global, byCli } = deps.toolPolicy();
    const session = deps.mgr.get(sessionId);
    const handle = session?.mcpHandle;
    return resolvePolicy(tool, {
      session: session?.mcpToolPolicy,
      cli: handle ? byCli[cliKindOfHandle(handle)] : undefined,
      global,
    });
  };

  const flow = createCallFlow({
    now,
    setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimer:
      deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout> | undefined)),
    newAskId: deps.newAskId ?? (() => randomBytes(12).toString('hex')),
    // Re-checked here, not trusted from the gate: the window may have reloaded during prepare.
    ownerWindowOf: (sessionId) => {
      const w = deps.ownerWindowOf(sessionId);
      return w !== null && deps.presence.isReady(w) ? w : null;
    },
    sendToOwner: (sessionId, msg) => deps.sendToOwner(sessionId, msg),
    flashOwner: (sessionId) => deps.flashOwner(sessionId),
    resolve: (sessionId, tool) =>
      deps.mgr.get(sessionId) ? resolveFor(sessionId, tool).policy : null,
    messagingOn: () => deps.messagingOn(),
    setSessionPolicy: (sessionId, tool, patch) => deps.mgr.setMcpToolPolicy(sessionId, tool, patch),
    onPolicyWritten: () => {
      syncToolLists();
      scheduleBroadcast();
    },
    onAwaitingChanged: () => scheduleBroadcast(),
  });

  const notifierSessions = () =>
    deps.mgr.list().flatMap((s) => {
      const r = runtime.get(s.id);
      const adapter = noticeAdapterOf(s.id);
      if (!s.mcpHandle || !r || !adapter || !notifiable(adapter) || r.unavailable) return [];
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
        precheck: (sessionId) => evaluate(sessionId, true),
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

  /**
   * What a session's connection lists (spec 2026-10-27-conduit-mcp-control-tools §3.4): with the
   * master off, everything, so the CLI's calls get messaging_off rather than an unknown tool.
   */
  const listedTools = (sessionId: string): readonly ToolName[] =>
    deps.messagingOn()
      ? TOOL_NAMES.filter((t) => resolveFor(sessionId, t).policy.access !== 'off')
      : TOOL_NAMES;

  type CallContext = ToolCallContext & { connId: number };

  const callTool = async (
    sessionId: string | null,
    name: string,
    args: unknown,
    ctx: CallContext,
  ): Promise<ToolCallResult | null> => {
    // Before the first await: a notifications/cancelled read right after this line must find it.
    const inflight = flow.begin({ connId: ctx.connId, requestId: ctx.requestId });
    try {
      const handle = sessionId ? handleOf(sessionId) : undefined;
      const result = await (async (): Promise<Result<unknown> | null> => {
        // The core refused names outside the catalog already; this only narrows the type.
        if (!isToolName(name)) {
          return { ok: false, error: toolError('invalid_argument', `unknown tool: ${name}`) };
        }
        if (!sessionId || !handle) {
          return {
            ok: false,
            error: toolError('not_in_session', 'this MCP connection is not a Conduit session'),
          };
        }
        const resolved = resolveFor(sessionId, name);
        const windowId = deps.ownerWindowOf(sessionId);
        const refused = gateToolCall({
          sessionId,
          messagingOn: deps.messagingOn(),
          tool: name,
          policy: resolved.policy,
          ownerReady: () => windowId !== null && deps.presence.isReady(windowId),
          onScreen: () => windowId !== null && deps.presence.isOnScreen(windowId, sessionId),
        });
        if (refused) return { ok: false, error: refused };
        const caller = { handle, sessionId };
        if (isMessagingTool(name)) {
          if (!store.available()) {
            return {
              ok: false,
              error: toolError('store_unavailable', storeError ?? 'message store unavailable'),
            };
          }
          return runMessaging(caller, name, args);
        }
        const move = { move: resolved.policy.move };
        return flow.runControl<unknown>({
          inflight,
          caller,
          kind: cliKindOfHandle(handle),
          tool: name,
          policy: resolved.policy,
          source: resolved.source.access,
          args,
          prepare: () => prepareControl(caller, name, args, move),
        });
      })();
      // spec 2026-10-30-conduit-mcp-tool-policy §2.4: no reply after notifications/cancelled.
      const cancelled = result === null || inflight.cancelled;
      deps.log.info('conduit-mcp', 'tool call', {
        tool: name,
        handle,
        ...(cancelled
          ? { cancelled: true }
          : { ok: result.ok, ...(result.ok ? {} : { code: result.error.code }) }),
      });
      return cancelled ? null : toToolCallResult(result);
    } finally {
      inflight.end();
    }
  };

  const runMessaging = async (caller: Caller, name: ToolName, args: unknown) => {
    switch (name) {
      case 'list_sessions':
        return tools.listSessions(caller);
      case 'send_message':
        return tools.sendMessage(caller, args);
      case 'read_inbox':
        return tools.readInbox(caller, args);
      case 'read_attachment':
        return tools.readAttachment(caller, args);
    }
    throw new Error(`runMessaging: ${name} is not a messaging tool`);
  };

  const prepareControl = (
    caller: Caller,
    name: ToolName,
    args: unknown,
    ctx: { move: Move | undefined },
  ) => {
    switch (name) {
      case 'open_session':
        return control.prepareOpenSession(caller, args, ctx);
      case 'open_terminal':
        return control.prepareOpenTerminal(caller, args, ctx);
      case 'open_file':
        return control.prepareOpenFile(caller, args, ctx);
    }
    throw new Error(`prepareControl: ${name} is not a control tool`);
  };

  /**
   * Runs before the core replies, so the CLI's first list_sessions already shows its own handle
   * (spec 2026-10-27-conduit-mcp-install §3.3).
   */
  const onInitialize = (connId: number, sessionId: string, name: string | null) => {
    const kind = clientKindOf(name, { e2e: deps.e2e });
    if (!connKinds.has(connId)) connKinds.set(connId, { kind, seq: ++connSeq });
    if (!handleOf(sessionId)) claimHandle(sessionId, kind);
    // D6 ruling: a shell's screen model costs memory, so it starts only once a CLI shows up.
    const r = runtime.get(sessionId);
    if (r?.size && !screens.has(sessionId)) screens.start(sessionId, r.size.cols, r.size.rows);
    // One binding per typed line: a second client (`code .` from inside the CLI) never takes it.
    if (r && !r.defAdapter && r.bound === undefined && bindsTypedLine(kind, r.lastLine?.cli)) {
      r.bound = connId;
      r.lastLine = undefined;
    }
    if (r) {
      r.detect = undefined;
      if (r.notConnected?.reason === 'no-initialize') {
        r.notConnected = undefined;
        scheduleBroadcast();
      }
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
    let connectedAs: string | null = null;
    const core = createMcpServerCore({
      serverInfo: { name: 'conduit', version: VERSION },
      instructions: CONDUIT_INSTRUCTIONS,
      tools: () => {
        const sessionId = current();
        if (!sessionId) return [];
        const names = listedTools(sessionId);
        lastListed.set(conn.id, names.join(','));
        return toolSchemas(deps.agentIds()).filter((t) => names.some((n) => n === t.name));
      },
      call: (name, args, ctx) => callTool(current(), name, args, { ...ctx, connId: conn.id }),
      cancelled: (requestId) => flow.cancelled(conn.id, requestId),
    });
    conn.onLine((line) => {
      const initFor = current();
      const initName = initFor === null ? undefined : initializeClientName(line);
      const initializing = initName !== undefined;
      if (initFor !== null && initName !== undefined) onInitialize(conn.id, initFor, initName);
      answering.set(conn.id, (answering.get(conn.id) ?? 0) + 1);
      void core
        .handleLine(line)
        .then(
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
            if (sessionId && initializing) {
              registry.connect(conn.id, sessionId);
              connectedAs = sessionId;
              deps.log.info('conduit-mcp', 'mcp connected', {
                connId: conn.id,
                sessionId,
                handle: handleOf(sessionId),
              });
              scheduleBroadcast();
            }
          },
          (err) => deps.log.error('conduit-mcp', 'request failed', { err: String(err) }),
        )
        .finally(() => {
          const n = answering.get(conn.id);
          // undefined: the connection closed meanwhile, so there is nothing left to drain.
          if (n === undefined) return;
          answering.set(conn.id, n - 1);
          if (n === 1 && draining.has(conn.id)) conn.close();
        });
    });
    conn.onClose(() => {
      if (connectedAs) {
        deps.log.info('conduit-mcp', 'mcp disconnected', {
          connId: conn.id,
          sessionId: connectedAs,
          handle: handleOf(connectedAs),
        });
      }
      flow.connectionClosed(conn.id);
      const owner = connSession.get(conn.id);
      const r = owner === undefined ? undefined : runtime.get(owner);
      if (r?.bound === conn.id) unbind(r);
      conns.delete(conn.id);
      connSession.delete(conn.id);
      connKinds.delete(conn.id);
      lastListed.delete(conn.id);
      answering.delete(conn.id);
      draining.delete(conn.id);
      registry.disconnect(conn.id);
      scheduleBroadcast();
    });
  };

  /**
   * Tells each initialized connection whose tool set changed to re-list. The key is the names
   * only: an agent-enum change alone is ignored, since open_session validates agents live (A6).
   */
  const syncToolLists = () => {
    for (const s of deps.mgr.list()) {
      for (const connId of registry.connectionsOf(s.id)) {
        const key = listedTools(s.id).join(',');
        if (lastListed.get(connId) === key) continue;
        conns.get(connId)?.send(TOOLS_LIST_CHANGED);
        lastListed.set(connId, key);
        deps.log.info('conduit-mcp', 'tools list_changed', {
          sessionId: s.id,
          handle: handleOf(s.id),
        });
      }
    }
  };

  // ---- ui state ---------------------------------------------------------------------------

  const badgeOf = (sessionId: string, handle: Handle): McpSessionBadge => {
    const r = runtime.get(sessionId);
    const pending = store.pending(handle);
    const unavailable = r?.unavailable ?? null;
    const adapter = noticeAdapterOf(sessionId);
    const gate: McpGateState | null =
      unavailable !== null || (adapter === null && !registry.isLive(sessionId))
        ? null
        : adapter === null || !notifiable(adapter)
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
    const listed = new Set<string>();
    for (const { session: s, handle } of listedSessions()) {
      sessions[s.id] = badgeOf(s.id, handle);
      listed.add(s.id);
    }
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
      // A listed shell gets per-session tool overrides too (plan amendment S1); one B2 hides has
      // no badge to hang the menu on.
      switchable: deps.mgr
        .list()
        .flatMap((s) => (hasDefAdapter(s.id) || listed.has(s.id) ? [s.id] : [])),
      notConnected: deps.messagingOn()
        ? Object.fromEntries(
            [...runtime].flatMap(([id, r]) => (r.notConnected ? [[id, r.notConnected]] : [])),
          )
        : {},
      awaitingApproval: flow.awaitingApproval(),
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

  /**
   * Closes once each connection has written the replies it still owes: a deleted session's
   * cancelled asks are answered a few microtasks after flow.sessionGone, and close() destroys the
   * socket at once (spec 2026-10-30-conduit-mcp-tool-policy §2.4: session closed → cancelled).
   */
  const drainConnectionsOf = (sessionId: string) => {
    for (const [id, s] of connSession) {
      if (s !== sessionId) continue;
      if (answering.get(id)) draining.add(id);
      else conns.get(id)?.close();
    }
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

  const detectTyped = (sessionId: string, data: string) => {
    const r = runtime.get(sessionId);
    if (!r?.tracker) return;
    // Focus reports and device-attribute replies would mark the line unknown (plan amendment N2).
    // Ctrl+Z hands the prompt back to the shell while the CLI's connection stays open.
    if (r.bound !== undefined && data.includes('\x1a')) unbind(r);
    const lines = r.tracker.feed(stripTerminalReplies(data));
    // While bound, a typed line is a prompt to that CLI, not a command line. An Enter with nothing
    // typed answers the starting CLI's own dialog only while that CLI is fresh; later it may be a
    // history recall (spec §2.4 A1, F6, D-F6).
    if (r.bound === undefined) {
      const t = now();
      for (const line of lines) {
        if (line.typed) r.lastLine = { cli: line.cli, at: t };
        else if (r.lastLine && t - r.lastLine.at > UNTYPED_ENTER_KEEP_MS) r.lastLine = undefined;
      }
    }
    // Ctrl+C / Ctrl+D is how a CLI that never connected is left; its line must not bind a later
    // client (spec §2.4 A1, SF-1 ruling).
    if (r.bound === undefined && (data.includes('\x03') || data.includes('\x04'))) {
      r.lastLine = undefined;
    }
    const cli = lines
      .map((l) => l.cli)
      .filter((c) => c !== null)
      .at(-1);
    // A CLI already live here sees this line as its own prompt input, not a command (plan Decisions).
    if (cli === undefined || registry.isLive(sessionId)) return;
    r.detect = { cli, at: now() };
  };

  /** A typed CLI that hasn't initialized within the grace never reached this host (spec §2.5). */
  const detectPass = () => {
    const t = now();
    for (const r of runtime.values()) {
      if (!r.detect || t - r.detect.at < detectGraceMs) continue;
      const { cli } = r.detect;
      r.detect = undefined;
      r.notConnected = {
        cli,
        install: deps.installState(cli),
        launch: r.launch,
        reason: 'no-initialize',
      };
      scheduleBroadcast();
    }
  };

  const tick = async () => {
    if (stopped) return;
    // Before the notifier check: detection must not wait for the message store to load.
    detectPass();
    if (!notifier) return;
    // Badge gate state for every notifiable session, then the notifier's own pass.
    for (const s of notifierSessions()) await evaluate(s.sessionId);
    await notifier.tick();
  };

  /**
   * Any session may run a CLI the user installed Conduit into: it gets identity env, but a handle
   * only when a CLI initializes (spec 2026-10-27-conduit-mcp-install §3.1).
   */
  const wireWithoutAdapter = (sessionId: string, r: Runtime, spec: SpawnSpec): SpawnSpec => {
    if (!deps.messagingOn() || !endpointReady) return spec;
    const token = randomToken();
    registry.mint(sessionId, token);
    r.tracker = createTypedLineTracker();
    return {
      ...spec,
      env: { ...spec.env, CONDUIT_SESSION_TOKEN: token, CONDUIT_MCP_ENDPOINT: deps.endpointPath },
    };
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
      // A listen that throws is a down endpoint like a refused one; either way the launches
      // waiting on it go now, as endpoint-down, rather than at the bound.
      try {
        if (deps.listen !== false) {
          const create = deps.createEndpoint ?? createMcpEndpoint;
          endpoint = create({ path: deps.endpointPath, onConnection, log: deps.log });
          const r = await endpoint.listen();
          endpointReady = r.ok;
        } else endpointReady = true;
      } catch (err) {
        endpointReady = false;
        deps.log.error('conduit-mcp', 'endpoint listen threw', { err: String(err) });
      } finally {
        settleEndpoint();
      }
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

    // Every definition waits, not only adapters: a shell restored at start would otherwise launch
    // tokenless before the endpoint listens (plan amendment B1).
    whenLaunchReady() {
      if (endpointSettled || !deps.messagingOn()) return Promise.resolve();
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
      if (!session) return spec;
      const r = rt(sessionId);
      r.defAdapter = adapter;
      r.unavailable = null;
      r.launch += 1;
      r.tracker = undefined;
      r.lastLine = undefined;
      r.bound = undefined;
      r.detect = undefined;
      if (r.notConnected) {
        r.notConnected = undefined;
        scheduleBroadcast();
      }
      registry.revoke(sessionId);
      if (!adapter) return wireWithoutAdapter(sessionId, r, spec);
      if (claimHandle(sessionId, adapter.id) === null) return spec;

      const unavailable = (reason: McpUnavailableReason) => {
        r.unavailable = reason;
        scheduleBroadcast();
        return spec;
      };
      if (!deps.messagingOn()) return unavailable('messaging-off');
      if (!endpointReady) return unavailable('endpoint-down');
      if (adapter.wiring === 'cursor-global' && !readCursorLaunchEntry(deps.homeDir)) {
        r.notConnected = {
          cli: 'cursor',
          install: deps.installState('cursor'),
          launch: r.launch,
          reason: 'cursor-not-connected',
        };
        return unavailable('cursor-not-connected');
      }
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
        env: {
          ...spec.env,
          CONDUIT_SESSION_TOKEN: token,
          CONDUIT_MCP_ENDPOINT: deps.endpointPath,
        },
      };
    },

    onSpawn(sessionId, cols, rows) {
      const r = runtime.get(sessionId);
      if (!r) return;
      r.size = { cols, rows };
      r.spawnedAt = now();
      r.hasDraft = false;
      r.lastInputAt = undefined;
      // A CLI paints its UI before it initializes and never fully repaints (spec §2.4 D6).
      if (r.tracker) screens.keepTail(sessionId, cols, rows);
      if (!r.defAdapter || r.unavailable) return;
      screens.start(sessionId, cols, rows);
    },

    onOutput(sessionId, data) {
      screens.feed(sessionId, data);
    },

    onResize(sessionId, cols, rows) {
      const r = runtime.get(sessionId);
      if (r) r.size = { cols, rows };
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
      r.tracker = undefined;
      r.lastLine = undefined;
      r.bound = undefined;
      r.detect = undefined;
      r.notConnected = undefined;
      scheduleBroadcast();
    },

    onRendererInput(sessionId, data) {
      // Ahead of noteInput's filter, which serves the notice gate's draft state only.
      detectTyped(sessionId, data);
      if (!noteInput(sessionId, data)) return;
      const handle = handleOf(sessionId);
      if (handle) dispatch({ t: 'renderer-input', handle });
    },

    // One read per CLI shown, not per session: ~/.claude.json can be several MB (plan amendment S4).
    onInstallChanged() {
      const read = new Map<AgentCli, UserInstallState>();
      for (const r of runtime.values()) {
        const nc = r.notConnected;
        if (!nc) continue;
        let install = read.get(nc.cli);
        if (install === undefined) {
          install = deps.installState(nc.cli);
          read.set(nc.cli, install);
        }
        if (install !== nc.install) {
          r.notConnected = { ...nc, install };
          scheduleBroadcast();
        }
      }
    },

    noteHostInput(sessionId, data) {
      noteInput(sessionId, data);
    },

    async onSessionDeleted(sessionId) {
      // Before the drain: the session's waiting asks end now, so their cancelled replies are owed.
      flow.sessionGone(sessionId);
      const handle = handleOf(sessionId);
      registry.revoke(sessionId);
      drainConnectionsOf(sessionId);
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

    onWindowReset(windowId) {
      flow.windowReset(windowId);
    },

    onSessionMoved(sessionId) {
      flow.sessionMoved(sessionId);
    },

    refresh() {
      syncToolLists();
      flow.recheck();
      scheduleBroadcast();
    },

    uiState,

    async handleRenderer(m, reply, senderId) {
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
        case 'mcp:setToolPolicy': {
          const refuse = (error: 'unknown-session' | 'unknown-tool' | 'invalid-value') =>
            reply({ type: 'mcp:toolPolicyResult', requestId: m.requestId, ok: false, error });
          if (!deps.mgr.get(m.sessionId)) return refuse('unknown-session');
          if (!isToolName(m.tool)) return refuse('unknown-tool');
          // The renderer is never load-bearing: the patch is re-checked here.
          const patch = coercePolicyPatch(m.tool, m.patch);
          if (!patch) return refuse('invalid-value');
          deps.mgr.setMcpToolPolicy(m.sessionId, m.tool, patch);
          reply({ type: 'mcp:toolPolicyResult', requestId: m.requestId, ok: true });
          syncToolLists();
          flow.recheck();
          scheduleBroadcast();
          return;
        }
        case 'mcp:askAnswer': {
          const answer: unknown = m.answer;
          if (
            typeof m.askId !== 'string' ||
            (answer !== 'approve' && answer !== 'deny' && answer !== 'always')
          )
            return;
          // Only the window holding the card may answer it (spec §2.4, plan r1 #3).
          if (!flow.answer(m.askId, senderId, answer))
            deps.log.info('conduit-mcp', 'ask answer ignored', { askId: m.askId, senderId });
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
      flow.dispose();
      for (const c of conns.values()) c.close();
      await endpoint?.close();
    },
  };
}
