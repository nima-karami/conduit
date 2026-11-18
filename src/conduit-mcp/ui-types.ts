// Renderer aggregates for the Messages tab, card badges and the attention chip. Imports are
// type-only, from node-free modules (./types, ./install-types, ../git-range, ../protocol), so the
// renderer never reaches a node-backed one (plan ruling 8). The ../protocol ↔ ui-types cycle is
// type-only and erased at build.
import type { NativeSelection, NativeSessionUi } from '../contracts/native-launch';
import type { RemoteGrantView, RemotePolicyPoint } from '../contracts/remote-policy';
import type { RefEndpoint } from '../git-range';
import type { ParsedPatchFile } from '../patch-parse';
import type { CommitNode } from '../protocol';
import type { AgentCli, UserInstallState } from './install-types';
import type { Assignment, PolicyUiState, Profile, ProfileId } from './policy-types';
import type { RequestsUiState } from './request-types';
import type {
  GateClosedReason,
  Handle,
  McpAttentionItem,
  McpUnavailableReason,
  Result,
  SendMessageOutput,
  StoredMessage,
  ThreadSummary,
} from './types';

export type McpGateState = 'open' | 'pull-only' | GateClosedReason;

export type AskAnswer = 'approve' | 'deny' | 'always';
export type AskClosedOutcome = 'expired' | 'cancelled' | 'answered';
/** Placeholder values for the card's per-tool summary template (MCP_STR.ask.summary). */
export type AskSummary =
  | {
      tool: 'open_session';
      path: string;
      agent: string;
      focus: boolean;
      /** The machine a routed call runs on, when it is not this one (CON-40 S3). */
      machine?: string;
      /** A bare command on PATH: the absolute path that will run. */
      command?: string;
      model?: string;
      /** Characters in the first message, when one is given. */
      message?: number;
    }
  | {
      tool: 'open_terminal';
      path: string;
      command: string;
      focus: boolean;
      /** The machine a routed call runs on, when it is not this one (CON-40 S3). */
      machine?: string;
    }
  | { tool: 'open_file'; path: string; line: number | null }
  | { tool: 'close_session'; target: Handle }
  /** Several sessions: the first names (at most 8) of `total`. */
  | { tool: 'close_session'; targets: Handle[]; total: number }
  | { tool: 'focus_session'; target: Handle }
  | { tool: 'read_screen'; target: Handle }
  | {
      tool: 'send_input';
      target: Handle;
      label: string;
      home: string;
      text: string;
      keys: string[];
    }
  | { tool: 'attach_folder'; path: string; target: Handle }
  | { tool: 'close_files'; count: number; all: boolean }
  /** 'working', a short sha, or 'base…head'. */
  | { tool: 'open_review'; what: string }
  | { tool: 'open_diff'; title: string; path?: string }
  | { tool: 'open_git_history'; ref: string | null }
  | { tool: 'open_url'; url: string }
  | { tool: 'list_agents' }
  | { tool: 'list_machines' }
  /** newMachine: the target was never added, so connecting installs Conduit on it (RS-D6). */
  | { tool: 'connect_machine'; machine: string; newMachine: boolean }
  | { tool: 'disconnect_machine'; machine: string };

/** Structurally webview ReviewScope. */
export type McpReviewScope = 'all' | 'staged' | 'unstaged';
/** Assignable to webview/docs.ts ReviewSource; repoRoot is always set by the host. */
export type McpReviewSource =
  | { kind: 'working'; scope: McpReviewScope; repoRoot: string }
  | { kind: 'commit'; sha: string; subject: string; repoRoot: string }
  | { kind: 'range'; base: RefEndpoint; head: RefEndpoint; repoRoot: string }
  | { kind: 'patch'; files: ParsedPatchFile[]; title?: string; handle?: string };

/** Host → renderer UI request (spec 2026-10-30-conduit-mcp-app-control §2.3). */
export type McpUiAction =
  | { kind: 'closeSession'; target: string }
  | { kind: 'closeFiles'; paths: string[] | 'all' }
  | { kind: 'openReview'; source: McpReviewSource; focus?: boolean }
  | { kind: 'openGitHistory'; repoRoot: string; commit: CommitNode | null }
  | { kind: 'openUrl'; url: string; focus: boolean };

