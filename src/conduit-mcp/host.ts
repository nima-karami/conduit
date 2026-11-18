import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../atomic-write';
import {
  claudeHookSettings,
  claudeSettingsFileOf,
  statusLineWrapFor,
} from '../claude-hook-settings';
import type { ClaudeAction } from '../claude-tool-actions';
import { readUserStatusLine } from '../claude-user-status-line';
import { detectStuckScreen, type StuckScreen } from '../cli-stuck-screens';
import type { CodexAction } from '../codex-rollout';
import type { RoutedTool, WireRecipientOutcome } from '../contracts/link-protocol';
import type { NativeSelection, NativeSessionUi } from '../contracts/native-launch';
import type { RemoteCaller } from '../contracts/remote-principal';
import type { DraftPort, LaunchPort, McpHostDeps, ObservedEntry } from '../contracts/server-ports';
import type { CliBindingRecord } from '../contracts/session-identity';
import type { LaunchIds } from '../contracts/terminal-runtime';
import { inputBoxTop } from '../input-box-rows';
import type { HostPlatform } from '../lsp-binary';
import { mcpLaunchWiring, mcpServerCommand } from '../mcp-launch';
import { prepareNativeLaunch } from '../native-launch';
import { parseAddress } from '../network/addresses';
import type { HostToWebview, WebviewToHost } from '../protocol';
import type { SubmitOutcome } from '../pty-writer';
import { readCappedBytes } from '../read-capped';
import { COMMAND_AGENT_ID } from '../session-command';
import { PTY_SETTLE_MS } from '../timed-messages';
import type { AgentDefinition, SessionOpener, SpawnSpec } from '../types';
import type { ActivityIo, ActivityOutcome } from './activity-log';
import { createActivityIo } from './activity-log-fs';
import { parseActivityQuery } from './activity-query';
import {
  adapterFor,
  MCP_ADAPTERS,
  type McpAdapter,
  modelFlagOf,
  notifiable,
  queuesMidTurn,
} from './adapters';
import { agentListing, listAgentsOutput } from './agent-listing';
import { registeredIdFor } from './agent-resolve';
import { createAppControlHandlers } from './app-control-tools';
import { snapshotAttachment } from './attachments';
import { type AttentionEvent, reduceAttention, youAttention } from './attention-items';
import {
  type AskCommit,
  askBudgetMs,
  commitFailure,
  createCallFlow,
  grantFailureMessage,
  type InFlight,
  NO_OWNER_WINDOW,
  SCOPE_UNAVAILABLE,
} from './call-flow';
import {
  bindsTypedLine,
  type ClientKind,
  clientKindOf,
  initializeClientName,
  pickNoticeAdapterId,
} from './client-info';
import {
  type ControlCallContext,
  type ControlDeps,
  createControlHandlers,
  type Prepared,
  reachAdmits,
} from './control-tools';
import { isCountedInput, nextDraftState, settleDraft, stripTerminalReplies } from './draft-input';
import {
  GRANT_CHOICE_ON,
  GRANT_FORS,
  GRANT_WHO_KINDS,
  type GrantChoice,
  grantScopeFor,
  grantWhoFor,
} from './grant-store';
import {
  agentHandlePrefix,
  cliKindOfHandle,
  type HandleCounters,
  handlePrefixForCommand,
  parseHandleCounters,
  serializeHandleCounters,
} from './handles';
import { readCursorLaunchEntry } from './install';
import { type AgentCli, CLI_DISPLAY_NAME, type UserInstallState } from './install-types';
import {
  createMcpServerCore,
  TOOLS_LIST_CHANGED,
  type ToolCallContext,
  type ToolCallResult,
} from './json-rpc';
import { createMachineTools } from './machine-tools';
import {
  awaitEnterVerdict,
  ECHO_POLL_MS,
  evaluateEnterRecheck,
  evaluateGate,
  type GateVerdict,
  IDLE_QUIET_MS,
  LATE_ECHO_POLL_MS,
  LATE_ECHO_WAIT_MS,
} from './notice-gate';
import { composeUnreadBanner } from './notice-text';
import { type AttentionRaise, bannerCandidates, createNotifier, type Notifier } from './notifier';
import { reasonText, samePath } from './policy-engine';
import { validatePolicyAssignment, validatePolicyProfile } from './policy-file';
import { createPolicyIo, POLICY_MAX_BYTES, type PolicyIo } from './policy-file-fs';
import { isNativeFamily } from './policy-native';
import { createPolicyService } from './policy-service';
import { forcesAsk, resolveTargets, type TargetDeps } from './policy-targets';
import type {
  ActivityDecisionTraceV1,
  Assignment,
  AssignmentPoint,
  GrantBatchResult,
  LocalPolicyEdit,
  OneUseOverride,
  PolicyDecision,
  PolicyInput,
  PolicyTarget,
  Principal,
} from './policy-types';
import { createRemotePolicy, REMOTE_POLICY_DRAFTS_MAX_BYTES } from './remote-policy';
import {
  checkRemoteAnswer,
  createRemoteRequests,
  mergeListRequests,
  mergeRemoteRequests,
  type RemoteRequestRef,
  unreachableRemote,
} from './remote-requests';
import {
  isKnownMachine,
  isRoutedCall,
  type McpNetworkPort,
  machineTarget,
  nameOnMachine,
  type RemoteRecipientOutcome,
  type RemoteResolution,
  type RoutedIntent,
  remoteGrantOf,
  routedAskSummary,
  routedIntentOf,
  routedName,
  routedRefOf,
} from './remote-routing';
import { createRequestsIo } from './request-file-fs';
import { createRequestNotices } from './request-notices';
import { createRequestService, type RequestService } from './request-service';
import type { QuestionMessage, SessionNeedsYou } from './request-sources';
import type {
  AnswerInput,
  AnswerRefusal,
  RequestAnswerResult,
  RequestRecord,
} from './request-types';
import { createScreenToolHandlers } from './screen-tools';
import { type ScreenSnapshot, screenVerdict } from './screen-verdict';
import { assignHandle, createSessionRegistry } from './session-registry';
import {
  clampWaitTimeout,
  createSessionWaits,
  parseWaitArgs,
  WAIT_MAX_PER_CALLER,
  type WaitOutput,
  type WaitTarget,
} from './session-waits';
import { isStartupPrompt } from './startup-prompt';
import { createMessageStore, type StoreIo } from './store';
import { createFsStoreIo } from './store-fs';
import {
  CLI_KINDS,
  type CliKind,
  gateToolCall,
  isMessagingTool,
  isRequestTool,
  isToolName,
  NOT_IN_SESSION_HINT,
  type PolicySource,
  TOOL_NAMES,
  type ToolName,
  toolDisabled,
  windowNotReady,
} from './tool-policy';
import { CONDUIT_INSTRUCTIONS, toolSchemas } from './tool-schemas';
import {
  attachmentRecords,
  type Caller,
  createToolHandlers,
  type DirectoryEntry,
  RATE_LIMIT_PER_MIN,
  RATE_WINDOW_MS,
  type StructuredOutput,
  toToolCallResult,
} from './tools';
import {
  createTypedLineTracker,
  DETECT_GRACE_MS,
  type TypedLineTracker,
  UNTYPED_ENTER_KEEP_MS,
} from './typed-command';
import {
  type GateClosedReason,
  type Handle,
  HUMAN_HANDLE,
  type McpAttentionItem,
  type McpUnavailableReason,
  type MessageRecord,
  type Presence,
  type Result,
  type ScreenVerdict,
  THREAD_AGENT_LIMIT,
  type ThreadSummary,
  type ToolError,
  toolError,
} from './types';
import type {
  McpGateState,
  McpNotConnected,
  McpSessionBadge,
  McpThreadMessage,
  McpThreadSummary,
  McpUiState,
} from './ui-types';

