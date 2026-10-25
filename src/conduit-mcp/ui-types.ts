// Renderer aggregates for the Messages tab, card badges and the attention chip. Imports only
// ./types, so the renderer never reaches a node-backed module (plan ruling 8).
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
}

export type McpSendResult = Result<SendMessageOutput>;

export interface McpAttachmentPayload {
  name: string;
  mime: string;
  bytes: number;
  base64: string;
}
