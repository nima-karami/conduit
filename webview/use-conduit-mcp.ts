import { useMemo, useSyncExternalStore } from 'react';
import type { ToolName, ToolOverrideValue } from '../src/conduit-mcp/tool-switches';
import type { ToolErrorCode } from '../src/conduit-mcp/types';
import type {
  McpAttachmentPayload,
  McpSendResult,
  McpThreadView,
  McpUiState,
} from '../src/conduit-mcp/ui-types';
import type { WebviewToHost } from '../src/protocol';
import { post, subscribe } from './bridge';
import { requestHost } from './host-request';

const REQUEST_TIMEOUT_MS = 10_000;

export interface ConduitMcpApi {
  state: McpUiState | null;
  getThread(threadId: string): Promise<McpThreadView | null>;
  send(
    req: Omit<Extract<WebviewToHost, { type: 'mcp:compose' }>, 'type' | 'requestId'>,
  ): Promise<McpSendResult | null>;
  getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<McpAttachmentPayload | ToolErrorCode | null>;
  markRead(ids: string[]): void;
  allowMore(threadId: string): void;
  pause(sessionId: string, paused: boolean): void;
  retry(): void;
  /** False when the host refused it or didn't answer: the caller reverts. */
  setToolOverride(sessionId: string, tool: ToolName, value: ToolOverrideValue): Promise<boolean>;
}

// A module singleton, like timer-store.ts: the host answers `ready` once, possibly before any
// component has mounted, so the subscription can't wait for one.
let snapshot: McpUiState | null = null;
const listeners = new Set<() => void>();
subscribe((m) => {
  if (m.type !== 'mcp:state') return;
  snapshot = m.state;
  listeners.forEach((l) => {
    l();
  });
});
const subscribeState = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const getState = () => snapshot;

const api: Omit<ConduitMcpApi, 'state'> = {
  async getThread(threadId) {
    const r = await requestHost(
      (requestId) => ({ type: 'mcp:thread:get', requestId, threadId }),
      ['mcp:thread'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.thread ?? null;
  },
  async send(req) {
    const r = await requestHost(
      (requestId) => ({ type: 'mcp:compose', requestId, ...req }),
      ['mcp:sent'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.result ?? null;
  },
  async getAttachment(messageId, attachmentId) {
    const r = await requestHost(
      (requestId) => ({ type: 'mcp:attachment:get', requestId, messageId, attachmentId }),
      ['mcp:attachment'],
      REQUEST_TIMEOUT_MS,
    );
    if (!r) return null;
    return r.result.ok ? r.result.value : r.result.error;
  },
  markRead(ids) {
    if (ids.length > 0) post({ type: 'mcp:markRead', messageIds: ids });
  },
  allowMore(threadId) {
    post({ type: 'mcp:allowMore', threadId });
  },
  pause(sessionId, paused) {
    post({ type: 'mcp:pause', sessionId, paused });
  },
  retry() {
    post({ type: 'mcp:retry' });
  },
  async setToolOverride(sessionId, tool, value) {
    const r = await requestHost(
      (requestId) => ({ type: 'mcp:setToolOverride', requestId, sessionId, tool, value }),
      ['mcp:toolOverrideResult'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.ok === true;
  },
};

export function useConduitMcp(): ConduitMcpApi {
  const state = useSyncExternalStore(subscribeState, getState, getState);
  return useMemo(() => ({ ...api, state }), [state]);
}