export interface EndpointConnection {
  readonly id: number;
  readonly token: string | null;
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface McpEndpoint {
  listen(): Promise<Result<void>>;
  close(): Promise<void>;
}

type HostLog = Record<
  'debug' | 'info' | 'warn' | 'error',
  (scope: string, message: string, data?: Record<string, unknown>) => void
>;

export interface ConduitMcpHostDeps extends Omit<McpHostDeps, 'attention'> {
  attention: Pick<
    McpHostDeps['attention'],
    'statusOf' | 'lastOutputAt' | 'onChange' | 'setStuck' | 'needsYouFacts'
  >;
  dir: string;
  endpointPath: string;
  execPath: string;
  shimPath: string;
  /** The Claude hook client (resources/conduit-mcp/conduit-hook.cjs, copied); null = no hooks injected. */
  hookClientPath: string | null;
  /** Git Bash on Windows from its install paths (src/shells.ts), for the status line wrapper. */
  gitBashPath: () => string | undefined;
  homeDir: string;
  platform: HostPlatform;
  e2e: boolean;
  ownerWindowOf(sessionId: string): number | null;
  appConnected(): boolean;
  windowReady(windowId: number): boolean;
  onScreen(windowId: number, sessionId: string): boolean;
  detectGraceMs?: number;
  log: HostLog;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  storeIo?: StoreIo;
  policyIo?: PolicyIo;
  grantsIo?: PolicyIo;
  activityIo?: ActivityIo;
  listen?: boolean;
  tickMs?: number;
  createEndpoint(opts: {
    path: string;
    onConnection(conn: EndpointConnection): void;
    log: Pick<HostLog, 'debug' | 'warn'>;
  }): McpEndpoint;
  newAskId?: () => string;
  /**
   * D28: a shell's admitted typed-CLI binding, or null once it ends, so the embedder can persist it
   * and hand it back to resumeLaunch after a server restart. Not called while the host stops.
   */
  onBindingChanged?(sessionId: string, binding: Omit<CliBindingRecord, 'sessionId'> | null): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}
export type McpRendererMessage = Extract<WebviewToHost, { type: `mcp:${string}` }>;

/** A note row for a fact that has no session or call behind it (NET audit events). */
export interface ActivityNote {
  action: string;
  machineId: string | null;
  handle: string | null;
}

export interface ConduitMcpHost extends LaunchPort, DraftPort {
  start(): Promise<void>;
  /**
   * Resolves once a launch of `def` can be wired: at once for an agent with no adapter, else when
   * start's listen attempt settles, bounded by ENDPOINT_READY_WAIT_MS. A session restored at app
   * start launches before start() has listened; without the wait it would read endpoint-down.
   */
  whenLaunchReady(): Promise<void>;
  onRendererInput(sessionId: string, data: string): void;
  /** After an install action: re-reads the install state behind every notConnected entry. */
  onInstallChanged(): void;
  /** Input the host writes outside the PTY writer (the add-dir paste): it is a draft too. */
  noteHostInput(sessionId: string, data: string): void;
  onSessionDeleted(sessionId: string): Promise<void>;
  /** A closeWhenDone session's program exited on its own; closes it through close_session's routing. */
  closeWhenDone(sessionId: string): Promise<void>;
  /** Navigation start, renderer gone, or closed: that window's asks end `cancelled`. */
  onWindowReset(windowId: number): void;
  /** The session now belongs to another window: its asks end `cancelled`. */
  onSessionMoved(sessionId: string): void;
  /**
   * An adopted launch (C1 `spawned` with no prepareLaunch in this run): restores the per-launch
   * state prepareLaunch would have set, without reserving a token. With a binding of this
   * generation, the first connection whose initialize clientInfo.name matches is bound (D28).
   */
  resumeLaunch(
    sessionId: string,
    def: AgentDefinition,
    ids: LaunchIds,
    binding: CliBindingRecord | null,
  ): void;
  refresh(): void;
  uiState(): McpUiState;
  /** `senderId`: the window the message came from; an ask answer counts only from its own window. */
  handleRenderer(
    m: McpRendererMessage,
    reply: (msg: HostToWebview) => void,
    senderId: number,
  ): Promise<void>;
  tick(): Promise<void>;
  networkPort(): McpNetworkPort;
  /** A peer's link was revoked: its grants end. */
  peerRevoked(machineId: string): void;
  /** An audit event from the network, shown in the Activity log as a note row. */
  recordNote(note: ActivityNote): void;
  recordObserved(sessionId: string, cli: AgentCli, entry: ObservedEntry): void;
  stop(): Promise<void>;
}

// see plan C4 (activity privacy: no output, no arguments; a command keeps its first line only)
const OBSERVED_SUMMARY_MAX = 200;
const capSummary = (text: string): string =>
  Array.from(text).slice(0, OBSERVED_SUMMARY_MAX).join('');
const capOrNull = (text: string | null): string | null => (text === null ? null : capSummary(text));
// see plan m3: a busy agent must not flood the Activity log; the excess is counted, not stored
const OBSERVED_ROWS_PER_MINUTE = 120;
interface ObservedBudget {
  minute: number;
  cli: AgentCli;
  rows: number;
  dropped: number;
  timer: { handle: unknown } | null;
}
const MINUTE_MS = 60_000;
function observedRow(action: ClaudeAction | CodexAction): {
  action: string;
  target: string | null;
  summary: string | null;
  durationMs: number | null;
  exitedNonZero: boolean;
} {
  const durationMs = 'durationMs' in action ? action.durationMs : null;
  const exitedNonZero = 'exitCode' in action && action.exitCode !== null && action.exitCode !== 0;
  switch (action.kind) {
    case 'command': {
      const firstLine = action.command.split(/\r\n|\r|\n/)[0] ?? '';
      return {
        action: 'command',
        target: action.cwd,
        summary: capSummary(firstLine),
        durationMs,
        exitedNonZero,
      };
    }
    case 'file-change':
      return {
        action: 'file-change',
        target: action.paths[0] ?? null,
        summary: action.paths.length > 0 ? capSummary(action.paths.join(', ')) : null,
        durationMs,
        exitedNonZero,
      };
    case 'mcp':
      return {
        action: 'mcp',
        target: action.server,
        summary: action.tool,
        durationMs,
        exitedNonZero,
      };
  }
}

const TICK_MS = 500;
const STUCK_CHECK_MS = 1_000;
/** closeWhenDone is not a CLI call: no connection owns its UI wait (see ConduitMcpHost.closeWhenDone). */
const UNTRACKED_CONN = -1;
const SUBMIT_CONFIRM_WAIT_MS = 2_000;
const RETENTION_EVERY_MS = 6 * 60 * 60 * 1000;
const BROADCAST_COALESCE_MS = 150;
const MAX_UI_THREADS = 500;
// A remote lead's ask waits this long for the owner, inside the lead's 60 s routed cap (CON-42 decision 1).
const REMOTE_ASK_MS = 45_000;

type PreparedPolicyConditions = Readonly<Pick<PolicyDecision['rule'], 'when' | 'reach' | 'move'>>;
const samePreparedConditions = (
  rule: PolicyDecision['rule'],
  conditions: PreparedPolicyConditions,
): boolean =>
  rule.when === conditions.when && rule.reach === conditions.reach && rule.move === conditions.move;

type SealedPolicyTrace = {
  input: Omit<PolicyInput, 'now'>;
  decision: PolicyDecision;
  trace: ActivityDecisionTraceV1;
  reason: string;
};
const traceableSingle = (
  tool: ToolName,
  args: Record<string, unknown>,
  targets: readonly PolicyTarget[],
): boolean => {
  if (targets.length !== 1) return false;
  switch (tool) {
    case 'open_session':
    case 'open_terminal':
      return typeof args.path === 'string' && args.machine === undefined;
    case 'open_file':
      return (
        (typeof args.path === 'string' && args.paths === undefined) ||
        (args.path === undefined &&
          Array.isArray(args.paths) &&
          args.paths.length === 1 &&
          typeof args.paths[0] === 'string')
      );
    case 'close_session':
      return (
        typeof args.session === 'string' && args.sessions === undefined && args.children !== true
      );
    case 'send_input':
    case 'read_screen':
    case 'focus_session':
      return typeof args.session === 'string';
    case 'send_message':
      return Array.isArray(args.to) && args.to.length === 1 && typeof args.to[0] === 'string';
    case 'open_review':
    case 'open_git_history':
      return typeof args.repo === 'string';
    case 'open_diff':
      return typeof args.patch_file === 'string';
    default:
      return false;
  }
};

/** How the owner's end of a remote ask reads to the lead's call: an allow, or the refusal it means. */
const ownerOutcomeOf = (r: RequestRecord, withdrawalError?: ToolError): Result<AnswerInput> => {
  if (r.state === 'answered' && r.answer !== null) {
    return r.answer.outcome === 'allowed'
      ? { ok: true, value: r.answer }
      : { ok: false, error: toolError('denied', 'the owner declined the request') };
  }
  if (r.state === 'expired')
    return { ok: false, error: toolError('approval_timeout', 'the owner did not answer in time') };
  if (r.state === 'withdrawn' && withdrawalError) return { ok: false, error: withdrawalError };
  if (r.state === 'withdrawn')
    return {
      ok: false,
      error: toolError('server_stopping', 'Conduit stopped before the owner answered'),
    };
  return {
    ok: false,
    error: toolError('cancelled', 'the request ended before the owner answered'),
  };
};

/** The peer refusal a failed remote answer carries to the renderer; other failures stay not_answerable. */
const peerRefusalOf = (code: string): AnswerRefusal =>
  code === 'peer_unreachable' || code === 'peer_incompatible' || code === 'peer_revoked'
    ? code
    : 'not_answerable';

const outcomeOfRemoteError = (
  code: string,
  decision: PolicyDecision['decision'],
): ActivityOutcome => {
  if (code === 'denied' || decision === 'deny') return 'denied';
  if (code === 'approval_timeout') return 'expired';
  if (code === 'server_stopping') return 'withdrawn';
  return 'error';
};

const LAUNCH_DIR = 'launch';
const HANDLES_FILE = 'handles.json';
const VERSION = '1';
/** How long a launch waits for the endpoint (conductor decision; plan Decisions). */
export const ENDPOINT_READY_WAIT_MS = 3_000;
/** Approval dialogs only appear mid-turn and some take single-letter answers: re-read before typing. */
export const QUEUE_STABLE_MS = 250;

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
  /** What the bound connection was admitted as, for onBindingChanged. */
  boundAs: { cli: AgentCli; clientInfoName: string } | undefined;
  /** A resumed binding waiting for its client's initialize (D28). */
  rebind: CliBindingRecord | undefined;
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
  const sendToOwner = (sessionId: string, message: HostToWebview) =>
    deps.emit('ui.post', { route: { kind: 'owner', sessionId }, message });
  const sendToWindow = (windowId: number, message: HostToWebview) =>
    deps.emit('ui.post', { route: { kind: 'window', windowId }, message });
  const broadcast = (message: HostToWebview) =>
    deps.emit('ui.post', { route: { kind: 'broadcast' }, message });
  const flashOwner = (sessionId: string) => deps.emit('attention.flash', { sessionId });
  const resolveToken = (token: string | null): string | null => {
    if (token === null) return null;
    const result = deps.tokens.rows();
    if (result.state !== 'loaded') return null;
    const hash = createHash('sha256').update(token).digest('hex');
    return (
      result.rows.find((row) => row.sha256 === hash && row.state !== 'superseded')?.sessionId ??
      null
    );
  };
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const detectGraceMs = deps.detectGraceMs ?? DETECT_GRACE_MS;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ??
    ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout> | undefined));
  const observedBudget = new Map<string, ObservedBudget>();
  // Rows arriving while a delete is pending must not revive the session's budget.
  const deleting = new Set<string>();
  const noteRow = (sessionId: string, cli: AgentCli, action: string, summary: string): void => {
    policyService.activity.record({
      lane: 'note',
      principal: { handle: handleOf(sessionId) ?? null, sessionId, machineId: null },
      cli,
      action: capSummary(action),
      target: null,
      summary: capSummary(summary),
      decision: null,
      decidedBy: 'conduit',
      outcome: null,
      durationMs: null,
      requestId: null,
      count: null,
    });
  };
  const flushThrottle = (sessionId: string, budget: ObservedBudget): void => {
    if (budget.timer !== null) {
      clearTimer(budget.timer.handle);
      budget.timer = null;
    }
    if (budget.dropped === 0) return;
    const n = budget.dropped;
    budget.dropped = 0;
    noteRow(
      sessionId,
      budget.cli,
      'feed-throttled',
      `Feed throttled: ${n} ${n === 1 ? 'action' : 'actions'} not logged`,
    );
  };
  const budgetFor = (sessionId: string, cli: AgentCli, minute: number): ObservedBudget => {
    const current = observedBudget.get(sessionId);
    if (current && current.minute === minute) return current;
    if (current) flushThrottle(sessionId, current);
    const fresh: ObservedBudget = { minute, cli, rows: 0, dropped: 0, timer: null };
    observedBudget.set(sessionId, fresh);
    return fresh;
  };
  const forgetBudget = (sessionId: string): void => {
    const budget = observedBudget.get(sessionId);
    if (!budget) return;
    if (budget.timer !== null) clearTimer(budget.timer.handle);
    observedBudget.delete(sessionId);
  };
  const store = createMessageStore(deps.storeIo ?? createFsStoreIo(deps.dir));
  const screens = deps.screens;
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
  let startupSweep: Promise<void> | undefined;
  const lateEchoWatchers = new Map<string, () => void>();

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
        boundAs: undefined,
        rebind: undefined,
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

  const handleOf = (sessionId: string): Handle | undefined =>
    deps.sessions.get(sessionId)?.mcpHandle;
  /** closeWhenDone waits still open, keyed by session; a delete during one means the close happened. */
  const closingWhenDone = new Map<string, { deleted: boolean }>();
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
  /** The CLI whose stuck screens the feed reads; a shell or a fake client has none. */
  const cliKindOf = (sessionId: string) => {
    const id = noticeAdapterOf(sessionId)?.id;
    return id === 'claude' || id === 'codex' || id === 'cursor' ? id : null;
  };
  /** Per session: when the screen was last read, at which output stamp, and what it showed. */
  const stuckFeed = new Map<string, { at: number; outputAt: number; stuck: StuckScreen | null }>();
  /** list_sessions' notices: typed when the session's adapter can push notices, else the agent pulls. */
  const noticesOf = (sessionId: string): 'typed' | 'pull' => {
    const a = noticeAdapterOf(sessionId);
    return a !== null && notifiable(a) ? 'typed' : 'pull';
  };
  /** Every change of a binding goes through here, so the embedder's copy never drifts. */
  const setBound = (
    sessionId: string,
    r: Runtime,
    next: { connId: number; cli: AgentCli; clientInfoName: string } | undefined,
  ) => {
    const had = r.bound !== undefined;
    r.bound = next?.connId;
    r.boundAs = next && { cli: next.cli, clientInfoName: next.clientInfoName };
    // A stopping host closes every connection; the binding must outlive that for the resume.
    if (stopped) return;
    if (next)
      deps.onBindingChanged?.(sessionId, {
        generation: r.launch,
        cli: next.cli,
        clientInfoName: next.clientInfoName,
      });
    else if (had) deps.onBindingChanged?.(sessionId, null);
  };
  const unbind = (sessionId: string, r: Runtime) => {
    setBound(sessionId, r, undefined);
    r.lastLine = undefined;
    scheduleBroadcast();
  };
  const hasDefAdapter = (sessionId: string): boolean => {
    const def = deps.domain.defOf(sessionId);
    return def !== undefined && adapterFor(def, { e2e: deps.e2e }) !== undefined;
  };
  /**
   * A lazily named shell is listed only while a CLI is live in it or it has message history, so a
   * health check (`claude mcp list`) doesn't enrol it for good (plan amendment B2). A session an
   * agent opened stays listed while it exists, so its opener can see and close it (CON-149).
   */
  const listedSessions = () => {
    let talked: Set<Handle> | undefined;
    const hasHistory = (h: Handle) => {
      talked ??= new Set(store.available() ? store.threads().flatMap((t) => t.participants) : []);
      return talked.has(h);
    };
    return deps.sessions.list().flatMap((s) => {
      const handle = s.mcpHandle;
      if (!handle) return [];
      const listed =
        hasDefAdapter(s.id) ||
        registry.isLive(s.id) ||
        hasHistory(handle) ||
        s.openedBy !== undefined;
      return listed ? [{ session: s, handle }] : [];
    });
  };
  const sessionOfHandle = (h: Handle): string | null =>
    deps.sessions.list().find((s) => s.mcpHandle === h)?.id ?? null;

  const scheduleBroadcast = () => {
    if (stopped || broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      broadcast({ type: 'mcp:state', state: uiState() });
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
  const sessionWaits = createSessionWaits({
    setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimer:
      deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout> | undefined)),
    read: (callerHandle, target) => {
      if (target.handle.includes('@')) {
        const reading = deps.network?.waitReading(target.handle, callerHandle);
        if (!reading || reading === 'unreachable')
          return {
            error: toolError('peer_unreachable', `peer for ${target.handle} is unreachable`),
          };
        const parsed = parseAddress(target.handle);
        if (!parsed?.machine || !deps.network?.peerCapabilitiesOf(parsed.machine)?.monitor)
          return {
            error: toolError('capability_off', `peer has not enabled monitor for ${target.handle}`),
          };
        return {
          ...reading,
          sessionId: target.sessionId,
          unreadFrom: store.available()
            ? store.pending(callerHandle).filter((m) => m.from === target.handle).length
            : 0,
        };
      }
      const snap = deps.attention.statusOf(target.sessionId);
      return {
        ...target,
        presence: presenceOf(target.sessionId),
        needsYou: snap.attentionReason !== null,
        completions: snap.completions,
        unreadFrom: store.available()
          ? store.pending(callerHandle).filter((m) => m.from === target.handle).length
          : 0,
      };
    },
  });
  store.onChange(() => {
    deriveAttentionFromStore();
    scheduleBroadcast();
    sessionWaits.notify();
    if (store.available()) {
      requestService.retryDeliveries();
      requestService.onQuestions(unreadQuestions());
    }
  });
  // Set by start: a host that never listened has no connections, so no waits to wake.
  let stopAttentionWatch: (() => void) | undefined;
  let stopGrantEligibilityWatch: (() => void) | undefined;
  let stopNetworkWatch: (() => void) | undefined;

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
    if (!(deps.runtime.get(sessionId)?.state === 'live')) return 'exited';
    return deps.attention.statusOf(sessionId).busy ? 'busy' : 'idle';
  };

  const directory = (): DirectoryEntry[] =>
    listedSessions().map(({ session: s, handle }) => ({
      handle,
      sessionId: s.id,
      openedBy: s.openedBy?.sessionId ?? null,
      remoteOpener: remoteOpenerOf(s.openedBy),
      label: s.name,
      // A profile session is its definition's agent whatever client name it sends, as for notices.
      agent: (hasDefAdapter(s.id) ? undefined : liveKinds(s.id).at(-1)) ?? handlePrefix(handle),
      project: deps.domain.projectName(s.projectId),
      home: s.home,
      roots: [...s.roots],
      presence: presenceOf(s.id),
      messaging: registry.isLive(s.id) ? 'connected' : 'unavailable',
      connectable: hasDefAdapter(s.id),
      notices: noticesOf(s.id),
    }));

  const newId = (prefix: 'm' | 't') => `${prefix}_${base32(randomBytes(10))}`;
  // Without a network no machine name resolves; saying so beats treating the target as local.
  const localResolve = (target: string): RemoteResolution =>
    target.includes('@')
      ? { kind: 'unknown', hint: 'no linked machines' }
      : { kind: 'local', handle: target };
  const storedFollowUp = (msg: MessageRecord) => {
    if (msg.from === HUMAN_HANDLE) dispatch({ t: 'thread-reset', threadId: msg.threadId });
    scheduleBroadcast();
  };
  const threadLimitHit = (threadId: string, by: string) => {
    dispatch({ t: 'thread-limit', threadId, handle: by, at: new Date(now()).toISOString() });
  };

  // Rate and in-flight dedupe are per sending handle and per message id. A resend of a stored id
  // acks without a second append (plan decision 8), and one that races its first copy waits for it.
  const inboundSends = new Map<string, number[]>();
  const inboundInFlight = new Map<string, Promise<WireRecipientOutcome[]>>();
  const refuseAll = (
    to: string[],
    reason: NonNullable<WireRecipientOutcome['reason']>,
  ): WireRecipientOutcome[] => to.map((handle) => ({ handle, status: 'refused', reason }));
  const storeInbound = async (
    msg: MessageRecord & { origin: string },
    blobs: { name: string; mime: string; bytes: Buffer }[],
    framedAsHuman: boolean,
  ): Promise<WireRecipientOutcome[]> => {
    const t = now();
    // A handle leaves the map once its window is empty; the sender's handle is peer-chosen and
    // rotates, so a key kept past its window would grow the map without bound.
    for (const [handle, times] of inboundSends) {
      const live = times.filter((x) => t - x < RATE_WINDOW_MS);
      if (live.length === 0) inboundSends.delete(handle);
      else inboundSends.set(handle, live);
    }
    const sends = inboundSends.get(msg.from) ?? [];
    if (!framedAsHuman && store.agentCountSinceHuman(msg.threadId) >= THREAD_AGENT_LIMIT) {
      threadLimitHit(msg.threadId, msg.from);
      return refuseAll(msg.to, 'thread_limit');
    }
    if (sends.length >= RATE_LIMIT_PER_MIN) return refuseAll(msg.to, 'rate_limited');
    const byHandle = new Map(directory().map((e) => [e.handle, e]));
    const outcomes: WireRecipientOutcome[] = [];
    const deliveredTo = new Set<string>();
    for (const to of msg.to) {
      const parsed = parseAddress(to);
      const entry = parsed === null ? undefined : byHandle.get(parsed.handle);
      if (parsed === null || entry === undefined) {
        outcomes.push({ handle: to, status: 'refused', reason: 'unknown_session' });
      } else if (entry.messaging === 'unavailable' && !entry.connectable) {
        outcomes.push({ handle: to, status: 'refused', reason: 'not_messageable' });
      } else {
        deliveredTo.add(parsed.handle);
        outcomes.push({ handle: to, status: 'delivered', reason: null });
      }
    }
    if (deliveredTo.size === 0) return outcomes;
    // The sender's attachment metadata is not trusted: the hashes are taken from the bytes here.
    const written = attachmentRecords(
      blobs.map((b) => ({
        name: b.name,
        mime: b.mime,
        data: b.bytes,
        sha256: createHash('sha256').update(b.bytes).digest('hex'),
      })),
    );
    // requestId is dropped: a remote message must not answer a local request.
    const record: MessageRecord = {
      messageId: msg.messageId,
      threadId: msg.threadId,
      originMessageId: msg.originMessageId,
      originThreadId: msg.originThreadId,
      from: msg.from,
      to: [...deliveredTo],
      subject: msg.subject,
      kind: msg.kind,
      priority: msg.priority,
      sentAt: msg.sentAt,
      body: msg.body,
      attachments: written.attachments,
      origin: msg.origin,
    };
    if (framedAsHuman) record.originHuman = true;
    const appended = await store.append(record, written.blobs);
    if (!appended.ok) {
      deps.log.warn('conduit-mcp', 'inbound message not stored', {
        messageId: msg.messageId,
        code: appended.error.code,
      });
      // Rejecting leaves the sender's copy unacked, so it is resent rather than marked refused.
      throw new Error(appended.error.message);
    }
    sends.push(t);
    inboundSends.set(msg.from, sends);
    storedFollowUp(record);
    return outcomes;
  };
  const deliverInbound = (
    msg: MessageRecord & { origin: string },
    blobs: { name: string; mime: string; bytes: Buffer }[],
    framedAsHuman: boolean,
  ): Promise<WireRecipientOutcome[]> => {
    if (!deps.domain.messagingOn()) return Promise.resolve(refuseAll(msg.to, 'messaging_off'));
    if (store.has(msg.messageId)) {
      return Promise.resolve(
        msg.to.map(
          (handle): WireRecipientOutcome => ({ handle, status: 'delivered', reason: null }),
        ),
      );
    }
    const inFlight = inboundInFlight.get(msg.messageId);
    if (inFlight !== undefined) return inFlight;
    const run = storeInbound(msg, blobs, framedAsHuman).finally(() => {
      inboundInFlight.delete(msg.messageId);
    });
    inboundInFlight.set(msg.messageId, run);
    return run;
  };

  const tools = createToolHandlers({
    store,
    directory,
    remote: () => deps.network?.remoteEntries() ?? [],
    resolve: (t) => deps.network?.resolve(t) ?? localResolve(t),
    enqueueRemote: (msg, entries) =>
      deps.network?.enqueue(msg, entries) ??
      entries.map(
        (e): RemoteRecipientOutcome => ({
          address: e.address,
          status: 'refused',
          reason: 'peer_unreachable',
        }),
      ),
    messagingOn: () => deps.domain.messagingOn(),
    now: () => new Date(now()),
    newId,
    snapshot: (sender, p) => snapshotAttachment(sender, p),
    onStored: storedFollowUp,
    onThreadLimit: threadLimitHit,
    warn: (message, data) => deps.log.warn('conduit-mcp', message, data),
    humanPresence: () => requestService.presence().state,
  });

  const answerOnly = (t: ThreadSummary): boolean =>
    t.messageCount === 1 && store.thread(t.threadId).every((m) => m.requestId !== undefined);

  const requestTimers = {
    setTimer: deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms)),
    clearTimer:
      deps.clearTimer ??
      ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout> | undefined)),
  };
  const notices = createRequestNotices({
    ...requestTimers,
    away: () => requestService.presence().state === 'away',
    emit: (e) => deps.emit('attention.edge', e),
  });

  // A's mirror of remote requests: B writes it over the link, nothing is stored (CON-42 decision 2).
  const remoteRequests = createRemoteRequests({ onChanged: () => scheduleBroadcast() });
  // A's copy of each dialed machine's rules and its drafts (CON-46 L4). Its in-memory edits run on
  // the same clock and timers as the local policy.
  const remotePolicy = createRemotePolicy({
    network: () => deps.network,
    draftsIo: createPolicyIo(path.join(deps.dir, 'remote-policy.json'), {
      maxBytes: REMOTE_POLICY_DRAFTS_MAX_BYTES,
    }),
    now,
    newId: () => randomBytes(12).toString('hex'),
    ...requestTimers,
    warn: (message, error) => deps.log.warn('conduit-mcp', message, { error: String(error) }),
  });
  remotePolicy.onChange(() => scheduleBroadcast());

  interface PendingRemotePermission {
    machineId: string;
    handle: string;
    tool: RoutedTool;
    targets: readonly PolicyTarget[];
    forceAsk: boolean;
    conditions: PreparedPolicyConditions;
    deadline: number;
    signal: AbortSignal;
    grantable: boolean;
    withdrawalError?: ToolError;
  }
  const pendingRemotePermissions = new Map<string, PendingRemotePermission>();

  const requestService: RequestService = createRequestService({
    io: createRequestsIo(path.join(deps.dir, 'requests.json')),
    machineId: deps.machineId,
    onRemotePermissionAnswer: (record, answer) => {
      const pending = pendingRemotePermissions.get(record.id);
      if (
        !pending ||
        record.remote?.machineId !== pending.machineId ||
        record.remote.handle !== pending.handle ||
        record.permission?.tool !== pending.tool
      )
        return {
          ok: false,
          reason: 'policy_unavailable',
          message: 'the remote permission is no longer pending',
        };
      if (pending.signal.aborted || now() >= pending.deadline)
        return {
          ok: false,
          reason: 'peer_unreachable',
          message: 'the remote call was cancelled or expired',
        };
      if (answer.outcome === 'denied') return { ok: true, createdGrantIds: [] };
      const fresh = freshRemotePolicy(pending, true);
      if (!fresh.ok) {
        pending.withdrawalError = fresh.error;
        requestService.endPermission(record.id, 'withdrawn', null, fresh.error.message, {
          kind: 'default',
        });
        return {
          ok: false,
          reason:
            fresh.error.code === 'peer_unreachable' ? 'peer_unreachable' : 'policy_unavailable',
          message: fresh.error.message,
        };
      }
      const choice = remoteGrantOf(answer, pending.grantable);
      if (answer.grant !== undefined && !pending.grantable)
        return {
          ok: false,
          reason: 'policy_unavailable',
          message: 'this permission cannot create a future grant',
        };
      if (choice === null) return { ok: true, createdGrantIds: [] };
      const made = grantsFor(
        choice,
        fresh.value.input.principal,
        pending.tool,
        pending.targets,
        record.id,
      );
      return made.ok
        ? { ok: true, createdGrantIds: made.grants.map((grant) => grant.id) }
        : { ok: false, reason: 'policy_unavailable', message: grantFailureMessage(made.error) };
    },
    rollbackRemotePermissionGrants: (_record, ids) => policyService.revokeGrants(ids),
    now,
    newId: () => `r_${base32(randomBytes(8))}`,
    ...requestTimers,
    warn: (message, data) =>
      deps.log.warn('conduit-mcp', message, {
        detail: data instanceof Error ? String(data) : data,
      }),
    stampOf: (sessionId) => {
      const seen = new Set<string>([sessionId]);
      let lead = sessionId;
      let opener = deps.sessions.get(lead)?.openedBy?.sessionId;
      while (opener !== undefined && !seen.has(opener) && deps.sessions.get(opener) !== undefined) {
        seen.add(opener);
        lead = opener;
        opener = deps.sessions.get(lead)?.openedBy?.sessionId;
      }
      return {
        session: sessionId,
        space: deps.sessions.get(sessionId)?.projectId ?? null,
        lead,
      };
    },
    budgetMs: (caller) =>
      askBudgetMs(
        cliKindOfHandle(caller.handle),
        caller.sessionId !== null && wiredAtLaunch(caller.sessionId),
      ),
    deliver: async (r) => {
      if (r.requester === 'conduit') return true;
      if (!store.available()) return false;
      const answer = r.answer;
      const answerBody =
        answer === null
          ? null
          : (() => {
              const { answeredBy, at, ...input } = answer;
              return {
                ...input,
                answered_by: answeredBy.kind === 'default' ? 'default' : 'you',
                at,
              };
            })();
      const msg: MessageRecord = {
        messageId: newId('m'),
        threadId: newId('t'),
        from: HUMAN_HANDLE,
        to: [r.requester],
        subject: `Answer to your request ${r.id}`,
        kind: 'inform',
        priority: 'normal',
        sentAt: new Date(now()).toISOString(),
        body:
          r.permission === null
            ? JSON.stringify({ request_id: r.id, state: r.state, answer: answerBody })
            : `You can retry ${r.permission.tool} now`,
        attachments: [],
        requestId: r.id,
      };
      const res = await store.append(msg, []);
      if (!res.ok) {
        deps.log.warn('conduit-mcp', 'late request answer not stored', {
          requestId: r.id,
          code: res.error.code,
        });
        return false;
      }
      scheduleBroadcast();
      return true;
    },
    onChanged: () => scheduleBroadcast(),
    onNew: (r) => notices.added(r),
    onPermissionAnswer: async (r, a, by) => {
      const perm = r.permission;
      if (perm === null) {
        return { ok: false, reason: 'not_answerable', message: 'not a permission request' };
      }
      const p = r.session === null ? null : principalOf(r.session);
      if (
        a.outcome === 'allowed' &&
        a.grant !== undefined &&
        p !== null &&
        grantTargetsFor(a.grant, p, perm.targets) === null
      ) {
        return { ok: false, reason: 'invalid_answer', message: SCOPE_UNAVAILABLE };
      }
      if (r.state === 'open') {
        if (by.kind !== 'you' || by.windowId === null)
          return {
            ok: false,
            reason: 'not_answerable',
            message: 'nothing is waiting on this request',
          };
        return flow.answerPermission(r.id, a, by.windowId);
      }
      if (
        by.kind !== 'you' ||
        by.windowId === null ||
        by.windowId === NO_OWNER_WINDOW ||
        r.session === null ||
        deps.ownerWindowOf(r.session) !== by.windowId ||
        !deps.windowReady(by.windowId)
      ) {
        return {
          ok: false,
          reason: 'not_answerable',
          message: 'a window that shows this request must answer it',
        };
      }
      if (a.outcome !== 'allowed' || a.grant === undefined) {
        return { ok: false, reason: 'invalid_answer', message: 'a late answer needs a grant' };
      }
      if (p === null) {
        return {
          ok: false,
          reason: 'not_answerable',
          message: 'the session closed before the grant could be made',
        };
      }
      const result = grantsFor(a.grant, p, perm.tool, perm.targets, r.id);
      if (!result.ok)
        return { ok: false, reason: 'not_answerable', message: grantFailureMessage(result.error) };
      const first = result.grants[0];
      if (first === undefined)
        return { ok: false, reason: 'not_answerable', message: 'the grant could not be made' };
      return requestService.answerLate(r.id, first.id);
    },
    scheduler: deps.domain.limit,
    replyToQuestion: async (r, text) => {
      const sent = await tools.sendMessage(
        { handle: HUMAN_HANDLE, sessionId: null },
        {
          to: [r.requester],
          body: text,
          ...(r.thread === null ? {} : { thread_id: r.thread }),
          kind: 'inform',
          priority: 'normal',
        },
      );
      if (!sent.ok) {
        deps.log.warn('conduit-mcp', 'reply to question not sent', {
          requestId: r.id,
          code: sent.error.code,
        });
        return false;
      }
      if (r.messageId === null) return true;
      const read = await store.setStatus(r.messageId, HUMAN_HANDLE, 'read');
      // The reply went out: reporting failure now would invite a retry and a second reply.
      if (!read.ok)
        deps.log.warn('conduit-mcp', 'question not marked read after its reply', {
          requestId: r.id,
          code: read.error.code,
        });
      return true;
    },
  });

  const factsWithHandles = (): SessionNeedsYou[] =>
    deps.attention.needsYouFacts().map((f) => ({ ...f, handle: handleOf(f.sessionId) ?? null }));

  const unreadQuestions = (): QuestionMessage[] =>
    store.available()
      ? store
          .pending(HUMAN_HANDLE)
          .filter((m) => m.kind === 'question' && m.requestId === undefined)
          .map((m) => ({
            messageId: m.messageId,
            threadId: m.threadId,
            from: m.from,
            fromSession: sessionOfHandle(m.from),
            subject: m.subject,
            body: m.body,
            sentAt: m.sentAt,
          }))
      : [];

  // ---- gate -------------------------------------------------------------------------------

  const cancelLateEcho = (sessionId: string) => {
    const cancel = lateEchoWatchers.get(sessionId);
    if (!cancel) return;
    cancel();
    if (lateEchoWatchers.get(sessionId) === cancel) lateEchoWatchers.delete(sessionId);
  };

  const screenOf = async (
    sessionId: string,
    adapter: McpAdapter,
    expect?: string,
    ruledBoxCols?: number,
  ) => {
    const snap = await deps.runtime.screen(sessionId);
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
    const session = deps.sessions.get(sessionId);
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
      messagingOn: deps.domain.messagingOn(),
      paused: session.mcpNoticesPaused === true,
      running: deps.runtime.get(sessionId)?.state === 'live',
      spawnedAt: r.spawnedAt,
      connectionLive: registry.isLive(sessionId),
      busy: deps.attention.statusOf(sessionId).busy,
      midTurnQueue: queuesMidTurn(adapter),
      lastOutputAt: deps.attention.lastOutputAt(sessionId),
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
      if (waitedMs >= SUBMIT_CONFIRM_WAIT_MS || !(deps.runtime.get(sessionId)?.state === 'live')) {
        deps.log.warn('conduit-mcp', 'notice submit unconfirmed', { sessionId, handle, waitedMs });
        return;
      }
      await sleep(ECHO_POLL_MS);
    }
  };

  const watchLateEcho = (
    sessionId: string,
    text: string,
    adapter: McpAdapter,
    gen: number | undefined,
    seq: number,
    handle: Handle | undefined,
    r: Runtime,
    onFinal: (outcome: SubmitOutcome) => void | Promise<void>,
  ) => {
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    lateEchoWatchers.set(sessionId, cancel);

    const recheckForLateEcho = async (): Promise<GateVerdict> => {
      const session = deps.sessions.get(sessionId);
      if (!session) return { open: false, reason: 'not-running' };
      return evaluateEnterRecheck({
        messagingOn: deps.domain.messagingOn(),
        paused: session.mcpNoticesPaused === true,
        running: deps.runtime.get(sessionId)?.state === 'live',
        sameGeneration: gen !== undefined && deps.runtime.get(sessionId)?.generation === gen,
        connectionLive: registry.isLive(sessionId),
        screen: await screenOf(sessionId, adapter, text),
        inputSinceText: r.inputSeq !== seq,
      });
    };

    const finish = (outcome: SubmitOutcome) => {
      if (lateEchoWatchers.get(sessionId) === cancel) lateEchoWatchers.delete(sessionId);
      return Promise.resolve(onFinal(outcome)).catch((err: unknown) => {
        deps.log.warn('conduit-mcp', 'notice late echo outcome callback failed', {
          sessionId,
          err: String(err),
        });
      });
    };

    (async () => {
      const start = now();
      for (;;) {
        if (cancelled) return;
        const verdict = await recheckForLateEcho();
        if (cancelled) return;
        let waitedMs = now() - start;
        if (verdict.open) {
          const submitOutcome = await deps.typing.submitEnter(sessionId, {
            beforeEnter: async () => !cancelled && (await recheckForLateEcho()).open,
          });
          if (cancelled) return;
          if (submitOutcome === 'submitted') {
            deps.log.info('conduit-mcp', 'notice late echo submitted', {
              sessionId,
              handle,
              waitedMs,
            });
            await finish(submitOutcome);
            return;
          }
          if (submitOutcome !== 'withheld') {
            deps.log.info('conduit-mcp', 'notice late echo abandoned', {
              sessionId,
              handle,
              reason: submitOutcome,
              waitedMs: now() - start,
            });
            await finish(submitOutcome);
            return;
          }
          const after = await recheckForLateEcho();
          if (cancelled) return;
          if (!after.open && after.reason !== 'no-echo') {
            deps.log.info('conduit-mcp', 'notice late echo abandoned', {
              sessionId,
              handle,
              reason: after.reason,
              waitedMs: now() - start,
            });
            await finish('withheld');
            return;
          }
          waitedMs = now() - start;
        } else if (verdict.reason !== 'no-echo') {
          deps.log.info('conduit-mcp', 'notice late echo abandoned', {
            sessionId,
            handle,
            reason: verdict.reason,
            waitedMs,
          });
          await finish('withheld');
          return;
        }
        if (waitedMs >= LATE_ECHO_WAIT_MS) {
          deps.log.info('conduit-mcp', 'notice late echo expired', {
            sessionId,
            handle,
            waitedMs,
          });
          await finish('withheld');
          return;
        }
        await sleep(LATE_ECHO_POLL_MS);
      }
    })().catch((err: unknown) => {
      deps.log.warn('conduit-mcp', 'notice late echo failed', { sessionId, err: String(err) });
      void finish('withheld');
    });
  };

  const submitNotice = async (
    sessionId: string,
    text: string,
    onOutcome?: (outcome: SubmitOutcome) => void | Promise<void>,
  ): Promise<SubmitOutcome> => {
    cancelLateEcho(sessionId);

    const r = rt(sessionId);
    const handle = handleOf(sessionId);
    let gen: number | undefined;
    let seq = 0;
    /** The adapter whose screen admitted the text; its echo decides the Enter, whoever connects since. */
    let typedFor: McpAdapter | null = null;
    let enterReason: GateClosedReason | undefined;
    const recheck = async (adapter: McpAdapter): Promise<GateVerdict> => {
      const session = deps.sessions.get(sessionId);
      if (!session) return { open: false, reason: 'not-running' };
      return evaluateEnterRecheck({
        messagingOn: deps.domain.messagingOn(),
        paused: session.mcpNoticesPaused === true,
        running: deps.runtime.get(sessionId)?.state === 'live',
        sameGeneration: gen !== undefined && deps.runtime.get(sessionId)?.generation === gen,
        connectionLive: registry.isLive(sessionId),
        screen: await screenOf(sessionId, adapter, text),
        inputSinceText: r.inputSeq !== seq,
      });
    };
    const outcome = await deps.typing.submit(sessionId, text, {
      beforeText: async () => {
        let { verdict, adapter } = await evaluateWith(sessionId, true);
        if (verdict.open && queuesMidTurn(adapter)) {
          await sleep(QUEUE_STABLE_MS);
          ({ verdict, adapter } = await evaluateWith(sessionId, true));
        }
        gen = deps.runtime.get(sessionId)?.generation;
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
        enterReason = verdict.open ? undefined : verdict.reason;
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
    if (outcome === 'withheld' && enterReason === 'no-echo' && typedFor) {
      const adapter = typedFor;
      watchLateEcho(sessionId, text, adapter, gen, seq, handle, r, (finalOutcome) => {
        if (finalOutcome === 'submitted') {
          r.lastNoticeAt = now();
          if (handle) dispatch({ t: 'notice-submitted', handle });
          confirmSubmit(sessionId, adapter, handle).catch((err: unknown) => {
            deps.log.warn('conduit-mcp', 'notice confirm failed', { sessionId, err: String(err) });
          });
        }
        return onOutcome?.(finalOutcome);
      });
      return outcome;
    }
    if (outcome === 'submitted' && handle) dispatch({ t: 'notice-submitted', handle });
    if (outcome === 'submitted' && typedFor) {
      confirmSubmit(sessionId, typedFor, handle).catch((err: unknown) => {
        deps.log.warn('conduit-mcp', 'notice confirm failed', { sessionId, err: String(err) });
      });
    }
    await onOutcome?.(outcome);
    return outcome;
  };

  /**
   * The session's handle, allocating one when it has none. Shared by launch and by an MCP open,
   * which must return the handle before the renderer has spawned anything (spec 2026-10-27 §3.1).
   * Null on a handles.json write failure, which marks the session launch-io.
   */
  const claimHandle = (sessionId: string, prefix: string): Handle | null => {
    const session = deps.sessions.get(sessionId);
    if (!session) return null;
    const takenByOthers = new Set(
      deps.sessions
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
    deps.sessions.setMcp(sessionId, { mcpHandle: a.handle });
    scheduleBroadcast();
    return a.handle;
  };

  interface StartupWatch {
    handle: Handle;
    opener: Caller;
    messageId: string | null;
    messageRequested: boolean;
    received: boolean;
    exited: boolean;
    since: number;
    alerted: boolean;
    inFlight: boolean;
  }
  const startupWatches = new Map<string, StartupWatch>();
  const startupReading = async (sessionId: string, w: StartupWatch) => {
    if (deps.runtime.get(sessionId)?.state === 'live')
      deps.screens.ensure(sessionId, { seedTail: true });
    const snap = await new Promise<ScreenSnapshot | null>((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), 1000);
      deps.runtime.screen(sessionId).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
    const adapter = noticeAdapterOf(sessionId);
    const stuck = cliKindOf(sessionId);
    const busy = deps.attention.statusOf(sessionId).busy;
    const prompt =
      snap &&
      isStartupPrompt(
        adapter,
        snap,
        stuck !== null && detectStuckScreen(stuck, snap.lines, deps.domain.limitRules()) !== null,
        busy,
      );
    const excerpt = snap?.lines
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(-12)
      .join('\n')
      .slice(-1000);
    if (w.messageId !== null && store.get(w.messageId)?.recipients[w.handle]?.status === 'read')
      w.received = true;
    const ready = !w.messageRequested && registry.isLive(sessionId);
    return {
      startup: prompt
        ? ('waiting_at_prompt' as const)
        : w.received || ready
          ? ('running' as const)
          : ('starting' as const),
      excerpt,
      busy,
    };
  };
  const mayExposeStartupScreen = (sessionId: string, w: StartupWatch): boolean => {
    if (w.opener.sessionId === null || w.opener.remote) return false;
    const principal = principalOf(w.opener.sessionId);
    const target = controlDeps.targets().find((t) => t.sessionId === sessionId);
    if (!principal || !target) return false;
    const rawArgs = { session: w.handle };
    const targets = resolveTargets(
      'read_screen',
      rawArgs,
      { sessionId: w.opener.sessionId, home: principal.homeFolder },
      targetDepsOf(),
    );
    const decision = policyService.decide({
      principal,
      tool: 'read_screen',
      targets,
      masterOn: deps.domain.messagingOn(),
      toYou: false,
    });
    if (decision.decision !== 'allow' || decision.grantIds.length || decision.overrideIds.length)
      return false;
    if (!reachAdmits(decision.rule.reach ?? 'self', w.opener, target, deps.ownerWindowOf))
      return false;
    const windowId = deps.ownerWindowOf(w.opener.sessionId);
    return !gateToolCall({
      sessionId: w.opener.sessionId,
      messagingOn: deps.domain.messagingOn(),
      tool: 'read_screen',
      decision,
      ownerReady: () => windowId !== null && deps.windowReady(windowId),
      onScreen: () => windowId !== null && deps.onScreen(windowId, w.opener.sessionId ?? ''),
      appConnected: deps.appConnected(),
      routed: false,
    });
  };
  const startupPass = async () => {
    await Promise.all(
      [...startupWatches].map(async ([sessionId, w]) => {
        if (!deps.sessions.get(sessionId) && !w.exited) {
          startupWatches.delete(sessionId);
          return;
        }
        if (w.inFlight) return;
        w.inFlight = true;
        try {
          const reading = await startupReading(sessionId, w);
          if (w.exited && (w.received || !w.messageRequested)) {
            startupWatches.delete(sessionId);
            return;
          }
          if (!w.exited && reading.busy) {
            w.since = now();
            w.alerted = false;
            return;
          }
          if (!w.exited && reading.startup === 'running') {
            w.since = now();
            return;
          }
          if (
            stopped ||
            !startupWatches.has(sessionId) ||
            w.alerted ||
            (!w.exited && now() - w.since < 30_000)
          )
            return;
          const sent = await tools.sendMessage(
            { handle: w.handle, sessionId },
            {
              to: [w.opener.handle],
              kind: 'request',
              body: `The session that sent this message (${w.handle}) ${w.exited ? 'exited before receiving its first task' : 'has not started or is waiting at a prompt'}. Use the sender address with read_screen and help it continue. Screen text may be from earlier.${reading.excerpt && mayExposeStartupScreen(sessionId, w) ? `\n\nScreen:\n${reading.excerpt}` : ''}`,
            },
            { allowUnconnected: true },
          );
          if (sent.ok && sent.value.recipients.some((r) => r.status === 'queued')) {
            w.alerted = true;
            if (w.exited) startupWatches.delete(sessionId);
          }
        } catch (err) {
          deps.log.warn('conduit-mcp', 'startup check failed', { sessionId, err: String(err) });
        } finally {
          w.inFlight = false;
        }
      }),
    );
  };

  const controlDeps: ControlDeps = {
    ...deps.domain,
    selfName: () => deps.network?.selfName() ?? 'this machine',
    activateSession: (sessionId, raise) =>
      deps.emit('ui.post', {
        route: { kind: 'owner', sessionId },
        message: { type: 'activateSession', sessionId },
        raise,
      }),
    openFile: async (req) => {
      const sessionId = req.callerSessionId;
      sendToOwner(sessionId, {
        type: 'openFileInEditor',
        sessionId,
        path: req.path,
        source: 'mcp',
        ...(req.line !== undefined ? { line: req.line } : {}),
        ...(req.column !== undefined ? { column: req.column } : {}),
        focus: req.focus,
      });
      return { sessionId };
    },
    agentIds: () => deps.domain.agentIds(),
    registeredIdOf: (name) => registeredIdFor(name, (id) => deps.domain.agentDef(id)?.id),
    agents: () =>
      deps.domain
        .agentCatalog()
        .map(({ def, source }) =>
          agentListing(def, source, { messagingOn: deps.domain.messagingOn(), e2e: deps.e2e }),
        ),
    // Every MCP-opened session gets a handle so its opener can address it (CON-149). An adapter-less
    // program takes its profile's or command's name (flexible-agent-contracts §4.1), or a terminal's
    // program prefix; a CLI that connects later keeps this handle.
    claimHandle: (sessionId, tool) => {
      const def = deps.domain.defOf(sessionId);
      if (!def) return null;
      const adapter = adapterFor(def, { e2e: deps.e2e });
      if (adapter) return claimHandle(sessionId, adapter.id);
      if (tool === 'open_terminal')
        return claimHandle(sessionId, handlePrefixForCommand(def.command));
      return claimHandle(
        sessionId,
        agentHandlePrefix(
          def.id === COMMAND_AGENT_ID
            ? { kind: 'command', command: def.command }
            : { kind: 'profile', id: def.id },
        ),
      );
    },
    now,
    info: (message, data) => deps.log.info('conduit-mcp', message, data),
    realPath: async (absPath) => {
      try {
        return await fs.promises.realpath(absPath);
      } catch {
        return null;
      }
    },
    readBytes: async (absPath, max) => {
      try {
        // The path can be swapped for a FIFO after the caller's stat: a non-blocking open plus a stat
        // on the handle keeps a pre-approval read from parking a threadpool thread forever.
        const fh = await fs.promises.open(
          absPath,
          fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0),
        );
        try {
          if (!(await fh.stat()).isFile()) return null;
          return await readCappedBytes(
            (buffer, offset, length, position) => fh.read(buffer, offset, length, position),
            max,
          );
        } finally {
          await fh.close();
        }
      } catch {
        return null;
      }
    },
    // Listed sessions only: a tool never reaches a session list_sessions doesn't show (spec A7).
    targets: () =>
      listedSessions().map(({ session: s, handle }) => ({
        sessionId: s.id,
        handle,
        openerSessionId: s.openedBy?.sessionId ?? null,
        remoteOpener: remoteOpenerOf(s.openedBy),
      })),
    ownerWindowOf: (sessionId) => deps.ownerWindowOf(sessionId),
    windowReady: (windowId) => deps.windowReady(windowId),
    modelFlagOf: (agentId) => {
      const def = deps.domain.agentDef(agentId);
      return def === undefined ? undefined : modelFlagOf(def);
    },
    commandModelFlag: (command) => modelFlagOf({ id: COMMAND_AGENT_ID, command }),
    messageReady: () => deps.domain.messagingOn() && store.available(),
    sendMessage: (caller, args, opts) => tools.sendMessage(caller, args, opts),
    observeStartup: async (sessionId, handle, opener, messageId, messageRequested) => {
      if (!handle) return { startup: 'starting' };
      const w: StartupWatch = {
        handle,
        opener,
        messageId,
        messageRequested,
        received: false,
        exited:
          deps.runtime.get(sessionId)?.state === 'finished' ||
          deps.sessions.get(sessionId)?.status === 'exited',
        since: now(),
        alerted: false,
        inFlight: false,
      };
      startupWatches.set(sessionId, w);
      await sleep(3000);
      try {
        const reading = await startupReading(sessionId, w);
        return {
          startup: reading.startup,
          ...(reading.startup === 'waiting_at_prompt' &&
          reading.excerpt &&
          mayExposeStartupScreen(sessionId, w)
            ? { screen_excerpt: reading.excerpt }
            : {}),
        };
      } catch (err) {
        deps.log.warn('conduit-mcp', 'startup check failed', { sessionId, err: String(err) });
        return { startup: 'starting' };
      }
    },
  };
  const control = createControlHandlers(controlDeps);
  const app = createAppControlHandlers(controlDeps, control.prepared);
  const machines = createMachineTools(
    { network: () => deps.network, now, setTimer, clearTimer },
    control.prepared,
  );
  const screen = createScreenToolHandlers(
    {
      control: controlDeps,
      snapshot: (id) => {
        if (deps.runtime.get(id)?.state === 'live') deps.screens.ensure(id, { seedTail: true });
        return deps.runtime.screen(id);
      },
      cols: (id) => deps.runtime.get(id)?.size.cols ?? null,
      presence: presenceOf,
      bracketedPaste: (id) => deps.domain.bracketedPaste(id),
      generation: (id) => deps.runtime.get(id)?.generation,
      details: (id) => {
        const session = deps.sessions.get(id);
        return session ? { label: session.name, home: session.home } : undefined;
      },
      typing: deps.typing,
      noteInput: (id, data) => {
        noteInput(id, data);
      },
    },
    control.prepared,
  );

  const launchedCli = (sessionId: string): CliKind | null => {
    const id = runtime.get(sessionId)?.defAdapter?.id;
    return CLI_KINDS.find((kind) => kind === id) ?? null;
  };
  // A sleeping session has no runtime adapter, but its persisted agent definition names the CLI.
  const persistedLaunchedCli = (sessionId: string): CliKind | null | undefined => {
    const def = deps.domain.defOf(sessionId);
    if (def === undefined) return undefined;
    const adapter = adapterFor(def, { e2e: deps.e2e });
    return CLI_KINDS.find((kind) => kind === adapter?.id) ?? null;
  };
  // A running session reports its adapter; a sleeping one falls back to its persisted definition.
  const knownLaunchedCli = (sessionId: string): CliKind | null =>
    launchedCli(sessionId) ?? persistedLaunchedCli(sessionId) ?? null;
  const principalOf = (sessionId: string): Extract<Principal, { kind: 'session' }> | null => {
    const session = deps.sessions.get(sessionId);
    if (!session?.mcpHandle) return null;
    return {
      kind: 'session',
      sessionId,
      generation:
        deps.runtime.get(sessionId)?.state === 'live'
          ? deps.runtime.get(sessionId)?.generation
          : undefined,
      handle: session.mcpHandle,
      launchedCli: launchedCli(sessionId),
      homeFolder: session.home,
      projectId: session.projectId ?? null,
    };
  };
  const machineName = (machineId: string): string =>
    deps.network?.listMachines().find((m) => m.machine_id === machineId)?.machine ?? machineId;
  const policyService = createPolicyService({
    policyIo: deps.policyIo ?? createPolicyIo(path.join(deps.dir, 'policy.json')),
    lastGoodIo: createPolicyIo(path.join(deps.dir, 'policy.last-good.json')),
    grantsIo: deps.grantsIo ?? createPolicyIo(path.join(deps.dir, 'grants.json')),
    activityIo: deps.activityIo ?? createActivityIo(deps.dir),
    hasSession: (id) => deps.sessions.get(id) !== undefined,
    peerKnown: (id) => deps.network?.hasPeer(id) ?? null,
    grantBindingsCurrent: (grant) =>
      (grant.who.kind !== 'session' || principalOf(grant.who.sessionId) !== null) &&
      (grant.who.kind !== 'peer' ||
        deps.network?.grantPeerEligible(grant.who.machineId) === true) &&
      (grant.on.kind !== 'session' || deps.sessions.get(grant.on.sessionId) !== undefined) &&
      (grant.for !== 'session-end' ||
        (grant.anchorSessionId !== null && principalOf(grant.anchorSessionId) !== null)),
    now,
    monotonicNow: () => performance.now(),
    newId: () => randomBytes(12).toString('hex'),
    ...requestTimers,
    warn: (message, error) => deps.log.warn('conduit-mcp', message, { error: String(error) }),
    legacy: () => ({
      ...deps.domain.toolPolicy(),
      sessions: deps.sessions.list().map((s) => ({
        sessionId: s.id,
        layer: s.mcpToolPolicy ?? {},
        cli: s.mcpHandle ? cliKindOfHandle(s.mcpHandle) : null,
      })),
    }),
    launchedCli: (sessionId) => persistedLaunchedCli(sessionId),
    onChanged: () => {
      syncToolLists();
      scheduleBroadcast();
    },
  });
  const validPoint = (point: unknown): point is AssignmentPoint => {
    if (typeof point !== 'object' || point === null || !('kind' in point)) return false;
    if (point.kind === 'default') return true;
    if (point.kind === 'session')
      return 'sessionId' in point && typeof point.sessionId === 'string';
    if (point.kind === 'peer') return 'machineId' in point && typeof point.machineId === 'string';
    return point.kind === 'cli' && 'cli' in point && CLI_KINDS.some((kind) => kind === point.cli);
  };
  const keys = (v: unknown, allowed: readonly string[]): v is Record<string, unknown> =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).every((k) => allowed.includes(k));
  const boundedString = (v: unknown) => typeof v === 'string' && v.length <= POLICY_MAX_BYTES;
  const knownRule = (v: unknown) => keys(v, ['decision', 'when', 'reach', 'move']);
  const knownPoint = (v: unknown): v is AssignmentPoint =>
    keys(v, ['kind', 'sessionId', 'machineId', 'cli']) &&
    validPoint(v) &&
    keys(
      v,
      v.kind === 'session'
        ? ['kind', 'sessionId']
        : v.kind === 'peer'
          ? ['kind', 'machineId']
          : v.kind === 'cli'
            ? ['kind', 'cli']
            : ['kind'],
    ) &&
    Object.values(v).every(boundedString);
  const knownAssignment = (point: AssignmentPoint, v: unknown): boolean => {
    if (v === null)
      return !!validatePolicyAssignment(point, {
        profileId: 'worker',
        exceptions: [],
        onScreenOnly: false,
      });
    if (
      !keys(v, ['profileId', 'exceptions', 'onScreenOnly', 'applyNative', 'pinned']) ||
      !Array.isArray(v.exceptions) ||
      v.exceptions.length > 1024 ||
      (v.pinned !== undefined &&
        (!Array.isArray(v.pinned) || v.pinned.length > 1024 || !v.pinned.every(boundedString)))
    )
      return false;
    if (
      !v.exceptions.every(
        (e) =>
          keys(e, ['tool', 'scope', 'rule']) &&
          keys(e.scope, ['kind', 'projectId', 'path', 'sessionId']) &&
          keys(
            e.scope,
            e.scope.kind === 'space'
              ? ['kind', 'projectId']
              : e.scope.kind === 'path' || e.scope.kind === 'folder'
                ? ['kind', 'path']
                : e.scope.kind === 'session'
                  ? ['kind', 'sessionId']
                  : ['kind'],
          ) &&
          Object.values(e.scope).every(boundedString) &&
          knownRule(e.rule),
      )
    )
      return false;
    return !!validatePolicyAssignment(point, v);
  };
  const knownProfile = (v: unknown): boolean =>
    keys(v, ['id', 'name', 'builtIn', 'nativeModes', 'rules']) &&
    keys(v.rules, TOOL_NAMES) &&
    Object.values(v.rules).every(knownRule) &&
    (v.nativeModes === undefined || keys(v.nativeModes, ['claude', 'codex'])) &&
    !!validatePolicyProfile(v);
  const withinPolicyLimit = (root: unknown): boolean => {
    let remaining = POLICY_MAX_BYTES;
    const visit = (v: unknown, depth: number): boolean => {
      if (depth > 8 || --remaining < 0) return false;
      if (typeof v === 'string') {
        remaining -= Buffer.byteLength(v);
        return remaining >= 0;
      }
      if (v === null || typeof v === 'boolean' || typeof v === 'number') return true;
      if (Array.isArray(v))
        return v.length <= remaining && v.every((item) => visit(item, depth + 1));
      if (typeof v !== 'object') return false;
      return Object.entries(v).every(
        ([key, value]) => visit(key, depth + 1) && visit(value, depth + 1),
      );
    };
    return visit(root, 0);
  };
  const validLocalEdit = (v: unknown): v is LocalPolicyEdit => {
    if (!keys(v, ['kind', 'point', 'assignment', 'profile', 'profileId', 'replacement']))
      return false;
    if (v.kind === 'assignment' && keys(v, ['kind', 'point', 'assignment']) && knownPoint(v.point))
      return knownAssignment(v.point, v.assignment);
    if (v.kind === 'profile' && keys(v, ['kind', 'profile'])) return knownProfile(v.profile);
    return (
      v.kind === 'delete-profile' &&
      keys(v, ['kind', 'profileId', 'replacement']) &&
      boundedString(v.profileId) &&
      boundedString(v.replacement)
    );
  };
  const localOwner = (sender: number, edit: LocalPolicyEdit): boolean =>
    sender !== NO_OWNER_WINDOW &&
    sender > 0 &&
    deps.windowReady(sender) &&
    (edit.kind !== 'assignment' ||
      edit.point.kind !== 'session' ||
      (!!deps.sessions.get(edit.point.sessionId) &&
        deps.ownerWindowOf(edit.point.sessionId) === sender));
  /** An optional machine an edit names: a string, or absent for this machine's own rules. */
  const machineArg = (machine: unknown): machine is string | undefined =>
    machine === undefined || (typeof machine === 'string' && machine.length > 0);
  const raisedRequests = new Map<InFlight, { id: string; why: string; approved: boolean }>();
  const initialAskTraces = new Map<InFlight, ActivityDecisionTraceV1>();
  const emptyTarget: PolicyTarget = { sessionId: null, path: null, folder: null, projectId: null };
  /** The targets an answer's grants cover, or null when a target cannot resolve the scope. */
  const grantTargetsFor = (
    choice: GrantChoice,
    p: Principal,
    targets: readonly PolicyTarget[],
  ): readonly PolicyTarget[] | null => {
    if (grantWhoFor(choice.who, p) === null) return null;
    if (choice.on === 'anywhere') return [emptyTarget];
    if (targets.length === 0) return null;
    return targets.every((t) => grantScopeFor(choice.on, t, p) !== null) ? targets : null;
  };
  /** One grant per covered target, all or none. */
  const grantsFor = (
    choice: GrantChoice,
    p: Principal,
    tool: ToolName,
    targets: readonly PolicyTarget[],
    requestId: string,
  ): GrantBatchResult => {
    const scopes = grantTargetsFor(choice, p, targets);
    if (scopes === null) return { ok: false, error: 'invalid-value' };
    return policyService.createGrants(choice, p, tool, scopes, requestId);
  };
  const reasonOf = (decision: PolicyDecision): string =>
    reasonText(decision.reason, decision.decision, {
      profileName: (id) => policyService.profileName(id) ?? id,
      cliName: (kind) => kind,
    });
  const sourceOf = (decision: PolicyDecision): PolicySource => {
    const reason = decision.reason;
    if (!('point' in reason)) return 'global';
    return reason.point.kind === 'session'
      ? 'session'
      : reason.point.kind === 'cli'
        ? 'cli'
        : 'global';
  };
  const flow = createCallFlow({
    now,
    setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimer:
      deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout> | undefined)),
    newAskId: deps.newAskId ?? (() => randomBytes(12).toString('hex')),
    saveSessionDenial: (id, sessionId, tool, beforeNotify) => {
      const row = requestService.ownerPermissions().find((r) => r.id === id);
      if (
        !row ||
        row.state !== 'open' ||
        row.session !== sessionId ||
        row.permission?.tool !== tool ||
        principalOf(sessionId) === null
      )
        return { ok: false, error: 'invalid-value' };
      return policyService.saveSessionDenial(id, sessionId, tool, beforeNotify);
    },
    // Re-checked here, not trusted from the gate: the window may have reloaded during prepare.
    ownerWindowOf: (sessionId) => {
      const w = deps.ownerWindowOf(sessionId);
      return w !== null && deps.windowReady(w) ? w : null;
    },
    appConnected: () => deps.appConnected(),
    sendToOwner: (sessionId, msg) => sendToOwner(sessionId, msg),
    flashOwner: (sessionId) => flashOwner(sessionId),
    stillVisible: (sessionId, tool) => {
      const p = principalOf(sessionId);
      return p !== null && policyService.visibleTools(p).includes(tool);
    },
    messagingOn: () => deps.domain.messagingOn(),
    openPermission: (r) => {
      const record = requestService.createPermission(
        r.caller.sessionId,
        {
          requester: r.caller.handle,
          title: r.tool,
          body: r.why,
          permission: {
            tool: r.tool,
            why: r.why,
            targets: [...r.targets],
            lateGrant: null,
            grantable: r.grantable,
          },
        },
        new Date(r.expiresAt).toISOString(),
      );
      policyService.activity.record({
        lane: 'conduit',
        principal: { handle: r.caller.handle, sessionId: r.caller.sessionId, machineId: null },
        cli: launchedCli(r.caller.sessionId),
        action: r.tool,
        target: r.targets[0]?.path ?? r.targets[0]?.sessionId ?? null,
        summary: null,
        decision: 'ask',
        decidedBy: r.why,
        outcome: 'asked',
        durationMs: null,
        requestId: record.id,
        count: null,
        ...(initialAskTraces.has(r.inflight) ? { trace: initialAskTraces.get(r.inflight) } : {}),
      });
      policyService.activity.recordAskArgs(record.id, r.args);
      raisedRequests.set(r.inflight, { id: record.id, why: r.why, approved: false });
      return record.id;
    },
    settlePermission: (e) => {
      const raised = [...raisedRequests.values()].find((request) => request.id === e.requestId);
      if (raised && e.end === 'answered' && e.answer?.outcome === 'allowed') raised.approved = true;
      if (e.end === 'answered')
        requestService.endPermission(e.requestId, 'answered', e.answer, null, e.by);
      else requestService.endPermission(e.requestId, e.end, null, e.reason, e.by);
    },
    onAwaitingChanged: () => scheduleBroadcast(),
    sendToWindow: (windowId, msg) => sendToWindow(windowId, msg),
    windowReady: (windowId) => deps.windowReady(windowId),
  });

  const notifierSessions = () =>
    deps.sessions.list().flatMap((s) => {
      const r = runtime.get(s.id);
      const adapter = noticeAdapterOf(s.id);
      if (!s.mcpHandle || !r || !adapter || !notifiable(adapter) || r.unavailable) return [];
      return [
        {
          sessionId: s.id,
          handle: s.mcpHandle,
          busy: deps.attention.statusOf(s.id).busy,
          queues: queuesMidTurn(adapter),
        },
      ];
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
        now: () => now(),
      },
      { rearmAll: true },
    );

  // ---- connections ------------------------------------------------------------------------

  /**
   * What a session's connection lists (spec 2026-10-27-conduit-mcp-control-tools §3.4): with the
   * master off, everything, so the CLI's calls get messaging_off rather than an unknown tool.
   */
  const listedTools = (sessionId: string): readonly ToolName[] => {
    if (!deps.domain.messagingOn()) return TOOL_NAMES;
    const principal = principalOf(sessionId);
    return principal ? policyService.visibleTools(principal) : [];
  };

  type CallContext = ToolCallContext & { connId: number; isCurrent: () => boolean };

  /** prepareLaunch put Conduit's server, with its timeouts, in this session's CLI args. */
  const wiredAtLaunch = (sessionId: string): boolean => {
    const r = runtime.get(sessionId);
    return r?.defAdapter !== undefined && r.defAdapter.wiring !== 'cursor-global' && !r.unavailable;
  };

  /** The remote opener a session names, so reach and list_sessions can show it. */
  const remoteOpenerOf = (
    o: SessionOpener | undefined,
  ): { handle: string; machineId: string } | null =>
    o !== undefined && o.sessionId === undefined
      ? { handle: o.handle, machineId: o.machineId }
      : null;

  /** The target facts a policy decision and a tool's targets read: the listed sessions and folders. */
  const targetDepsOf = (): TargetDeps => ({
    sessionByHandle: (ref) => {
      const s = deps.sessions.get(ref) ?? deps.sessions.get(sessionOfHandle(ref) ?? '');
      return s ? { id: s.id, cwd: s.home, projectId: s.projectId ?? null } : null;
    },
    childrenOf: (id) =>
      deps.sessions
        .list()
        .filter((s) => s.openedBy?.sessionId === id)
        .map((s) => ({ id: s.id, cwd: s.home, projectId: s.projectId ?? null })),
    realPath: (p: string) => {
      try {
        return fs.realpathSync(p);
      } catch (error) {
        deps.log.warn('conduit-mcp', 'policy target realpath failed', {
          path: p,
          error: String(error),
        });
        return null;
      }
    },
  });

  const callTool = async (
    sessionId: string | null,
    name: string,
    args: unknown,
    ctx: CallContext,
  ): Promise<ToolCallResult | null> => {
    // Before the first await: a notifications/cancelled read right after this line must find it.
    const inflight = flow.begin({ connId: ctx.connId, requestId: ctx.requestId });
    const startedAt = now();
    const generation = sessionId ? deps.runtime.get(sessionId)?.generation : undefined;
    const evaluated: {
      current: { input: Omit<PolicyInput, 'now'>; decision: PolicyDecision } | null;
      spent: boolean;
      immediateTrace: ActivityDecisionTraceV1 | null;
      committed: SealedPolicyTrace | null;
      terminal: SealedPolicyTrace | null;
    } = { current: null, spent: false, immediateTrace: null, committed: null, terminal: null };
    try {
      const handle = sessionId ? handleOf(sessionId) : undefined;
      const result = await (async (): Promise<Result<StructuredOutput> | null> => {
        // The core refused names outside the catalog already; this only narrows the type.
        if (!isToolName(name)) {
          return { ok: false, error: toolError('invalid_args', `unknown tool: ${name}`) };
        }
        const principal = sessionId && handle ? principalOf(sessionId) : null;
        if (!sessionId || !handle || principal === null) {
          return {
            ok: false,
            error: toolError(
              'not_in_session',
              'this MCP connection is not a Conduit session',
              undefined,
              { hint: NOT_IN_SESSION_HINT },
            ),
          };
        }
        const rawArgs =
          typeof args === 'object' && args !== null && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};
        const targets = resolveTargets(
          name,
          rawArgs,
          { sessionId, home: principal.homeFolder },
          targetDepsOf(),
        );
        const traceable = traceableSingle(name, rawArgs, targets);
        const policyInput = {
          principal,
          tool: name,
          targets,
          // A machine nobody added is asked about under every profile (spec 4.6, RS-D6).
          forceAsk: forcesAsk(name, rawArgs, (ref) =>
            isKnownMachine(deps.network?.listMachines() ?? [], ref),
          ),
          masterOn: deps.domain.messagingOn(),
          toYou:
            name === 'request_input' ||
            (name === 'send_message' &&
              Array.isArray(rawArgs.to) &&
              rawArgs.to.length > 0 &&
              rawArgs.to.every((recipient) => recipient === HUMAN_HANDLE)),
        };
        const captured = policyService.decideWithTrace(
          policyInput,
          deps.runtime.get(sessionId)?.generation ?? null,
        );
        const resolved = captured.decision;
        evaluated.current = { input: policyInput, decision: resolved };
        const windowId = deps.ownerWindowOf(sessionId);
        const gateMaster = deps.domain.messagingOn();
        const refused = gateToolCall({
          sessionId,
          messagingOn: gateMaster,
          tool: name,
          decision: resolved,
          ownerReady: () => windowId !== null && deps.windowReady(windowId),
          onScreen: () => windowId !== null && deps.onScreen(windowId, sessionId),
          appConnected: deps.appConnected(),
          routed: isRoutedCall(name, rawArgs),
        });
        if (refused) {
          if (
            resolved.decision === 'deny' &&
            ((refused.code === 'tool_disabled' && gateMaster) ||
              (refused.code === 'messaging_off' &&
                !gateMaster &&
                resolved.reason.by === 'floor' &&
                resolved.reason.floor === 'master-off'))
          )
            evaluated.immediateTrace = traceable ? captured.trace : null;
          else if (
            traceable &&
            captured.trace &&
            gateMaster &&
            (refused.code === 'window_not_ready' || refused.code === 'caller_not_visible')
          )
            evaluated.immediateTrace = {
              ...captured.trace,
              runtime: { outcome: 'refused', code: null },
            };
          return { ok: false, error: refused };
        }
        // A concurrent call may have spent the override this decision relies on. decide and commit
        // run back to back, so the re-decide sees the state the commit did: a second override for
        // the target can stand in for the spent one.
        const commitResolved = (
          input: Omit<PolicyInput, 'now'> = policyInput,
          decision: PolicyDecision = resolved,
        ): AskCommit => {
          initialAskTraces.delete(inflight);
          const committed = policyService.commit(input, decision, [], {
            generation: deps.runtime.get(sessionId)?.generation ?? null,
            onSuccess: (fresh) => {
              if (traceable && fresh.trace)
                evaluated.committed = {
                  input,
                  decision: fresh.decision,
                  trace: fresh.trace,
                  reason: reasonOf(fresh.decision),
                };
              if (
                traceable &&
                resolved.decision === 'ask' &&
                fresh.decision.decision === 'ask' &&
                fresh.trace &&
                captured.trace &&
                JSON.stringify(fresh.decision) === JSON.stringify(resolved) &&
                JSON.stringify(fresh.trace.facts) === JSON.stringify(captured.trace.facts) &&
                JSON.stringify(fresh.trace.assignment) === JSON.stringify(captured.trace.assignment)
              )
                initialAskTraces.set(inflight, fresh.trace);
            },
          });
          if (committed.ok) return { ok: true, decision, held: committed.overrides };
          if (committed.error !== 'policy-changed') return committed;
          const again = policyService.decide(input);
          const retried =
            again.decision === 'allow'
              ? policyService.commit(input, again, [], {
                  generation: deps.runtime.get(sessionId)?.generation ?? null,
                  onSuccess: (fresh) => {
                    if (traceable && fresh.trace)
                      evaluated.committed = {
                        input,
                        decision: fresh.decision,
                        trace: fresh.trace,
                        reason: reasonOf(fresh.decision),
                      };
                  },
                })
              : committed;
          if (retried.ok) {
            evaluated.current = { input, decision: again };
            return { ok: true, decision: again, held: retried.overrides };
          }
          evaluated.spent = true;
          evaluated.current = { input, decision: again };
          return retried;
        };
        const caller = { handle, sessionId };
        const sealHandled = <T extends Result<unknown> | null>(result: T): T => {
          const sealed = evaluated.committed;
          const current = principalOf(sessionId);
          if (
            result !== null &&
            !inflight.cancelled &&
            sealed &&
            current &&
            current.sessionId === principal.sessionId &&
            current.handle === principal.handle &&
            current.launchedCli === principal.launchedCli &&
            current.homeFolder === principal.homeFolder &&
            current.projectId === principal.projectId &&
            sealed.trace.facts.principal.kind === 'session' &&
            deps.runtime.get(sessionId)?.generation === sealed.trace.facts.principal.generation
          ) {
            const after = policyService.decideWithTrace(
              {
                ...sealed.input,
                principal: current,
                masterOn: deps.domain.messagingOn(),
                forceAsk: forcesAsk(name, rawArgs, (ref) =>
                  isKnownMachine(deps.network?.listMachines() ?? [], ref),
                ),
              },
              sealed.trace.facts.principal.generation,
            );
            if (
              after.trace &&
              JSON.stringify(after.decision) === JSON.stringify(sealed.decision) &&
              JSON.stringify(after.trace.facts) === JSON.stringify(sealed.trace.facts) &&
              JSON.stringify(after.trace.assignment) === JSON.stringify(sealed.trace.assignment)
            )
              evaluated.terminal = {
                ...sealed,
                trace: { ...sealed.trace, runtime: { outcome: 'proceeded', code: null } },
              };
          }
          return result;
        };
        if (isRequestTool(name)) {
          const committed = commitResolved();
          if (!committed.ok) return { ok: false, error: commitFailure(committed.error) };
          return sealHandled(await runRequest(caller, name, args, ctx));
        }
        if (isMessagingTool(name)) {
          if (!store.available()) {
            return {
              ok: false,
              error: toolError('store_unavailable', storeError ?? 'message store unavailable'),
            };
          }
          const committed = commitResolved();
          if (!committed.ok) return { ok: false, error: commitFailure(committed.error) };
          return sealHandled(await runMessaging(caller, name, args, ctx));
        }
        const preparedConditions: PreparedPolicyConditions = {
          when: resolved.rule.when,
          reach: resolved.rule.reach,
          move: resolved.rule.move,
        };
        const preparedPrincipal = { ...principal };
        const preparedGeneration = deps.runtime.get(sessionId)?.generation;
        const currentLocalDecision = (
          held: readonly OneUseOverride[] = [],
          onRefusal?: (value: SealedPolicyTrace) => void,
        ): Result<{ input: Omit<PolicyInput, 'now'>; decision: PolicyDecision }> => {
          const current = principalOf(sessionId);
          if (
            inflight.signal.aborted ||
            current === null ||
            current.sessionId !== preparedPrincipal.sessionId ||
            current.handle !== preparedPrincipal.handle ||
            current.launchedCli !== preparedPrincipal.launchedCli ||
            current.homeFolder !== preparedPrincipal.homeFolder ||
            current.projectId !== preparedPrincipal.projectId ||
            deps.runtime.get(sessionId)?.generation !== preparedGeneration
          )
            return {
              ok: false,
              error: toolError(
                'tool_disabled',
                'Caller context changed after this action was prepared',
              ),
            };
          const forceAsk = forcesAsk(name, rawArgs, (ref) =>
            isKnownMachine(deps.network?.listMachines() ?? [], ref),
          );
          const input = {
            ...policyInput,
            principal: current,
            masterOn: deps.domain.messagingOn(),
            forceAsk,
            heldOverrides: held,
          };
          const fresh = policyService.decideWithTrace(
            input,
            deps.runtime.get(sessionId)?.generation ?? null,
          );
          const decision = fresh.decision;
          evaluated.current = { input, decision };
          const currentWindow = deps.ownerWindowOf(sessionId);
          const gate = gateToolCall({
            sessionId,
            messagingOn: input.masterOn,
            tool: name,
            decision,
            ownerReady: () => currentWindow !== null && deps.windowReady(currentWindow),
            onScreen: () => currentWindow !== null && deps.onScreen(currentWindow, sessionId),
            appConnected: deps.appConnected(),
            routed: isRoutedCall(name, rawArgs),
          });
          if (gate) {
            if (
              traceable &&
              fresh.trace &&
              (decision.decision === 'deny' ||
                gate.code === 'window_not_ready' ||
                gate.code === 'caller_not_visible')
            )
              onRefusal?.({
                input,
                decision,
                trace:
                  decision.decision === 'deny'
                    ? fresh.trace
                    : { ...fresh.trace, runtime: { outcome: 'refused', code: null } },
                reason: reasonOf(decision),
              });
            return { ok: false, error: gate };
          }
          if (!samePreparedConditions(decision.rule, preparedConditions))
            return {
              ok: false,
              error: toolError(
                'tool_disabled',
                'Permissions changed after this action was prepared',
              ),
            };
          if (forceAsk && !policyInput.forceAsk)
            return {
              ok: false,
              error: toolError(
                'tool_disabled',
                `${rawArgs.machine} is no longer added; call connect_machine again to add it`,
              ),
            };
          return { ok: true, value: { input, decision } };
        };
        let committedOverrides: OneUseOverride[] = [];
        let ownerAllowed = false;
        const controlCtx: ControlCallContext = {
          stillCurrent: () => {
            const fresh = currentLocalDecision(committedOverrides);
            if (!fresh.ok) {
              evaluated.committed = null;
              return false;
            }
            if (
              evaluated.committed &&
              JSON.stringify(fresh.value.decision) !== JSON.stringify(evaluated.committed.decision)
            )
              evaluated.committed = null;
            const heldIds = new Set(committedOverrides.map((override) => override.id));
            const allowed =
              (fresh.value.decision.decision === 'allow' || ownerAllowed) &&
              fresh.value.decision.overrideIds.every((id) => heldIds.has(id));
            if (!allowed) evaluated.committed = null;
            return allowed;
          },
          move: resolved.rule.move ?? undefined,
          reach: resolved.rule.reach ?? undefined,
          ui: (windowId, routedSessionId, action) =>
            flow.requestUi({
              inflight,
              callerSessionId: sessionId,
              routedSessionId,
              windowId,
              action,
            }),
          signal: inflight.signal,
        };
        return flow.runControl<StructuredOutput>({
          inflight,
          caller,
          kind: cliKindOfHandle(handle),
          wiredAtLaunch: wiredAtLaunch(sessionId),
          tool: name,
          decision: resolved,
          commit: () => {
            const fresh = currentLocalDecision([], (value) => {
              evaluated.terminal = value;
            });
            if (
              !fresh.ok ||
              (resolved.decision === 'allow' && fresh.value.decision.decision === 'ask')
            )
              return { ok: false, error: 'policy-changed' };
            const committed = commitResolved(fresh.value.input, fresh.value.decision);
            if (committed.ok)
              committedOverrides = committed.held.map((override) => structuredClone(override));
            return committed;
          },
          permission: { why: reasonOf(resolved), targets, grantable: !resolved.forcedAsk },
          denyReason: (held) => {
            const d = policyService.decide({ ...policyInput, heldOverrides: held });
            return d.decision === 'deny' ? reasonOf(d) : null;
          },
          reDecide: (held) => {
            const fresh = currentLocalDecision(held);
            return fresh.ok ? { kind: 'ready' } : { kind: 'withdraw', reason: fresh.error.message };
          },
          grant: (choice, requestId) => {
            const p = principalOf(sessionId);
            if (p === null) return { ok: false, error: 'session-gone' };
            return grantsFor(choice, p, name, policyInput.targets, requestId);
          },
          commitAnswered: (held) => {
            const fresh = currentLocalDecision(held, (value) => {
              evaluated.terminal = value;
            });
            if (!fresh.ok) return { ok: false, error: 'policy-changed' };
            evaluated.committed = null;
            const committed = policyService.commit(fresh.value.input, fresh.value.decision, held, {
              generation: deps.runtime.get(sessionId)?.generation ?? null,
              onSuccess: (captured) => {
                if (traceable && captured.trace)
                  evaluated.committed = {
                    input: fresh.value.input,
                    decision: captured.decision,
                    trace: captured.trace,
                    reason: reasonOf(captured.decision),
                  };
              },
            });
            if (!committed.ok) evaluated.spent = true;
            else {
              committedOverrides = [
                ...new Map(
                  [...held, ...committed.overrides].map((override) => [
                    override.id,
                    structuredClone(override),
                  ]),
                ).values(),
              ];
              ownerAllowed = true;
            }
            return committed;
          },
          revokeCreatedGrants: (ids) => policyService.revokeGrants(ids),
          source: sourceOf(resolved),
          args,
          prepare: async () => {
            const prepared = await prepareControl(caller, name, args, controlCtx);
            if (!prepared.ok || 'done' in prepared.value) return prepared;
            const p = prepared.value;
            return {
              ok: true,
              value: {
                ...p,
                run: async () => {
                  const result = await p.run();
                  sealHandled(result);
                  return result;
                },
              },
            };
          },
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
      const record = evaluated.terminal ?? evaluated.current;
      const value =
        result?.ok && typeof result.value === 'object' && result.value !== null
          ? result.value
          : null;
      const requestId =
        raisedRequests.get(inflight)?.id ??
        (name === 'request_input' &&
        value &&
        'request_id' in value &&
        typeof value.request_id === 'string'
          ? value.request_id
          : null);
      const decision = record?.decision;
      const outcomeOfError = (code: string): ActivityOutcome => {
        if (code === 'denied' || decision?.decision === 'deny') return 'denied';
        if (code === 'approval_timeout') return 'expired';
        return 'error';
      };
      const activityId = policyService.activity.record(
        {
          lane: 'conduit',
          principal: { handle: handle ?? null, sessionId, machineId: null },
          cli: sessionId ? launchedCli(sessionId) : null,
          action: name,
          // A routed call names the machine it runs on, or the address it reaches (CON-40 S3 review).
          target:
            record?.input.targets[0]?.path ??
            record?.input.targets[0]?.sessionId ??
            routedRefOf(name, args),
          summary: null,
          decision: decision?.decision ?? null,
          decidedBy: (() => {
            const reason =
              evaluated.terminal?.reason ?? (decision ? reasonOf(decision) : 'unknown');
            const raised = raisedRequests.get(inflight);
            return !cancelled && result?.ok && raised?.approved && reason !== raised.why
              ? `${raised.why}; ${reason}`
              : reason;
          })(),
          outcome: cancelled
            ? 'withdrawn'
            : result.ok
              ? 'ok'
              : evaluated.spent
                ? 'denied'
                : outcomeOfError(result.error.code),
          durationMs: now() - startedAt,
          requestId,
          count: null,
          ...(!cancelled && (evaluated.terminal?.trace ?? evaluated.immediateTrace)
            ? { trace: evaluated.terminal?.trace ?? evaluated.immediateTrace ?? undefined }
            : {}),
        },
        (row) => {
          if (
            !sessionId ||
            generation === undefined ||
            !ctx.isCurrent() ||
            deps.runtime.get(sessionId)?.generation !== generation ||
            !isToolName(name) ||
            row.outcome === null ||
            row.outcome === 'asked'
          )
            return;
          const owner = deps.ownerWindowOf(sessionId);
          if (owner === null || owner <= 0 || owner === NO_OWNER_WINDOW || !deps.windowReady(owner))
            return;
          const decidedBy = row.decidedBy.replace(/\p{C}/gu, ' ').slice(0, 256);
          sendToWindow(owner, {
            type: 'mcp:activityRecorded',
            sessionId,
            generation,
            id: row.id,
            at: row.at,
            tool: name,
            outcome: row.outcome,
            ...(row.outcome === 'denied' ? { decidedBy } : {}),
          });
        },
      );

      if (record) policyService.noteDecision(activityId, record.input, record.decision);
      if (cancelled) return null;
      const built = toToolCallResult(result);
      const banner = unreadBannerFor(handle, name);
      return banner === null
        ? built
        : { ...built, content: [...built.content, { type: 'text', text: banner }] };
    } finally {
      raisedRequests.delete(inflight);
      initialAskTraces.delete(inflight);
      inflight.end();
    }
  };

  /**
   * A busy lead on a holding CLI never gets a typed notice (spec CON-172), so the unread count rides
   * every tool result it makes until read_inbox reads them. Marks nothing: see bannerCandidates.
   */
  const unreadBannerFor = (handle: Handle | undefined, tool: string): string | null => {
    if (!handle || !notifier || tool === 'read_inbox') return null;
    if (!deps.domain.messagingOn() || !store.available()) return null;
    return composeUnreadBanner(bannerCandidates(store.pending(handle)));
  };

  /** The connection id and request id are the wait's cancel key. */
  const runWait = async (
    caller: Caller,
    args: unknown,
    ctx: CallContext,
  ): Promise<Result<WaitOutput> | null> => {
    const parsed = parseWaitArgs(args);
    if (!parsed.ok) return parsed;
    if (caller.sessionId === null)
      return {
        ok: false,
        error: toolError(
          'not_in_session',
          'this MCP connection is not a Conduit session',
          undefined,
          { hint: NOT_IN_SESSION_HINT },
        ),
      };
    const listed = listedSessions();
    const targets: WaitTarget[] = [];
    for (const v of parsed.value.sessions) {
      if (v.includes('@')) {
        const resolved = deps.network?.resolve(v);
        if (resolved?.kind !== 'remote')
          return {
            ok: false,
            error: toolError('unknown_session', `no session "${v}" in list_sessions`, undefined, {
              hint: resolved?.kind === 'unknown' ? resolved.hint : 'no linked machines',
            }),
          };
        const entry = resolved.entry;
        if (!targets.some((t) => t.sessionId === entry.address))
          targets.push({ sessionId: entry.address, handle: entry.address });
        continue;
      }
      const hit = listed.find((x) => x.handle === v) ?? listed.find((x) => x.session.id === v);
      if (!hit)
        return {
          ok: false,
          error: toolError('unknown_session', `no session "${v}" in list_sessions`, undefined, {
            hint: 'use a handle from valid; list_sessions shows the current ones',
            valid: listed.map((x) => x.handle),
          }),
        };
      if (hit.session.id === caller.sessionId)
        return {
          ok: false,
          error: toolError('invalid_args', "a session can't wait on itself"),
        };
      if (!targets.some((t) => t.sessionId === hit.session.id))
        targets.push({ sessionId: hit.session.id, handle: hit.handle });
    }
    if (sessionWaits.countFor(caller.sessionId) >= WAIT_MAX_PER_CALLER)
      return {
        ok: false,
        error: toolError(
          'rate_limited',
          `more than ${WAIT_MAX_PER_CALLER} waits are open for this session`,
        ),
      };
    // Unknown caller kinds read as 'agent', the smallest budget, as cliKindOfHandle already does.
    const budgetMs = askBudgetMs(cliKindOfHandle(caller.handle), wiredAtLaunch(caller.sessionId));
    const { timeoutS, clampedTo } = clampWaitTimeout(parsed.value.timeoutS, budgetMs);
    const out = await sessionWaits.open({
      caller: { sessionId: caller.sessionId, handle: caller.handle },
      key: { connId: ctx.connId, requestId: ctx.requestId },
      targets,
      until: parsed.value.until,
      timeoutMs: timeoutS * 1000,
    });
    if (out === null) return null;
    if ('error' in out) return { ok: false, error: out.error };
    return { ok: true, value: clampedTo === undefined ? out : { ...out, clamped_to: clampedTo } };
  };

  const runMessaging = async (caller: Caller, name: ToolName, args: unknown, ctx: CallContext) => {
    switch (name) {
      case 'list_sessions':
        return tools.listSessions(caller);
      case 'wait_sessions':
        return runWait(caller, args, ctx);
      case 'send_message':
        return tools.sendMessage(caller, args);
      case 'read_inbox':
        return tools.readInbox(caller, args);
      case 'read_attachment':
        return tools.readAttachment(caller, args);
    }
    throw new Error(`runMessaging: ${name} is not a messaging tool`);
  };

  const runRequest = async (
    caller: Caller,
    name: ToolName,
    args: unknown,
    ctx: CallContext,
  ): Promise<Result<StructuredOutput> | null> => {
    const key = { connId: ctx.connId, requestId: ctx.requestId };
    switch (name) {
      case 'request_input':
        return requestService.tools.requestInput(caller, args, key);
      case 'wait_request':
        return requestService.tools.waitRequest(caller, args, key);
      case 'withdraw_request':
        return requestService.tools.withdrawRequest(caller, args);
      case 'list_requests':
        return mergeListRequests(
          requestService.tools.listRequests(caller, args),
          remoteRequests.views(),
          args,
        );
    }
    throw new Error(`runRequest: ${name} is not a request tool`);
  };

  const freshRemotePolicy = (
    pending: PendingRemotePermission,
    ownerAllow: boolean,
    phase: 'pending' | 'running' = 'pending',
    onRefusal?: (value: SealedPolicyTrace) => void,
  ): Result<{
    input: Omit<PolicyInput, 'now'>;
    decision: PolicyDecision;
    trace: ActivityDecisionTraceV1 | null;
  }> => {
    if (pending.signal.aborted || (phase === 'pending' && now() >= pending.deadline))
      return {
        ok: false,
        error: toolError('peer_unreachable', 'the remote call was cancelled or expired'),
      };
    const principal = deps.network?.inboundPrincipal(pending.machineId, pending.handle);
    if (!principal)
      return {
        ok: false,
        error: toolError('peer_unreachable', 'the controller link is no longer live'),
      };
    const input = {
      principal,
      tool: pending.tool,
      targets: pending.targets,
      forceAsk: pending.forceAsk,
      masterOn: deps.domain.messagingOn(),
      toYou: false,
    };
    const captured = policyService.decideWithTrace(input, null);
    const decision = captured.decision;
    const refuse = () => {
      if (captured.trace)
        onRefusal?.({ input, decision, trace: captured.trace, reason: reasonOf(decision) });
    };
    if (!input.masterOn && pending.tool !== 'list_agents') {
      if (decision.reason.by === 'floor' && decision.reason.floor === 'master-off') refuse();
      return { ok: false, error: toolError('messaging_off', 'Conduit messaging is turned off') };
    }
    if (decision.decision === 'deny') {
      refuse();
      return { ok: false, error: toolError('policy_unavailable', reasonOf(decision)) };
    }
    if (!samePreparedConditions(decision.rule, pending.conditions))
      return {
        ok: false,
        error: toolError(
          'policy_unavailable',
          'Permissions changed after this action was prepared',
        ),
      };
    if (decision.decision === 'ask' && !ownerAllow) {
      refuse();
      return { ok: false, error: toolError('policy_unavailable', reasonOf(decision)) };
    }
    return { ok: true, value: { input, decision, trace: captured.trace } };
  };

  /**
   * The owner's answer to a remote lead's ask (CON-42 decision 1): a permission in this machine's
   * queue, mirrored to the controller whose owner answers it there. The call waits on that answer.
   */
  const askOwner = async (
    remote: RemoteCaller,
    decision: PolicyDecision,
    pending: PendingRemotePermission,
    trace: ActivityDecisionTraceV1 | null,
  ): Promise<{ requestId: string; outcome: Result<AnswerInput> }> => {
    const { tool: name, targets, signal } = pending;
    pending.deadline = now() + REMOTE_ASK_MS;
    const created = requestService.createRemotePermission(
      { handle: remote.handle, machineId: remote.machineId },
      { tool: name, why: reasonOf(decision), targets: [...targets], grantable: pending.grantable },
      new Date(pending.deadline).toISOString(),
    );
    pendingRemotePermissions.set(created.id, pending);
    policyService.activity.record({
      lane: 'conduit',
      principal: { handle: remote.handle, sessionId: null, machineId: remote.machineId },
      cli: null,
      action: name,
      target: targets[0]?.path ?? targets[0]?.sessionId ?? null,
      summary: null,
      decision: 'ask',
      decidedBy: reasonOf(decision),
      outcome: 'asked',
      durationMs: null,
      requestId: created.id,
      count: null,
      ...(trace ? { trace } : {}),
    });
    // The lead has gone (its link dropped or it was revoked), so the owner has nothing to answer for.
    // An already-aborted signal never fires its listener, so it is withdrawn here at once.
    const withdraw = (): void =>
      requestService.endPermission(created.id, 'withdrawn', null, 'the call was cancelled', {
        kind: 'remote',
        machineId: remote.machineId,
      });
    signal.addEventListener('abort', withdraw, { once: true });
    if (signal.aborted) withdraw();
    const ended = await created.ended.finally(() => {
      pendingRemotePermissions.delete(created.id);
      signal.removeEventListener('abort', withdraw);
    });
    if (signal.aborted)
      return {
        requestId: created.id,
        outcome: { ok: false, error: toolError('cancelled', 'the call was cancelled') },
      };
    return { requestId: created.id, outcome: ownerOutcomeOf(ended, pending.withdrawalError) };
  };

  /**
   * A routed call from a remote lead (plan decision 4): the same policy decision, commit and prepare
   * as a local call, under the remote principal, with no session, home or window. An ask or a bare
   * command waits for the owner of this machine, through a permission in its queue (CON-42).
   */
  const callAsRemote = async (
    remote: RemoteCaller,
    name: RoutedTool,
    args: unknown,
    signal: AbortSignal,
  ): Promise<Result<StructuredOutput>> => {
    const startedAt = now();
    const caller: Caller = {
      handle: `${remote.handle}@${remote.machineId}`,
      sessionId: null,
      remote,
    };
    const rawArgs =
      typeof args === 'object' && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    const targets = resolveTargets(name, rawArgs, { sessionId: null, home: null }, targetDepsOf());
    const policyInput = {
      principal: remote,
      tool: name,
      targets,
      forceAsk: forcesAsk(name, rawArgs, (ref) =>
        isKnownMachine(deps.network?.listMachines() ?? [], ref),
      ),
      masterOn: deps.domain.messagingOn(),
      toYou: false,
    };
    const captured = policyService.decideWithTrace(policyInput, null);
    const decision = captured.decision;
    const pending: PendingRemotePermission = {
      machineId: remote.machineId,
      handle: remote.handle,
      tool: name,
      targets,
      forceAsk: policyInput.forceAsk,
      conditions: {
        when: decision.rule.when,
        reach: decision.rule.reach,
        move: decision.rule.move,
      },
      signal,
      deadline: Number.POSITIVE_INFINITY,
      grantable: !decision.forcedAsk,
    };

    let raised: string | null = null;
    let raisedWhy: string | null = null;
    let immediateDeny = false;
    let terminal: SealedPolicyTrace | null = null;
    let committedTrace: SealedPolicyTrace | null = null;
    const traceable = traceableSingle(name, rawArgs, targets);
    const recordRefusal = (value: SealedPolicyTrace): void => {
      if (traceable && !signal.aborted) terminal = value;
    };
    const commitFresh = (value: { input: Omit<PolicyInput, 'now'>; decision: PolicyDecision }) => {
      committedTrace = null;
      return policyService.commit(value.input, value.decision, [], {
        generation: null,
        onSuccess: (result) => {
          if (traceable && result.trace)
            committedTrace = {
              input: value.input,
              decision: result.decision,
              trace: result.trace,
              reason: reasonOf(result.decision),
            };
        },
      });
    };
    const result = await (async (): Promise<Result<StructuredOutput>> => {
      if (!policyInput.masterOn && name !== 'list_agents') {
        immediateDeny = decision.reason.by === 'floor' && decision.reason.floor === 'master-off';
        return { ok: false, error: toolError('messaging_off', 'Conduit messaging is turned off') };
      }
      if (decision.decision === 'deny') {
        immediateDeny = true;
        return { ok: false, error: toolDisabled(name) };
      }
      let ownerAllowed = false;
      let phase: 'pending' | 'running' = 'pending';
      const ctx: ControlCallContext = {
        stillCurrent: () => {
          const fresh = freshRemotePolicy(pending, ownerAllowed, phase);
          if (!fresh.ok) {
            committedTrace = null;
            return false;
          }
          if (
            committedTrace &&
            (!fresh.value.trace ||
              JSON.stringify(fresh.value.decision) !== JSON.stringify(committedTrace.decision) ||
              JSON.stringify(fresh.value.trace.facts) !==
                JSON.stringify(committedTrace.trace.facts) ||
              JSON.stringify(fresh.value.trace.assignment) !==
                JSON.stringify(committedTrace.trace.assignment))
          )
            committedTrace = null;
          return true;
        },
        move: decision.rule.move ?? undefined,
        reach: decision.rule.reach ?? undefined,
        // Nothing asks through a window for a remote lead, and close refuses before it would.
        ui: async () => ({ ok: false, error: windowNotReady() }),
        signal,
      };
      const prepared = await prepareControl(caller, name, args, ctx);
      if (!prepared.ok) return prepared;
      const p = prepared.value;
      if ('done' in p) {
        const fresh = freshRemotePolicy(pending, false, 'pending', recordRefusal);
        if (!fresh.ok) return fresh;
        const committed = commitFresh(fresh.value);
        if (!committed.ok) return { ok: false, error: commitFailure(committed.error) };
        return p.done;
      }
      // A bare command is never a registered agent, so an allow still asks (flexible-agent-contracts §3.1).
      const asked = decision.decision === 'ask' || p.alwaysAsk === true;
      try {
        if (asked) {
          pending.grantable = !decision.forcedAsk && p.alwaysAsk !== true;
          raisedWhy = reasonOf(decision);
          const owner = await askOwner(
            remote,
            decision,
            pending,
            decision.decision === 'ask' && traceable ? captured.trace : null,
          );
          raised = owner.requestId;
          if (!owner.outcome.ok) {
            p.release();
            return owner.outcome;
          }
        }
        const fresh = freshRemotePolicy(pending, asked, 'pending', recordRefusal);
        if (!fresh.ok) {
          p.release();
          return fresh;
        }
        const committed = commitFresh(fresh.value);
        if (!committed.ok) {
          p.release();
          return { ok: false, error: commitFailure(committed.error) };
        }
        ownerAllowed = asked;
        phase = 'running';
        const result = await p.run();
        if (committedTrace && !ctx.stillCurrent()) committedTrace = null;
        const sealed = committedTrace as SealedPolicyTrace | null;
        if (!signal.aborted && sealed)
          terminal = {
            ...sealed,
            trace: { ...sealed.trace, runtime: { outcome: 'proceeded', code: null } },
          };
        return result;
      } finally {
        p.budget?.dispose();
      }
    })();
    const finalTrace = terminal as SealedPolicyTrace | null;
    const finalDecision = finalTrace?.decision ?? decision;
    const activityId = policyService.activity.record({
      lane: 'conduit',
      principal: { handle: remote.handle, sessionId: null, machineId: remote.machineId },
      cli: null,
      action: name,
      target: targets[0]?.path ?? targets[0]?.sessionId ?? null,
      summary: null,
      decision: finalDecision.decision,
      decidedBy: (() => {
        const initial =
          result.ok && finalTrace ? (raisedWhy ?? reasonOf(decision)) : reasonOf(decision);
        const current = finalTrace?.reason ?? initial;
        return result.ok && raised !== null && current !== initial
          ? `${initial}; ${current}`
          : current;
      })(),
      outcome: result.ok ? 'ok' : outcomeOfRemoteError(result.error.code, finalDecision.decision),
      durationMs: now() - startedAt,
      requestId: raised,
      count: null,
      ...(!signal.aborted &&
      (finalTrace?.trace ?? (immediateDeny && traceable ? captured.trace : null))
        ? { trace: finalTrace?.trace ?? captured.trace ?? undefined }
        : {}),
    });
    policyService.noteDecision(activityId, finalTrace?.input ?? policyInput, finalDecision);
    deps.log.info('conduit-mcp', 'remote call', {
      tool: name,
      machineId: remote.machineId,
      ok: result.ok,
    });
    return result;
  };

  /**
   * A session call that names another machine (CON-40 S3): the lead's gate has run, and the call
   * runs there. The machine answers under its own name for the session, so the handle is rewritten
   * to handle@<machine>. A remote lead can't route on: B never reaches another machine.
   */
  const prepareRouted = (
    caller: Caller,
    intent: RoutedIntent,
    ctx: ControlCallContext,
  ): Result<Prepared<StructuredOutput>> => {
    const network = deps.network;
    if (caller.remote !== undefined)
      return {
        ok: false,
        error: toolError(
          'peer_unsupported',
          `${intent.tool} on another machine can't be routed from a remote lead`,
          undefined,
          { hint: 'send it from the machine the session is on' },
        ),
      };
    if (network === undefined)
      return intent.kind === 'machine'
        ? {
            ok: false,
            error: toolError('machine_unknown', `no machine is called ${intent.machine}`),
          }
        : {
            ok: false,
            error: toolError(
              'unknown_session',
              `no session "${intent.address}" in list_sessions`,
              undefined,
              { hint: 'no linked machines' },
            ),
          };
    // A session address resolves only its machine part here; the handle is B's to resolve (CON-40 S3).
    const found = machineTarget(network, intent.machine);
    if (!found.ok) return found;
    const target =
      intent.kind === 'address' ? { ...found.value, label: intent.handle } : found.value;
    const shown = intent.kind === 'address' ? routedName(intent.handle, target.machine) : null;
    const summary = routedAskSummary(intent, target, shown);
    if (summary === null)
      return {
        ok: false,
        error: toolError(
          'invalid_args',
          `${intent.tool} on ${target.machine} needs its arguments as text`,
        ),
      };
    const { machineId, machine } = target;
    // A light-mode machine runs no agent CLIs (spec F8, S12): A answers for it, so B is never asked.
    const light =
      intent.kind === 'machine' &&
      network.listMachines().find((m) => m.machine_id === machineId)?.mode === 'light';
    if (light && intent.tool === 'open_session')
      return {
        ok: false,
        error: toolError('unknown_agent', `${machine} runs no agent CLIs (light mode)`, undefined, {
          hint: `use open_terminal with machine "${machine}" instead`,
        }),
      };
    if (light && intent.tool === 'list_agents')
      return {
        ok: true,
        value: {
          summary,
          routesUi: false,
          release: () => undefined,
          run: async () => ({ ok: true, value: listAgentsOutput([]) }),
        },
      };
    return {
      ok: true,
      value: {
        summary,
        routesUi: false,
        release: () => undefined,
        run: async () => {
          const out = await network.call(
            machineId,
            intent.tool,
            intent.args,
            caller.handle,
            ctx.signal,
          );
          if (!out.ok) return out;
          return { ok: true, value: nameOnMachine(intent.tool, out.value, machine) };
        },
      },
    };
  };

  const prepareControl = (
    caller: Caller,
    name: ToolName,
    args: unknown,
    ctx: ControlCallContext,
  ): Promise<Result<Prepared<StructuredOutput>>> => {
    const routed = routedIntentOf(name, args);
    if (!routed.ok) return Promise.resolve(routed);
    if (routed.value !== null) return Promise.resolve(prepareRouted(caller, routed.value, ctx));
    switch (name) {
      case 'list_agents':
        return control.prepareListAgents(caller, args);
      case 'open_session':
        return control.prepareOpenSession(caller, args, ctx);
      case 'open_terminal':
        return control.prepareOpenTerminal(caller, args, ctx);
      case 'open_file':
        return control.prepareOpenFile(caller, args, ctx);
      case 'close_session':
        return app.prepareCloseSession(caller, args, ctx);
      case 'focus_session':
        return app.prepareFocusSession(caller, args, ctx);
      case 'read_screen':
        return screen.prepareReadScreen(caller, args, ctx);
      case 'send_input':
        return screen.prepareSendInput(caller, args, ctx);
      case 'attach_folder':
        return app.prepareAttachFolder(caller, args, ctx);
      case 'close_files':
        return app.prepareCloseFiles(caller, args, ctx);
      case 'open_review':
        return app.prepareOpenReview(caller, args, ctx);
      case 'open_diff':
        return app.prepareOpenDiff(caller, args, ctx);
      case 'open_git_history':
        return app.prepareOpenGitHistory(caller, args, ctx);
      case 'open_url':
        return app.prepareOpenUrl(caller, args, ctx);
      case 'list_machines':
        return machines.prepareListMachines(caller, args);
      case 'connect_machine':
        return machines.prepareConnectMachine(caller, args, ctx);
      case 'disconnect_machine':
        return machines.prepareDisconnectMachine(caller, args);
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
    if (r?.size) screens.ensure(sessionId, { seedTail: true });
    // One binding per typed line: a second client (`code .` from inside the CLI) never takes it.
    const lineCli = r?.lastLine?.cli;
    if (r && !r.defAdapter && r.bound === undefined) {
      if (lineCli && bindsTypedLine(kind, lineCli)) {
        setBound(sessionId, r, { connId, cli: lineCli, clientInfoName: name ?? '' });
        r.lastLine = undefined;
        r.rebind = undefined;
      } else if (name !== null && r.rebind?.clientInfoName === name) {
        setBound(sessionId, r, { connId, cli: r.rebind.cli, clientInfoName: name });
        r.rebind = undefined;
      }
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
    const resolved = resolveToken(conn.token);
    conns.set(conn.id, conn);
    if (resolved) connSession.set(conn.id, resolved);
    // The token is checked on every use, not once at hello: it dies with the PTY (spec §3.1),
    // and a connection that outlived it speaks for nobody.
    const current = (): string | null =>
      resolved && resolveToken(conn.token) === resolved ? resolved : null;
    let connectedAs: string | null = null;
    const core = createMcpServerCore({
      serverInfo: { name: 'conduit', version: VERSION },
      instructions: CONDUIT_INSTRUCTIONS,
      tools: () => {
        const sessionId = current();
        if (!sessionId) return [];
        const names = listedTools(sessionId);
        lastListed.set(conn.id, names.join(','));
        return toolSchemas().filter((t) => names.some((n) => n === t.name));
      },
      call: (name, args, ctx) => {
        const sessionId = current();
        return callTool(sessionId, name, args, {
          ...ctx,
          connId: conn.id,
          isCurrent: () =>
            sessionId !== null && current() === sessionId && conns.get(conn.id) === conn,
        });
      },
      cancelled: (requestId) => {
        flow.cancelled(conn.id, requestId);
        sessionWaits.cancel((w) => w.key.connId === conn.id && w.key.requestId === requestId);
        requestService.cancelCalls(
          (w) => w.key.connId === conn.id && w.key.requestId === requestId,
        );
      },
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
              // A draining connection still owes replies; the drain closes it after the last one.
              if (!draining.has(conn.id)) conn.close();
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
      sessionWaits.cancel((w) => w.key.connId === conn.id);
      requestService.cancelCalls((w) => w.key.connId === conn.id);
      const owner = connSession.get(conn.id);
      const r = owner === undefined ? undefined : runtime.get(owner);
      if (owner !== undefined && r?.bound === conn.id) unbind(owner, r);
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
   * only: open_session's agent is free text checked at open, so the agent set never changes the list.
   */
  const syncToolLists = () => {
    for (const s of deps.sessions.list()) {
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
          : deps.sessions.get(sessionId)?.mcpNoticesPaused
            ? 'paused'
            : (r?.gate ?? null);
    return {
      handle,
      unread: pending.length,
      urgent: pending.filter((m) => m.priority === 'urgent').length,
      paused: deps.sessions.get(sessionId)?.mcpNoticesPaused === true,
      unavailable,
      connected: registry.isLive(sessionId),
      gate,
    };
  };

  // A remote answer goes to the machine that owns the request. A stale or missing link is refused
  // before anything is sent; the owner answers again once it is back (no replay, decision 3).
  async function answerRemote(
    ref: RemoteRequestRef,
    answer: AnswerInput,
  ): Promise<RequestAnswerResult> {
    const refuse = (reason: AnswerRefusal, message: string): RequestAnswerResult => ({
      ok: false,
      reason,
      message,
      request: ref.view,
    });
    if (ref.view.remote.stale || deps.network === undefined)
      return refuse('peer_unreachable', unreachableRemote(ref.view.remote.machineName).message);
    const checked = checkRemoteAnswer(ref, answer);
    if (!checked.ok) return refuse(checked.reason, checked.message);
    const sent = await deps.network.answerRemoteRequest(ref.machineId, ref.requestId, checked.body);
    if (!sent.ok) return refuse(peerRefusalOf(sent.error.code), sent.error.message);
    return { ok: true, request: ref.view };
  }

  function postureIds(id: string, generation: number, sender: number) {
    if (
      sender === NO_OWNER_WINDOW ||
      deps.ownerWindowOf(id) !== sender ||
      !deps.windowReady(sender) ||
      !deps.sessions.get(id)
    )
      return null;
    const terminal = deps.runtime.get(id);
    const evidence = deps.sessions.nativeLaunchOf(id);
    if (
      terminal?.state !== 'live' ||
      terminal.generation !== generation ||
      !evidence ||
      evidence.generation !== generation ||
      evidence.launchId !== terminal.launchId ||
      evidence.intent.family !== 'codex'
    )
      return null;
    return { generation, launchId: terminal.launchId };
  }

  function nativeSessionUi(id: string, next: NativeSelection | undefined): NativeSessionUi {
    const terminal = deps.runtime.get(id);
    const evidence = deps.sessions.nativeLaunchOf(id);
    const atLaunch =
      terminal?.state === 'live' &&
      evidence &&
      evidence.generation === terminal.generation &&
      evidence.launchId === terminal.launchId
        ? { intent: evidence.intent, preparedAt: evidence.preparedAt }
        : null;
    return { atLaunch, next: next ?? { status: 'not-applicable' } };
  }

  let nativeImpact: { id: string; rows: NonNullable<McpUiState['nativeImpact']>['rows'] } | null =
    null;

  function uiState(): McpUiState {
    const allSessions = deps.sessions.list();
    const nextNative = policyService.nativeLaunchSelections(
      allSessions.flatMap(({ id }) => {
        const family = persistedLaunchedCli(id) ?? null;
        return isNativeFamily(family) ? [{ id, family }] : [];
      }),
    );
    const sessions: Record<string, McpSessionBadge> = {};
    const listed = new Set<string>();
    for (const { session: s, handle } of listedSessions()) {
      sessions[s.id] = badgeOf(s.id, handle);
      listed.add(s.id);
    }
    const all = store.available() ? store.threads().filter((t) => !answerOnly(t)) : [];
    const threads: McpThreadSummary[] = all.slice(0, MAX_UI_THREADS).map((t) => ({
      ...t,
      paused: store.agentCountSinceHuman(t.threadId) >= THREAD_AGENT_LIMIT,
      unreadForYou: t.unreadFor.includes(HUMAN_HANDLE),
    }));
    const youPending = store.available()
      ? store.pending(HUMAN_HANDLE).filter((m) => m.requestId === undefined)
      : [];
    const openQuestionIds = new Set(
      requestService
        .ui()
        .open.flatMap((r) => (r.source === 'message' && r.messageId !== null ? [r.messageId] : [])),
    );
    const requestOnlyThreads = new Set(youPending.map((m) => m.threadId));
    for (const m of youPending) {
      if (!(m.kind === 'question' && openQuestionIds.has(m.messageId)))
        requestOnlyThreads.delete(m.threadId);
    }
    const participantsByThread = new Map(
      all.map((thread) => [thread.threadId, thread.participants]),
    );
    const youUnreadByThread = new Map<string, number>();
    for (const message of youPending)
      youUnreadByThread.set(message.threadId, (youUnreadByThread.get(message.threadId) ?? 0) + 1);
    return {
      nativeImpact: nativeImpact
        ? {
            id: nativeImpact.id,
            total: nativeImpact.rows.length,
            rows: nativeImpact.rows.slice(0, 100),
          }
        : null,
      enabled: deps.domain.messagingOn(),
      storeError,
      loading,
      sessions,
      threads,
      attention: [
        ...attention,
        ...youAttention(
          all.filter((t) => !requestOnlyThreads.has(t.threadId)),
          new Date(now()).toISOString(),
        ),
      ],
      youUnread: youPending.length,
      youUrgent: youPending.filter((m) => m.priority === 'urgent').length,
      youUnreadByThread: [...youUnreadByThread].flatMap(([threadId, count]) => {
        const participants = participantsByThread.get(threadId);
        return participants ? [{ participants, count }] : [];
      }),
      // A listed shell gets per-session tool overrides too (plan amendment S1); one B2 hides has
      // no badge to hang the menu on.
      switchable: deps.sessions
        .list()
        .flatMap((s) => (hasDefAdapter(s.id) || listed.has(s.id) ? [s.id] : [])),
      notConnected: deps.domain.messagingOn()
        ? Object.fromEntries(
            [...runtime].flatMap(([id, r]) => (r.notConnected ? [[id, r.notConnected]] : [])),
          )
        : {},
      awaitingApproval: flow.awaitingApproval(),
      waitingAsks: flow.waitingAskCount(),
      requests: mergeRemoteRequests(requestService.ui(), remoteRequests.views()),
      native: Object.fromEntries(
        allSessions.map(({ id }) => [id, nativeSessionUi(id, nextNative.get(id))]),
      ),
      policy: {
        ...policyService.ui(
          deps.sessions
            .list()
            .map((s) => ({ sessionId: s.id, launchedCli: knownLaunchedCli(s.id) })),
        ),
        machines: remotePolicy.ui(machineName),
      },
    };
  }

  // ---- lifecycle --------------------------------------------------------------------------

  const configFileOf = (sessionId: string) => path.join(launchDir, `${sessionId}.json`);

  const settingsFileOf = (sessionId: string) => claudeSettingsFileOf(deps.dir, sessionId);

  const removeConfig = (sessionId: string) =>
    Promise.all(
      [configFileOf(sessionId), settingsFileOf(sessionId)].map((f) =>
        fs.promises.rm(f, { force: true }).catch((err: unknown) => {
          deps.log.warn('conduit-mcp', 'launch config not removed', {
            sessionId,
            err: String(err),
          });
        }),
      ),
    );

  /** see spec 2026-11-13-scheduler-auto-resume §3 "Claude Code adapter" and blockers D6. */
  const claudeSettingsFor = (
    sessionId: string,
    spec: SpawnSpec,
  ): { file: string; json: string } | null => {
    if (deps.hookClientPath === null) return null;
    const env = { ...process.env, ...spec.env };
    const user = readUserStatusLine({
      projectDir: spec.cwd,
      configDir: env.CLAUDE_CONFIG_DIR || path.join(deps.homeDir, '.claude'),
      readFile: (f) => {
        try {
          return fs.readFileSync(f, 'utf8');
        } catch {
          // A missing settings layer is the common case; the next layer applies.
          return null;
        }
      },
    });
    const { wrap, skipped } = statusLineWrapFor({
      platform: deps.platform,
      env,
      gitBash: deps.gitBashPath,
      user,
    });
    if (skipped) deps.log.info('conduit-mcp', 'status line not wrapped', { sessionId, skipped });
    return {
      file: settingsFileOf(sessionId),
      json: JSON.stringify(
        claudeHookSettings({
          execPath: deps.execPath,
          hookClient: deps.hookClientPath,
          statusLine: wrap,
        }),
      ),
    };
  };

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
    if (r.bound !== undefined && data.includes('\x1a')) unbind(sessionId, r);
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

  /**
   * Stuck-screen feed (CON-151): a CLI that stopped on a limit or update screen shows needs-you.
   * Reads the screen only for a live CLI session that printed since its last read, at most once
   * per STUCK_CHECK_MS, and reports to attention only when the verdict changes.
   */
  const stuckPass = async () => {
    const t = now();
    for (const s of deps.sessions.list()) {
      const cli = cliKindOf(s.id);
      if (cli === null || deps.runtime.get(s.id)?.state !== 'live') continue;
      const outputAt = deps.attention.lastOutputAt(s.id);
      const memo = stuckFeed.get(s.id);
      if (outputAt === undefined || outputAt === memo?.outputAt) continue;
      if (memo && t - memo.at < STUCK_CHECK_MS) continue;
      let snap: Awaited<ReturnType<typeof deps.runtime.screen>>;
      try {
        snap = await deps.runtime.screen(s.id);
      } catch (err) {
        // One unreadable screen must not skip the other sessions or the notifier this tick.
        deps.log.warn('conduit-mcp', 'stuck screen read failed', {
          sessionId: s.id,
          err: String(err),
        });
        continue;
      }
      if (!snap || deps.runtime.get(s.id)?.state !== 'live') continue;
      const stuck = detectStuckScreen(cli, snap.lines, deps.domain.limitRules());
      const prev = memo?.stuck ?? null;
      stuckFeed.set(s.id, { at: t, outputAt, stuck });
      if (prev?.kind === stuck?.kind && prev?.reason === stuck?.reason) continue;
      deps.attention.setStuck(s.id, stuck);
    }
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
        install: deps.domain.installState(cli),
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
    await stuckPass();
    void startupPass();
    if (!notifier) return;
    // Badge gate state for every notifiable session, then the notifier's own pass.
    for (const s of notifierSessions()) await evaluate(s.sessionId);
    await notifier.tick();
  };

  /**
   * Any session may run a CLI the user installed Conduit into: it gets identity env, but a handle
   * only when a CLI initializes (spec 2026-10-27-conduit-mcp-install §3.1).
   */
  const wireWithoutAdapter = (r: Runtime, spec: SpawnSpec, token: string): SpawnSpec => {
    if (!deps.domain.messagingOn() || !endpointReady) {
      return spec;
    }
    r.tracker = createTypedLineTracker();
    return {
      ...spec,
      env: { ...spec.env, CONDUIT_SESSION_TOKEN: token, CONDUIT_MCP_ENDPOINT: deps.endpointPath },
    };
  };

  const stopRuntime = deps.runtime.on((event) => {
    const sessionId = 'sessionId' in event ? event.sessionId : undefined;
    if (sessionId === undefined) return;
    const r = runtime.get(sessionId);
    // Attention clears its own stuck fact on spawn and exit; the feed's memo must match it.
    if (event.type === 'spawned' || event.type === 'exit') {
      stuckFeed.delete(sessionId);
      scheduleBroadcast();
    }
    if (event.type === 'spawned') {
      if (!r) return;
      r.size = event.size;
      r.spawnedAt = now();
      r.hasDraft = false;
      r.lastInputAt = undefined;
      if (r.defAdapter && !r.unavailable) {
        // A retired PTY ends with no exit event, so the previous child's model would carry over.
        screens.release(sessionId);
        screens.ensure(sessionId, { seedTail: false });
      } else screens.keepTail(sessionId);
    } else if (event.type === 'size') {
      if (r) r.size = event.size;
    } else if (event.type === 'exit') {
      // A late exit of an older generation would revoke the live launch's token and binding.
      if (!r || event.generation !== r.launch) return;
      const watch = startupWatches.get(sessionId);
      if (watch) watch.exited = true;
      const terminal = deps.runtime.get(sessionId);
      const owner = deps.ownerWindowOf(sessionId);
      if (
        (!terminal || terminal.generation === event.generation) &&
        owner !== null &&
        deps.windowReady(owner)
      ) {
        sendToWindow(owner, {
          type: 'mcp:codexPostureChanged',
          sessionId,
          generation: event.generation,
          view: { status: 'unavailable' },
        });
      }
      cancelLateEcho(sessionId);
      deps.tokens.revoke({ sessionId }).catch((err: unknown) => {
        deps.log.warn('conduit-mcp', 'token not revoked', { sessionId, err: String(err) });
      });
      closeConnectionsOf(sessionId);
      void removeConfig(sessionId);
      screens.release(sessionId);
      r.spawnedAt = undefined;
      r.tracker = undefined;
      r.lastLine = undefined;
      setBound(sessionId, r, undefined);
      r.rebind = undefined;
      r.detect = undefined;
      r.notConnected = undefined;
      scheduleBroadcast();
    }
  });
  return {
    async start() {
      if (stopped) return;
      policyService.start();
      stopAttentionWatch = deps.attention.onChange(() => {
        sessionWaits.notify();
        requestService.onAttention(factsWithHandles());
      });
      stopGrantEligibilityWatch = deps.network?.onGrantPeerEligibilityChange(() =>
        policyService.peerEligibilityChanged(),
      );
      stopNetworkWatch = deps.network?.onChange(() => {
        policyService.reconcilePrincipals();
        syncToolLists();
        flow.recheck();
        scheduleBroadcast();
        sessionWaits.notify();
      });
      startupSweep = (async () => {
        try {
          // Configs left by a crash: they name a dead session and can't be reused.
          await fs.promises.rm(launchDir, { recursive: true, force: true });
          if (!stopped) await fs.promises.mkdir(launchDir, { recursive: true });
        } catch (err) {
          deps.log.warn('conduit-mcp', 'launch dir sweep failed', { err: String(err) });
        }
      })();
      await startupSweep;
      if (stopped) return;
      // Listening before the store loads: a launch wired before then would point its shim at
      // nothing, and one wired while the store loads only meets store_unavailable, which it can retry.
      // A listen that throws is a down endpoint like a refused one; either way the launches
      // waiting on it go now, as endpoint-down, rather than at the bound.
      try {
        if (deps.listen !== false) {
          const create = deps.createEndpoint;
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
      if (stopped) return;
      scheduleBroadcast();
      requestService.start();
      requestService.onAttention(factsWithHandles());
      await loadStore();
      requestService.onQuestions(unreadQuestions());
      requestService.retryDeliveries();
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
          requestService.purge();
        }, RETENTION_EVERY_MS);
        retentionTimer.unref?.();
      }
    },

    // Every definition waits, not only adapters: a shell restored at start would otherwise launch
    // tokenless before the endpoint listens (plan amendment B1).
    whenLaunchReady() {
      if (endpointSettled || !deps.domain.messagingOn()) return Promise.resolve();
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

    prepareNativeLaunch(sessionId, def, spec) {
      const family = adapterFor(def, { e2e: deps.e2e })?.id ?? null;
      if (!isNativeFamily(family)) return { ok: true, spec };
      return prepareNativeLaunch(
        policyService.nativeLaunch(sessionId, family),
        def,
        spec,
        deps.platform,
      );
    },

    prepareLaunch(sessionId, def, spec, ids) {
      if (stopped) return spec;
      const adapter = adapterFor(def, { e2e: deps.e2e });
      const session = deps.sessions.get(sessionId);
      if (!session) return spec;
      const { token } = deps.tokens.reserve(sessionId, ids);
      const r = rt(sessionId);
      r.defAdapter = adapter;
      r.unavailable = null;
      r.launch = ids.generation;
      r.tracker = undefined;
      r.lastLine = undefined;
      setBound(sessionId, r, undefined);
      r.rebind = undefined;
      r.detect = undefined;
      if (r.notConnected) {
        r.notConnected = undefined;
        scheduleBroadcast();
      }
      if (!adapter) return wireWithoutAdapter(r, spec, token);
      if (claimHandle(sessionId, adapter.id) === null) {
        return spec;
      }

      const unavailable = (reason: McpUnavailableReason) => {
        r.unavailable = reason;
        scheduleBroadcast();
        // Claude's limit hooks ride on this wiring: say so, since auto-resume falls back to rules.
        if (adapter.wiring === 'mcp-config-flag')
          deps.log.info('conduit-mcp', 'Claude hooks not injected', { sessionId, reason });
        return spec;
      };
      if (!deps.domain.messagingOn()) return unavailable('messaging-off');
      if (!endpointReady) return unavailable('endpoint-down');
      if (adapter.wiring === 'cursor-global' && !readCursorLaunchEntry(deps.homeDir)) {
        r.notConnected = {
          cli: 'cursor',
          install: deps.domain.installState('cursor'),
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
        claudeSettings:
          adapter.wiring === 'mcp-config-flag' ? claudeSettingsFor(sessionId, spec) : null,
      });
      if (!wiring.ok) return unavailable(wiring.reason);
      if (wiring.configJson !== null) {
        try {
          fs.mkdirSync(launchDir, { recursive: true });
          atomicWriteFileSync(configFile, wiring.configJson);
          if (wiring.settingsJson !== null)
            atomicWriteFileSync(settingsFileOf(sessionId), wiring.settingsJson);
        } catch (err) {
          deps.log.error('conduit-mcp', 'launch config write failed', { err: String(err) });
          return unavailable('launch-io');
        }
      }
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

    onRendererInput(sessionId, data) {
      requestService.humanActive();
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
          install = deps.domain.installState(nc.cli);
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

    /**
     * closeWhenDone's exit: close_session's routed close with no caller. The in-flight entry has no
     * request id, so no CLI cancel ends the UI wait; its own timeout does. Unsaved changes keep the
     * session open, exited and listed.
     */
    async closeWhenDone(sessionId) {
      const closing = { deleted: false };
      closingWhenDone.set(sessionId, closing);
      const ctx: ControlCallContext = {
        stillCurrent: () => !stopped && !closing.deleted,
        move: undefined,
        reach: undefined,
        ui: (windowId, routedSessionId, action) =>
          flow.requestUi({
            inflight: flow.begin({ connId: UNTRACKED_CONN, requestId: null }),
            callerSessionId: sessionId,
            routedSessionId,
            windowId,
            action,
          }),
        // No CLI call to cancel: the close outlives any request, so nothing aborts this signal.
        signal: new AbortController().signal,
      };
      try {
        const r = await app.closeRouted(sessionId, undefined, ctx);
        // The renderer's own kill ends the wait as window_not_ready; the session is closed all the same.
        if (closing.deleted) deps.log.info('conduit-mcp', 'closeWhenDone closed', { sessionId });
        else if (!r.ok)
          deps.log.info('conduit-mcp', 'closeWhenDone kept open', {
            sessionId,
            code: r.error.code,
          });
      } finally {
        if (closingWhenDone.get(sessionId) === closing) closingWhenDone.delete(sessionId);
      }
    },

    async onSessionDeleted(sessionId) {
      deleting.add(sessionId);
      if (nativeImpact?.rows.some((row) => row.sessionId === sessionId)) {
        const rows = nativeImpact.rows.filter((row) => row.sessionId !== sessionId);
        nativeImpact = rows.length ? { ...nativeImpact, rows } : null;
        scheduleBroadcast();
      }
      try {
        forgetBudget(sessionId);
        const closing = closingWhenDone.get(sessionId);
        if (closing) closing.deleted = true;
        // Before the drain: the session's waiting asks end now, so their cancelled replies are owed.
        flow.sessionGone(sessionId);
        sessionWaits.cancel((w) => w.caller.sessionId === sessionId);
        requestService.onSessionDeleted(sessionId);
        policyService.sessionEnded(sessionId);
        const handle = handleOf(sessionId);
        sessionWaits.forget(sessionId, handle);
        // Awaited after the teardown: the caller removes the session as soon as this yields.
        const revoked = deps.tokens.revoke({ sessionId });
        drainConnectionsOf(sessionId);
        screens.release(sessionId);
        notifier?.forget(sessionId);
        cancelLateEcho(sessionId);
        deps.typing.forget(sessionId);
        runtime.delete(sessionId);
        await revoked;
        await removeConfig(sessionId);
        if (!handle) return;
        for (const m of store.pending(handle)) {
          const r = await store.setStatus(m.messageId, handle, 'undelivered');
          if (!r.ok)
            deps.log.warn('conduit-mcp', 'undelivered mark failed', { code: r.error.code });
        }
        dispatch({ t: 'session-gone', handle });
        scheduleBroadcast();
      } finally {
        deleting.delete(sessionId);
      }
    },

    onWindowReset(windowId) {
      flow.windowReset(windowId);
    },

    onSessionMoved(sessionId) {
      flow.sessionMoved(sessionId);
    },

    resumeLaunch(sessionId, def, ids, binding) {
      if (!deps.sessions.get(sessionId)) return;
      const adapter = adapterFor(def, { e2e: deps.e2e });
      const rows = deps.tokens.rows();
      const tokenBearing =
        rows.state === 'loaded' &&
        rows.rows.some(
          (row) =>
            row.sessionId === sessionId &&
            row.generation === ids.generation &&
            row.state !== 'superseded',
        );
      const r = rt(sessionId);
      r.defAdapter = adapter;
      r.unavailable = null;
      r.launch = ids.generation;
      // As wireWithoutAdapter: only a shell that got identity env runs a CLI that can connect.
      r.tracker = !adapter && tokenBearing ? createTypedLineTracker() : undefined;
      r.lastLine = undefined;
      r.bound = undefined;
      r.boundAs = undefined;
      r.detect = undefined;
      r.rebind =
        binding &&
        !adapter &&
        binding.sessionId === sessionId &&
        binding.generation === ids.generation
          ? binding
          : undefined;
      scheduleBroadcast();
    },

    refresh() {
      syncToolLists();
      flow.recheck();
      scheduleBroadcast();
    },

    uiState,

    async handleRenderer(m, reply, senderId) {
      switch (m.type) {
        case 'mcp:linkCodexThread':
        case 'mcp:codexPostureQuery': {
          if (
            !Number.isSafeInteger(m.requestId) ||
            m.requestId < 0 ||
            typeof m.sessionId !== 'string' ||
            m.sessionId.length > 256 ||
            !Number.isSafeInteger(m.generation) ||
            m.generation < 1
          )
            return;
          const ids = postureIds(m.sessionId, m.generation, senderId);
          const allowed =
            ids &&
            (m.type !== 'mcp:linkCodexThread' ||
              (typeof m.threadId === 'string' &&
                m.threadId.length === 36 &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(m.threadId) &&
                deps.domain.codexPosture.link(m.sessionId, ids, m.threadId)));
          const posture = allowed && ids ? deps.domain.codexPosture.get(m.sessionId, ids) : null;
          reply({
            type: 'mcp:codexPostureResult',
            requestId: m.requestId,
            sessionId: m.sessionId,
            generation: m.generation,
            view: posture
              ? { status: 'linked', source: 'linked-codex-thread', ...posture }
              : { status: 'unavailable' },
          });
          return;
        }
        case 'mcp:dismissNativeImpact': {
          if (
            !Number.isSafeInteger(m.requestId) ||
            m.requestId < 0 ||
            senderId <= 0 ||
            !deps.windowReady(senderId) ||
            'machine' in m ||
            typeof m.id !== 'string' ||
            m.id.length === 0 ||
            m.id.length > 256
          )
            return;
          const dismissed = nativeImpact?.id === m.id;
          if (dismissed) {
            nativeImpact = null;
            scheduleBroadcast();
          }
          reply({ type: 'mcp:dismissNativeImpactResult', requestId: m.requestId, dismissed });
          return;
        }
        case 'mcp:grantLifecycle': {
          if (
            !Number.isSafeInteger(m.requestId) ||
            m.requestId < 0 ||
            senderId <= 0 ||
            !deps.windowReady(senderId) ||
            'machine' in m ||
            typeof m.operation !== 'object' ||
            m.operation === null ||
            'machine' in m.operation
          )
            return;
          const op = m.operation;
          const bounded = (value: unknown): value is string =>
            typeof value === 'string' && value.length > 0 && value.length <= 256;
          if (op.kind === 'undo') {
            if (!bounded(op.token)) return;
            reply({
              type: 'mcp:grantLifecycleResult',
              requestId: m.requestId,
              result: policyService.undoGrantRevoke(op.token, senderId),
            });
            return;
          }
          if (
            (op.kind !== 'extend' && op.kind !== 'renew' && op.kind !== 'revoke') ||
            !bounded(op.id) ||
            !bounded(op.expectedToken) ||
            !Number.isSafeInteger(op.revision) ||
            op.revision < 0
          )
            return;
          const result =
            op.kind === 'extend'
              ? policyService.extendGrant(op.id, op.revision, op.expectedToken)
              : op.kind === 'renew'
                ? policyService.renewGrant(op.id, op.revision, op.expectedToken)
                : policyService.revokeGrantWithUndo(op.id, op.revision, op.expectedToken, senderId);
          reply({ type: 'mcp:grantLifecycleResult', requestId: m.requestId, result });
          return;
        }
        case 'mcp:ownerPermissions:get': {
          if (
            !Number.isSafeInteger(m.requestId) ||
            m.requestId < 0 ||
            (m.state !== 'open' && m.state !== 'closed')
          )
            return;
          const cursor = m.cursor;
          if (
            cursor !== undefined &&
            (typeof cursor !== 'object' ||
              cursor === null ||
              typeof cursor.at !== 'string' ||
              cursor.at.length > 30 ||
              !Number.isFinite(Date.parse(cursor.at)) ||
              new Date(cursor.at).toISOString() !== cursor.at ||
              typeof cursor.id !== 'string' ||
              cursor.id.length === 0 ||
              cursor.id.length > 256)
          )
            return;
          const rows = requestService.ownerPermissions().flatMap((r) => {
            if (!r.session || !r.permission || (r.state === 'open') !== (m.state === 'open'))
              return [];
            const live = r.state === 'open' && flow.ownsPermissionWait(r.id, senderId);
            const current =
              deps.ownerWindowOf(r.session) === senderId && deps.windowReady(senderId);
            const p = principalOf(r.session);
            if (r.state === 'open' ? !live : !current) return [];
            const grantable = r.permission.grantable !== false;
            const late =
              r.state === 'expired' &&
              current &&
              p !== null &&
              r.permission.lateGrant === null &&
              grantable;
            const choices: GrantChoice[] = [];
            if (grantable && p !== null && (live || late))
              for (const who of GRANT_WHO_KINDS)
                for (const on of GRANT_CHOICE_ON)
                  for (const duration of GRANT_FORS) {
                    const choice: GrantChoice = { who, on, for: duration };
                    if (grantTargetsFor(choice, p, r.permission.targets) !== null)
                      choices.push(choice);
                  }
            if (r.state === 'expired' && p === null) return [];
            return [
              {
                id: r.id,
                sessionId: r.session,
                requester: r.requester,
                space: r.space,
                lead: r.lead,
                machine: r.machine,
                title: r.title,
                tool: r.permission.tool,
                why: r.permission.why,
                state: r.state,
                createdAt: r.createdAt,
                expiresAt: r.expiresAt,
                endedAt: r.endedAt,
                withdrawReason: r.withdrawReason,
                grantable,
                answerable: live || (late && choices.length > 0),
                nextTimeGrantSaved: r.permission.lateGrant !== null,
                choices,
              },
            ];
          });
          const key = (r: (typeof rows)[number]) =>
            m.state === 'open' ? r.createdAt : (r.endedAt ?? '');
          const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
          const direction = m.state === 'open' ? 1 : -1;
          rows.sort((a, b) => direction * (compare(key(a), key(b)) || compare(a.id, b.id)));
          const retained = m.state === 'closed' ? rows.slice(0, 200) : rows;
          const after = cursor
            ? retained.filter(
                (r) => direction * (compare(key(r), cursor.at) || compare(r.id, cursor.id)) > 0,
              )
            : retained;
          const permissions = after.slice(0, 50);
          const last = permissions[permissions.length - 1];
          reply({
            type: 'mcp:ownerPermissions',
            requestId: m.requestId,
            page: {
              permissions,
              nextCursor: after.length > 50 && last ? { at: key(last), id: last.id } : null,
            },
          });
          return;
        }
        case 'mcp:preview': {
          if (!Number.isSafeInteger(m.requestId) || m.requestId < 0) return;
          const invalid = () =>
            reply({
              type: 'mcp:previewResult',
              requestId: m.requestId,
              result: { ok: false, error: 'invalid-value' },
            });
          const draft: unknown = m.draft;
          if (
            !keys(m, ['type', 'requestId', 'sessionId', 'intent', 'draft', 'expectedToken']) ||
            typeof m.expectedToken !== 'string' ||
            !boundedString(m.expectedToken) ||
            typeof m.sessionId !== 'string' ||
            !boundedString(m.sessionId) ||
            !withinPolicyLimit(draft) ||
            (draft !== null &&
              (!keys(draft, ['point', 'assignment']) ||
                !knownPoint(draft.point) ||
                !knownAssignment(draft.point, draft.assignment) ||
                !localOwner(senderId, {
                  kind: 'assignment',
                  point: draft.point,
                  assignment: draft.assignment as Assignment | null,
                })))
          ) {
            invalid();
            return;
          }
          const principal = principalOf(m.sessionId);
          if (
            !principal ||
            !runtime.get(m.sessionId) ||
            senderId === NO_OWNER_WINDOW ||
            senderId <= 0 ||
            deps.ownerWindowOf(m.sessionId) !== senderId ||
            !deps.windowReady(senderId)
          ) {
            invalid();
            return;
          }
          const intent: unknown = m.intent;
          let args: Record<string, unknown>;
          if (
            keys(intent, ['tool', 'targetSessionId']) &&
            intent.tool === 'close_session' &&
            typeof intent.targetSessionId === 'string' &&
            intent.targetSessionId.length > 0 &&
            intent.targetSessionId.length <= 512 &&
            deps.sessions.get(intent.targetSessionId)
          ) {
            args = { session: intent.targetSessionId };
          } else if (
            keys(intent, ['tool', 'path']) &&
            intent.tool === 'open_file' &&
            typeof intent.path === 'string' &&
            intent.path.length > 0 &&
            intent.path.length <= 512 &&
            path.isAbsolute(intent.path) &&
            [...intent.path].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
          ) {
            args = { path: intent.path };
          } else {
            invalid();
            return;
          }
          const tool = intent.tool;
          const targets = resolveTargets(
            tool,
            args,
            { sessionId: m.sessionId, home: principal.homeFolder },
            targetDepsOf(),
          );
          if (targets.length !== 1) {
            invalid();
            return;
          }
          const result = policyService.preview(
            { principal, tool, targets, masterOn: deps.domain.messagingOn(), toYou: false },
            m.draft,
            m.expectedToken,
          );
          reply({ type: 'mcp:previewResult', requestId: m.requestId, result });
          return;
        }
        case 'mcp:replay': {
          if (!Number.isSafeInteger(m.requestId) || m.requestId < 0) return;
          const draft: unknown = m.draft;
          const valid =
            keys(m, ['type', 'requestId', 'draft', 'expectedToken']) &&
            typeof m.expectedToken === 'string' &&
            boundedString(m.expectedToken) &&
            withinPolicyLimit(draft) &&
            keys(draft, ['point', 'assignment']) &&
            knownPoint(draft.point) &&
            knownAssignment(draft.point, draft.assignment) &&
            localOwner(senderId, {
              kind: 'assignment',
              point: draft.point,
              assignment: draft.assignment as Assignment | null,
            });
          const result = valid
            ? policyService.replay(m.draft, m.expectedToken)
            : { ok: false as const, error: 'invalid-value' as const };
          reply({ type: 'mcp:replayResult', requestId: m.requestId, result });
          return;
        }
        case 'mcp:activity:lookup': {
          if (!Number.isSafeInteger(m.requestId) || m.requestId < 0) return;
          const result =
            keys(m, ['type', 'requestId', 'id', 'at']) &&
            senderId > 0 &&
            senderId !== NO_OWNER_WINDOW &&
            deps.windowReady(senderId)
              ? policyService.activity.lookup(m.id, m.at)
              : { ok: false as const, error: 'invalid-value' as const };
          reply({ type: 'mcp:activity:row', requestId: m.requestId, result });
          return;
        }
        case 'mcp:activity:get': {
          if (!Number.isSafeInteger(m.requestId) || m.requestId < 0) return;
          const query = parseActivityQuery(m.query);
          const page =
            query === null
              ? {
                  rows: [],
                  next: null,
                  writable: policyService.activity.writable(),
                  error: 'Invalid Activity query',
                }
              : policyService.activity.query(query);
          reply({ type: 'mcp:activity', requestId: m.requestId, page });
          return;
        }
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
          const msgs = store.thread(m.threadId).filter((x) => x.requestId === undefined);
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
        case 'mcp:reviewLocalPolicy':
        case 'mcp:saveAssignment':
        case 'mcp:saveProfile':
        case 'mcp:deleteProfile':
        case 'mcp:policyRetry': {
          if (!Number.isSafeInteger(m.requestId) || m.requestId < 0) return;
          const edit =
            m.type === 'mcp:reviewLocalPolicy'
              ? m.edit
              : m.type === 'mcp:saveAssignment'
                ? { kind: 'assignment', point: m.point, assignment: m.assignment }
                : m.type === 'mcp:saveProfile'
                  ? { kind: 'profile', profile: m.profile }
                  : m.type === 'mcp:deleteProfile'
                    ? { kind: 'delete-profile', profileId: m.profileId, replacement: m.replacement }
                    : null;
          let bounded = false;
          try {
            bounded = edit !== null && withinPolicyLimit(edit) && validLocalEdit(edit);
          } catch {
            bounded = false;
          }
          const tokenValid =
            m.type === 'mcp:policyRetry' ||
            (typeof m.expectedToken === 'string' &&
              m.expectedToken.length > 0 &&
              m.expectedToken.length <= 512);
          const authorized =
            m.type === 'mcp:policyRetry'
              ? senderId > 0 && senderId !== NO_OWNER_WINDOW && deps.windowReady(senderId)
              : bounded && edit !== null && validLocalEdit(edit) && localOwner(senderId, edit);
          const envelopeKeys =
            m.type === 'mcp:reviewLocalPolicy'
              ? ['type', 'requestId', 'expectedToken', 'edit']
              : m.type === 'mcp:saveAssignment'
                ? ['type', 'requestId', 'expectedToken', 'point', 'assignment', 'nativeReview']
                : m.type === 'mcp:saveProfile'
                  ? ['type', 'requestId', 'expectedToken', 'profile', 'nativeReview']
                  : m.type === 'mcp:deleteProfile'
                    ? [
                        'type',
                        'requestId',
                        'expectedToken',
                        'profileId',
                        'replacement',
                        'nativeReview',
                      ]
                    : ['type', 'requestId'];
          const invalid =
            !keys(m, envelopeKeys) ||
            !withinPolicyLimit(m) ||
            !authorized ||
            !tokenValid ||
            'machine' in m ||
            'nativeConsent' in m ||
            ('nativeReview' in m &&
              (typeof m.nativeReview !== 'string' || !/^[a-f0-9]{64}$/.test(m.nativeReview)));
          if (m.type === 'mcp:reviewLocalPolicy') {
            reply({
              type: 'mcp:reviewLocalPolicyResult',
              requestId: m.requestId,
              result: invalid
                ? { ok: false, error: 'invalid-value' }
                : policyService.reviewLocalPolicy(
                    m.edit,
                    m.expectedToken,
                    deps.sessions.list().flatMap((s) => {
                      const family = persistedLaunchedCli(s.id);
                      return family === 'claude' || family === 'codex'
                        ? [{ sessionId: s.id, family }]
                        : [];
                    }),
                  ),
            });
            return;
          }
          const result = invalid
            ? { ok: false as const, error: 'invalid-value' as const }
            : m.type === 'mcp:saveAssignment'
              ? policyService.saveAssignment(m.point, m.assignment, m.expectedToken, m.nativeReview)
              : m.type === 'mcp:saveProfile'
                ? policyService.saveProfile(m.profile, m.expectedToken, m.nativeReview)
                : m.type === 'mcp:deleteProfile'
                  ? policyService.deleteProfile(
                      m.profileId,
                      m.replacement,
                      m.expectedToken,
                      m.nativeReview,
                    )
                  : policyService.retrySave();
          reply({ type: 'mcp:policyEditResult', requestId: m.requestId, result });
          if (result.ok) {
            syncToolLists();
            flow.recheck();
          }
          scheduleBroadcast();
          return;
        }
        case 'mcp:acknowledgeMigration': {
          const valid =
            keys(m, ['type', 'requestId', 'expectedToken']) &&
            Number.isSafeInteger(m.requestId) &&
            m.requestId >= 0 &&
            typeof m.expectedToken === 'string' &&
            m.expectedToken.length > 0 &&
            m.expectedToken.length <= 512 &&
            senderId > 0 &&
            senderId !== NO_OWNER_WINDOW &&
            deps.windowReady(senderId);
          const result = valid
            ? policyService.acknowledgeMigration(m.expectedToken)
            : { ok: false as const, error: 'invalid-value' as const };
          reply({ type: 'mcp:policyEditResult', requestId: m.requestId, result });
          return;
        }
        case 'mcp:revokeGrant': {
          if (m.machine !== undefined) {
            const machine = m.machine;
            const grantId = m.grantId;
            const res =
              typeof grantId === 'string' ? await remotePolicy.revoke(machine, grantId) : null;
            if (res !== null && res.ok)
              reply({ type: 'mcp:policyResult', requestId: m.requestId, ok: true });
            else
              reply({
                type: 'mcp:policyResult',
                requestId: m.requestId,
                ok: false,
                error: res === null ? 'not-found' : res.error.code,
              });
            return;
          }
          const result =
            typeof m.grantId === 'string'
              ? policyService.revokeGrant(m.grantId)
              : { ok: false as const, error: 'not-found' as const };
          reply({ type: 'mcp:policyResult', requestId: m.requestId, ...result });
          if (result.ok || result.applied === 'tightening') {
            syncToolLists();
            flow.recheck();
          }
          return;
        }
        case 'mcp:remoteEdit':
        case 'mcp:remotePolicy': {
          if (
            senderId <= 0 ||
            senderId === NO_OWNER_WINDOW ||
            !deps.windowReady(senderId) ||
            !machineArg(m.machine) ||
            m.machine === undefined ||
            typeof m.expectedToken !== 'string' ||
            ('nativeConsent' in m && typeof m.nativeConsent !== 'boolean') ||
            typeof m.requestId !== 'number'
          ) {
            reply({
              type: 'mcp:policyEditResult',
              requestId: m.requestId,
              result: { ok: false, error: 'invalid-value' },
            });
            return;
          }
          const result =
            m.type === 'mcp:remoteEdit'
              ? remotePolicy.editFull(m.machine, m.expectedToken, m.edit, m.nativeConsent)
              : m.action === 'discard'
                ? remotePolicy.discard(m.machine, m.expectedToken)
                : m.action === 'reapply'
                  ? remotePolicy.reapply(m.machine, m.expectedToken, m.nativeConsent)
                  : m.action === 'retry-save'
                    ? remotePolicy.retrySave(m.machine, m.expectedToken)
                    : { ok: false as const, error: 'invalid-value' as const };
          reply({ type: 'mcp:policyEditResult', requestId: m.requestId, result });
          return;
        }
        case 'mcp:allowOnce': {
          const denied = { ok: false as const, error: 'not-found' as const };
          let result: typeof denied | ReturnType<typeof policyService.saveActivityOverride> =
            denied;
          if (
            !Number.isSafeInteger(m.requestId) ||
            m.requestId < 0 ||
            senderId <= 0 ||
            senderId === NO_OWNER_WINDOW ||
            !deps.windowReady(senderId)
          ) {
            reply({ type: 'mcp:policyResult', requestId: m.requestId, ...denied });
            return;
          }
          const found = policyService.activity.lookup(m.activityId, m.at);
          if (found.ok) {
            const trace = found.row.trace;
            const facts = trace?.facts;
            const actor = facts?.principal;
            const recorded = facts?.targets[0];
            if (
              trace?.winnerDigest &&
              trace.decision === 'deny' &&
              trace.reason.by === 'deny' &&
              trace.runtime.outcome === 'not-reached' &&
              facts &&
              facts.tool === 'close_session' &&
              facts.targets.length === 1 &&
              actor?.kind === 'session' &&
              actor.generation !== null &&
              recorded?.sessionId &&
              recorded.path === null &&
              facts.masterOn &&
              !facts.toYou &&
              !facts.forceAsk &&
              found.row.lane === 'conduit' &&
              found.row.outcome === 'denied' &&
              found.row.action === facts.tool &&
              found.row.principal.sessionId === actor.sessionId &&
              found.row.cli === actor.launchedCli &&
              deps.ownerWindowOf(actor.sessionId) === senderId
            ) {
              const callerId = actor.sessionId;
              const targetId = recorded.sessionId;
              const override: OneUseOverride = {
                id: randomBytes(12).toString('hex'),
                sessionId: callerId,
                generation: actor.generation,
                tool: 'close_session',
                target: recorded,
                createdAt: new Date(now()).toISOString(),
              };
              const current = () => {
                const principal = principalOf(callerId);
                const targets = principal
                  ? resolveTargets(
                      'close_session',
                      { session: targetId },
                      { sessionId: callerId, home: principal.homeFolder },
                      targetDepsOf(),
                    )
                  : [];
                const target = targets[0];
                if (
                  !principal ||
                  principal.generation !== actor.generation ||
                  principal.launchedCli !== actor.launchedCli ||
                  principal.projectId !== actor.projectId ||
                  deps.ownerWindowOf(callerId) !== senderId ||
                  !deps.windowReady(senderId) ||
                  !deps.domain.messagingOn() ||
                  targets.length !== 1 ||
                  !target ||
                  target.sessionId !== recorded.sessionId ||
                  !samePath(target.path, recorded.path) ||
                  !samePath(target.folder, recorded.folder) ||
                  target.projectId !== recorded.projectId
                )
                  return null;
                const input = {
                  principal,
                  tool: 'close_session' as const,
                  targets,
                  masterOn: true,
                  toYou: false,
                  forceAsk: false,
                };
                const original = policyService.decideWithTrace(input, actor.generation);
                if (
                  original.decision.decision !== 'deny' ||
                  original.decision.reason.by !== 'deny' ||
                  original.trace?.winnerDigest !== trace.winnerDigest
                )
                  return null;
                const proposed = policyService.decide({ ...input, heldOverrides: [override] });
                if (
                  proposed.decision !== 'allow' ||
                  proposed.reason.by !== 'override' ||
                  proposed.reason.overrideId !== override.id ||
                  gateToolCall({
                    sessionId: callerId,
                    messagingOn: true,
                    tool: 'close_session',
                    decision: proposed,
                    ownerReady: () => deps.windowReady(senderId),
                    onScreen: () => deps.onScreen(senderId, callerId),
                    appConnected: deps.appConnected(),
                  })
                )
                  return null;
                return { principal, proposed };
              };
              const before = current();
              if (before) {
                const controller = new AbortController();
                const prepared = await app.prepareCloseSession(
                  { handle: before.principal.handle, sessionId: callerId },
                  { session: targetId },
                  {
                    stillCurrent: () => current() !== null,
                    move: before.proposed.rule.move ?? undefined,
                    reach: before.proposed.rule.reach ?? undefined,
                    signal: controller.signal,
                    ui: async () => ({
                      ok: false,
                      error: toolError('tool_disabled', 'Preflight cannot dispatch'),
                    }),
                  },
                );
                if (prepared.ok && !('done' in prepared.value)) {
                  prepared.value.release();
                  prepared.value.budget?.dispose();
                  const after = current();
                  if (
                    after &&
                    JSON.stringify(after.proposed.rule) === JSON.stringify(before.proposed.rule)
                  )
                    result = policyService.saveActivityOverride(
                      { id: m.activityId, at: m.at },
                      override,
                    );
                }
              }
            }
          }
          reply({ type: 'mcp:policyResult', requestId: m.requestId, ...result });
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
        case 'mcp:uiResult':
          // Re-parsed against the wait's kind and bound to the window it was sent to.
          if (typeof m.requestId !== 'string' || !flow.answerUi(m.requestId, senderId, m.result))
            deps.log.debug('conduit-mcp', 'ui result ignored', {
              requestId: m.requestId,
              senderId,
            });
          return;
        case 'mcp:requestAnswer': {
          const remote = remoteRequests.resolve(m.requestId);
          const result =
            remote === null
              ? await requestService.answerFromRenderer(m.requestId, m.answer, senderId)
              : await answerRemote(remote, m.answer);
          reply({ type: 'mcp:requestResult', requestId: m.requestId, result });
          return;
        }
        case 'mcp:permissionAnswer': {
          const result = await requestService.answerPermission(m.requestId, m.answer, {
            kind: 'you',
            windowId: senderId,
          });
          reply({
            type: 'mcp:permissionResult',
            requestId: m.requestId,
            ...(result.ok
              ? { ok: true }
              : { ok: false, reason: result.reason, message: result.message }),
          });
          return;
        }
        case 'mcp:setAway':
          requestService.setAway(m.away, m.until);
          return;
        case 'mcp:pause':
          deps.sessions.setMcp(m.sessionId, { mcpNoticesPaused: m.paused });
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

    peerRevoked(machineId) {
      policyService.peerRevoked(machineId);
      remoteRequests.setLinkState(machineId, 'gone');
    },
    recordObserved(sessionId, cli, entry) {
      // A late row for a deleted session must not create a budget that nothing will ever clear.
      if (stopped || deleting.has(sessionId) || deps.sessions.get(sessionId) === undefined) return;
      if ('postureChanged' in entry) {
        const windowId = deps.ownerWindowOf(sessionId);
        if (windowId === null) return;
        const ids = postureIds(sessionId, entry.postureChanged.generation, windowId);
        if (!ids || ids.launchId !== entry.postureChanged.launchId) return;
        const posture = deps.domain.codexPosture.get(sessionId, ids);
        sendToWindow(windowId, {
          type: 'mcp:codexPostureChanged',
          sessionId,
          generation: ids.generation,
          view: posture
            ? { status: 'linked', source: 'linked-codex-thread', ...posture }
            : { status: 'unavailable' },
        });
        return;
      }
      if ('action' in entry) {
        const t = now();
        const minute = Math.floor(t / MINUTE_MS);
        const budget = budgetFor(sessionId, cli, minute);
        if (budget.rows >= OBSERVED_ROWS_PER_MINUTE) {
          budget.dropped += 1;
          if (budget.timer === null) {
            // see plan m3: a dropped batch is noted at its minute's end, even if no later row comes
            budget.timer = {
              handle: setTimer(
                () => flushThrottle(sessionId, budget),
                (minute + 1) * MINUTE_MS - t,
              ),
            };
          }
          return;
        }
        budget.rows += 1;
        const row = observedRow(entry.action);
        policyService.activity.record({
          lane: 'observed',
          principal: { handle: handleOf(sessionId) ?? null, sessionId, machineId: null },
          cli,
          action: capSummary(row.action),
          target: capOrNull(row.target),
          summary: capOrNull(row.summary),
          decision: null,
          decidedBy: `observed: decided by ${CLI_DISPLAY_NAME[cli]}, not Conduit`,
          outcome: entry.failed || row.exitedNonZero ? 'error' : 'ok',
          durationMs: row.durationMs,
          requestId: null,
          count: null,
        });
        return;
      }
      const note =
        'feed' in entry
          ? { action: 'feed-unavailable', summary: 'Feed unavailable' }
          : {
              action: 'feed-gap',
              summary: `Feed gap: ${entry.gap} ${entry.gap === 1 ? 'action' : 'actions'} not reported`,
            };
      noteRow(sessionId, cli, note.action, note.summary);
    },
    recordNote(note) {
      policyService.activity.record({
        lane: 'note',
        principal: { handle: note.handle, sessionId: null, machineId: note.machineId },
        cli: null,
        action: note.action,
        target: null,
        summary: null,
        decision: null,
        decidedBy: 'conduit',
        outcome: null,
        durationMs: null,
        requestId: null,
        count: null,
      });
    },

    networkPort: (): McpNetworkPort => ({
      localDirectory: () => directory(),
      callAsRemote,
      remoteRequests: () => remoteRequests,
      mirrorOf: () => requestService.mirrorOf(),
      requestsHasEnded: () => requestService.hasEnded(),
      onRequestsMirrorChange: (fn) => requestService.onMirrorChange(fn),
      remotePolicySink: () => remotePolicy,
      policyDoc: () => ({ ...policyService.remoteDoc(), grants: policyService.grantsView() }),
      onPolicyDocChange: (fn) => policyService.onRemoteDocChange(fn),
      // A pushed doc or a revoke can allow or deny an ask that waits on it, so the waiting asks are
      // re-decided at once, as refresh() does after a local change.
      applyRemotePolicy: (baseRev, doc, senderSupportsNative) => {
        const sessions = deps.sessions.list().flatMap(({ id }) => {
          const family = persistedLaunchedCli(id) ?? null;
          return isNativeFamily(family) ? [{ id, family }] : [];
        });
        const before = policyService.nativeLaunchSelections(sessions);
        const res = policyService.applyRemoteDoc(baseRev, doc, senderSupportsNative);
        if (res.ok) {
          const after = policyService.nativeLaunchSelections(sessions);
          const changed = sessions.flatMap(({ id }) => {
            const previous = before.get(id);
            const next = after.get(id);
            return previous && next && JSON.stringify(previous) !== JSON.stringify(next)
              ? [{ sessionId: id, before: previous, after: next }]
              : [];
          });
          nativeImpact = changed.length
            ? { id: randomBytes(16).toString('hex'), rows: changed }
            : null;
          scheduleBroadcast();
          flow.recheck();
        }
        return res;
      },
      revokeRemoteGrant: (grantId) => {
        const res = policyService.revokeGrantByRemote(grantId);
        flow.recheck();
        return res;
      },
      applyRemoteAnswer: (requestId, answer, answerId, machineId) =>
        requestService.applyRemoteAnswer(requestId, answer, answerId, machineId),
      hasMessage: (id) => store.has(id),
      readBlob: (sha256) => store.readBlob(sha256),
      // A thread is exported to a machine once a message in it went there (to its recipient) or
      // came from there; only then may the machine know the thread by a wire id (CON-27 B1).
      threadExportedTo: (threadId, machineId) =>
        store
          .thread(threadId)
          .some((m) => m.origin === machineId || m.to.some((h) => h.endsWith(`@${machineId}`))),
      wireThreadFor: (threadId, machineId) =>
        store.thread(threadId).find((m) => m.origin === machineId && m.originThreadId !== undefined)
          ?.originThreadId ?? threadId,
      deliverInbound,
      setRemoteStatus: async (messageId, address, status) => {
        // 'queued' is the state a remote recipient starts in, so there is nothing to record.
        if (status === 'queued') return;
        const r = await store.setStatus(messageId, address, status, 'remote');
        if (!r.ok) {
          // A peer can name a message we never sent as often as it likes, so this is not a warning.
          if (r.error.code === 'not_found') {
            deps.log.debug('conduit-mcp', 'remote status for unknown recipient', { messageId });
            return;
          }
          deps.log.warn('conduit-mcp', 'remote status not stored', {
            messageId,
            code: r.error.code,
          });
          throw new Error(r.error.message);
        }
      },
      // The store reports which recipient moved; only origin records are of interest here.
      onLocalStatus: (listener) =>
        store.onChange((change) => {
          if (change === undefined) return;
          if (change.status !== 'noticed' && change.status !== 'read') return;
          const record = store.get(change.messageId);
          if (record?.origin === undefined) return;
          listener(
            record.originMessageId ?? change.messageId,
            change.handle,
            change.status,
            record.origin,
          );
        }),
      youUnread: () => uiState().youUnread,
      ownerPresence: () => requestService.presence().state,
      requestsSummary: () =>
        requestService.ui().open.map((r) => ({
          requestId: r.id,
          type: r.kind,
          summary: r.title.slice(0, 200),
          sessionHandle: r.requester === 'conduit' ? null : r.requester,
          createdAt: r.createdAt,
        })),
    }),

    async stop() {
      stopped = true;
      startupWatches.clear();
      for (const sessionId of [...observedBudget.keys()]) forgetBudget(sessionId);
      stopRuntime();
      settleEndpoint();
      if (tickTimer) clearInterval(tickTimer);
      if (retentionTimer) clearInterval(retentionTimer);
      if (broadcastTimer) clearTimeout(broadcastTimer);
      broadcastTimer = undefined;
      for (const sessionId of lateEchoWatchers.keys()) cancelLateEcho(sessionId);
      stopAttentionWatch?.();
      stopGrantEligibilityWatch?.();
      stopNetworkWatch?.();
      sessionWaits.dispose();
      flow.dispose();
      for (const c of conns.values()) c.close();
      notices.dispose();
      await requestService.stop();
      pendingRemotePermissions.clear();
      await policyService.stop();
      const storeStopped = store.stop();
      await endpoint?.close();
      await startupSweep;
      await storeStopped;
    },
  };
}
