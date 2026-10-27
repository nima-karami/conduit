// Renderer aggregates for the Messages tab, card badges and the attention chip. Imports only
// node-free modules (./types, ./install-types), so the renderer never reaches a node-backed one
// (plan ruling 8).
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
