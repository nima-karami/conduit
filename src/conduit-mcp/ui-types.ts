// Renderer aggregates for the Messages tab, card badges and the attention chip. Imports are
// type-only, from node-free modules (./types, ./install-types, ../git-range, ../protocol), so the
// renderer never reaches a node-backed one (plan ruling 8). The ../protocol ↔ ui-types cycle is
// type-only and erased at build.
import type { RefEndpoint } from '../git-range';
import type { CommitNode } from '../protocol';
import type { AgentCli, UserInstallState } from './install-types';
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
export type AskClosedOutcome = 'expired' | 'cancelled';
/** Placeholder values for the card's per-tool summary template (MCP_STR.ask.summary). */
export type AskSummary =
  | { tool: 'open_session'; path: string; agent: string; focus: boolean }
  | { tool: 'open_terminal'; path: string; command: string; focus: boolean }
  | { tool: 'open_file'; path: string; line: number | null }
  | { tool: 'close_session'; target: Handle }
  | { tool: 'focus_session'; target: Handle }
  | { tool: 'attach_folder'; path: string; target: Handle }
  | { tool: 'close_files'; count: number; all: boolean }
  /** 'working', a short sha, or 'base…head'. */
  | { tool: 'open_review'; what: string }
  | { tool: 'open_git_history'; ref: string | null }
  | { tool: 'open_url'; url: string };

/** Structurally webview ReviewScope. */
export type McpReviewScope = 'all' | 'staged' | 'unstaged';
/** Assignable to webview/docs.ts ReviewSource; repoRoot is always set by the host. */
export type McpReviewSource =
  | { kind: 'working'; scope: McpReviewScope; repoRoot: string }
  | { kind: 'commit'; sha: string; subject: string; repoRoot: string }
  | { kind: 'range'; base: RefEndpoint; head: RefEndpoint; repoRoot: string };

/** Host → renderer UI request (spec 2026-10-30-conduit-mcp-app-control §2.3). */
export type McpUiAction =
  | { kind: 'closeSession'; target: string }
  | { kind: 'closeFiles'; paths: string[] | 'all' }
  | { kind: 'openReview'; source: McpReviewSource }
  | { kind: 'openGitHistory'; repoRoot: string; commit: CommitNode | null }
  | { kind: 'openUrl'; url: string; focus: boolean };

export const MAX_CLOSE_RESULTS = 500;
export interface CloseFilesOutcome {
  closed: string[];
  skipped: { path: string; reason: 'unsaved' | 'not_open' }[];
  /** closed + skipped hit MAX_CLOSE_RESULTS; later entries weren't recorded (their tabs still closed). */
  truncated?: true;
}
export type McpUiResult =
  | { kind: 'closeSession'; ok: true }
  /** At most 20 paths. */
  | { kind: 'closeSession'; ok: false; unsaved: string[] }
  | ({ kind: 'closeFiles' } & CloseFilesOutcome)
  /** openReview | openGitHistory | openUrl. */
  | { kind: 'opened' }
  /** The session isn't in this window. */
  | { kind: 'unknownSession' };

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

export interface McpUiState {
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
  /** Session ids whose effective definition has an MCP adapter, or that have a handle: they get the MCP tools… item (spec 2026-10-27-conduit-mcp-control-tools §4). */
  switchable: string[];
  /** By sessionId; {} while messaging is off. */
  notConnected: Record<string, McpNotConnected>;
  /** Caller session ids with at least one waiting ask (spec 2026-10-30-conduit-mcp-tool-policy §2.4, caller side). */
  awaitingApproval: string[];
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