export const MAX_CLOSE_RESULTS = 500;
/** A closeSession refusal names at most this many unsaved paths. */
export const MAX_UNSAVED_PATHS = 20;
export const MAX_UI_FAILURE_CHARS = 500;
export interface CloseFilesOutcome {
  closed: string[];
  skipped: { path: string; reason: 'unsaved' | 'not_open' }[];
  /** closed + skipped hit MAX_CLOSE_RESULTS; later entries weren't recorded (their tabs still closed). */
  truncated?: true;
}
export type McpUiResult =
  | { kind: 'closeSession'; ok: true }
  /** At most MAX_UNSAVED_PATHS paths. */
  | { kind: 'closeSession'; ok: false; unsaved: string[] }
  | ({ kind: 'closeFiles' } & CloseFilesOutcome)
  /** openReview | openGitHistory | openUrl. */
  | { kind: 'opened' }
  /** The session isn't in this window. */
  | { kind: 'unknownSession' }
  /** The renderer threw mid-action; at most MAX_UI_FAILURE_CHARS, naming the step. */
  | { kind: 'failed'; message: string };

export interface McpSessionBadge {
  handle: Handle;
  unread: number;
  urgent: number;
  paused: boolean;
  unavailable: McpUnavailableReason | null;
  connected: boolean;
  /** Why notices are held, shown on the card (ruling 4); null when messaging is unavailable. */
  gate: McpGateState | null;
}

export interface McpThreadSummary extends ThreadSummary {
  paused: boolean;
  unreadForYou: boolean;
}

export interface McpThreadMessage extends StoredMessage {
  attachmentsExpired: boolean;
}

export interface McpThreadView {
  threadId: string;
  paused: boolean;
  messages: McpThreadMessage[];
}

/** A machine's rules as this machine holds them: its mirror, or its draft over it (CON-46 L4). */
export type RemotePolicyEdit =
  | { kind: 'assignment'; point: RemotePolicyPoint; assignment: Assignment | null }
  | { kind: 'profile'; profile: Profile }
  | { kind: 'delete-profile'; profileId: ProfileId; replacement: ProfileId };

export type RemotePolicyStatus = 'applied' | 'pushing' | 'waiting' | 'conflict' | 'refused';

export interface RemotePolicyUi {
  machineId: string;
  /** The name the machine is shown by. */
  name: string;
  link: 'up' | 'down' | 'gone';
  /** B's rev as last mirrored; null when no copy is held (link gone, or never received). */
  rev: number | null;
  status: RemotePolicyStatus;
  nativeSupport: boolean;
  nativeReviewRequired: boolean;
  /** B's message when it refused the push; null otherwise. */
  refusal: string | null;
  /** The rules the owner sees: the draft over the mirror, else the mirror. */
  policy: PolicyUiState;
  /** Current receiver rules available for conflict or native launch review. */
  conflict: PolicyUiState | null;
  grants: RemoteGrantView[];
}

interface McpPolicyUi extends PolicyUiState {
  /** Every machine with a mirror or a draft, in the order the store holds them. */
  machines: RemotePolicyUi[];
}

export function emptyPolicyUi(): McpPolicyUi {
  return {
    editToken: '',
    saveError: null,
    backupWarning: null,
    profiles: [],
    assignments: [],
    sessions: {},
    grants: [],
    legacy: { global: {}, byCli: {}, sessions: {} },
    readOnly: false,
    machines: [],
  };
}

export interface McpUiState {
  native: Record<string, NativeSessionUi>;
  nativeImpact: {
    id: string;
    total: number;
    rows: Array<{ sessionId: string; before: NativeSelection; after: NativeSelection }>;
  } | null;
  enabled: boolean;
  storeError: string | null;
  loading: boolean;
  /** By sessionId. */
  sessions: Record<string, McpSessionBadge>;
  /** Newest 500. */
  threads: McpThreadSummary[];
  attention: McpAttentionItem[];
  youUnread: number;
  youUrgent: number;
  /** Exact unread-message counts and participants, including threads beyond the visible 500. */
  youUnreadByThread: Array<{ participants: Handle[]; count: number }>;
  /** Session ids whose effective definition has an MCP adapter, or that have a handle: they get the MCP tools… item (spec 2026-10-27-conduit-mcp-control-tools §4). */
  switchable: string[];
  /** By sessionId; {} while messaging is off. */
  notConnected: Record<string, McpNotConnected>;
  /** Caller session ids with at least one waiting ask (spec 2026-10-30-conduit-mcp-tool-policy §2.4, caller side). */
  awaitingApproval: string[];
  /** How many tool-policy asks are waiting right now (the tray counts each). */
  waitingAsks: number;
  requests: RequestsUiState;
  policy: McpPolicyUi;
}

/** A session where an agent CLI was started but never reached this host (spec 2026-10-27-conduit-mcp-install §2.5). */
export interface McpNotConnected {
  cli: AgentCli;
  /** The user install state read when this was raised, and on onInstallChanged. */
  install: UserInstallState;
  /** Host launch counter of that session; the banner's once-per-PTY-generation key. */
  launch: number;
  reason: 'no-initialize' | 'cursor-not-connected';
}

export type McpSendResult = Result<SendMessageOutput>;

export interface McpAttachmentPayload {
  name: string;
  mime: string;
  bytes: number;
  base64: string;
}
