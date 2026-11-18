import { useMemo, useSyncExternalStore } from 'react';
import type { ActivityLookup } from '../src/conduit-mcp/activity-log';
import type { ActivityPage, ActivityQuery } from '../src/conduit-mcp/activity-query';
import type {
  Assignment,
  AssignmentPoint,
  GrantLifecycleResult,
  LocalPolicyEdit,
  LocalPolicyReviewResult,
  PermissionAnswer,
  PolicyEditResult,
  PreviewDraft,
  PreviewIntent,
  PreviewResult,
  Profile,
  ProfileId,
  ReplayResult,
} from '../src/conduit-mcp/policy-types';
import type {
  AnswerInput,
  AnswerRefusal,
  OwnerPermissionCursor,
  OwnerPermissionPage,
  PermissionAnswerResult,
  RequestAnswerResult,
  RequestsUiState,
} from '../src/conduit-mcp/request-types';
import type { ToolErrorCode } from '../src/conduit-mcp/types';
import type {
  McpAttachmentPayload,
  McpSendResult,
  McpThreadView,
  McpUiState,
  RemotePolicyEdit,
} from '../src/conduit-mcp/ui-types';
import type { CodexPostureView } from '../src/contracts/native-launch';
import type { WebviewToHost } from '../src/protocol';
import { post, subscribe } from './bridge';
import { requestHost } from './host-request';

const REQUEST_TIMEOUT_MS = 10_000;

const REFUSALS: readonly AnswerRefusal[] = [
  'not_found',
  'already_ended',
  'not_answerable',
  'invalid_answer',
  'peer_unreachable',
  'peer_incompatible',
  'peer_revoked',
];
const refusalOf = (reason: string | undefined): AnswerRefusal =>
  REFUSALS.find((r) => r === reason) ?? 'not_answerable';

export interface ConduitMcpApi {
  state: McpUiState | null;
  acknowledgeMigration(expectedToken: string): Promise<PolicyEditResult | null>;
  saveAssignment(
    point: AssignmentPoint,
    assignment: Assignment | null,
    expectedToken: string,
    nativeReview?: string,
  ): Promise<PolicyEditResult | null>;
  saveProfile(
    profile: Profile,
    expectedToken: string,
    nativeReview?: string,
  ): Promise<PolicyEditResult | null>;
  deleteProfile(
    profileId: ProfileId,
    replacement: ProfileId,
    expectedToken: string,
    nativeReview?: string,
  ): Promise<PolicyEditResult | null>;
  reviewLocalPolicy(
    edit: LocalPolicyEdit,
    expectedToken: string,
  ): Promise<LocalPolicyReviewResult | null>;
  retryPolicy(): Promise<PolicyEditResult | null>;
  getActivity(query: ActivityQuery): Promise<ActivityPage | null>;
  getActivityRow(id: string, at: string): Promise<ActivityLookup | null>;
  previewPolicy(
    sessionId: string,
    intent: PreviewIntent,
    draft: PreviewDraft | null,
    expectedToken: string,
  ): Promise<PreviewResult | null>;
  replayPolicy(draft: PreviewDraft, expectedToken: string): Promise<ReplayResult | null>;
  getOwnerPermissions(
    state: 'open' | 'closed',
    cursor?: OwnerPermissionCursor,
  ): Promise<OwnerPermissionPage | null>;
  linkCodexThread(
    sessionId: string,
    generation: number,
    threadId: string,
  ): Promise<CodexPostureView>;
  codexPostureQuery(sessionId: string, generation: number): Promise<CodexPostureView>;
  dismissNativeImpact(id: string): Promise<boolean>;
  grantLifecycle(
    operation: Extract<WebviewToHost, { type: 'mcp:grantLifecycle' }>['operation'],
  ): Promise<GrantLifecycleResult | null>;
  revokeGrant(grantId: string, machine?: string): Promise<boolean>;
  allowOnce(activityId: string, at: string): Promise<boolean>;
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
  remoteEdit(
    machine: string,
    expectedToken: string,
    edit: RemotePolicyEdit,
    nativeConsent?: boolean,
  ): Promise<PolicyEditResult | null>;
  remotePolicy(
    machine: string,
    action: 'discard' | 'reapply' | 'retry-save',
    expectedToken: string,
    nativeConsent?: boolean,
  ): Promise<PolicyEditResult | null>;
  answerRequest(requestId: string, answer: AnswerInput): Promise<RequestAnswerResult>;
  answerPermission(requestId: string, answer: PermissionAnswer): Promise<PermissionAnswerResult>;
  setAway(away: boolean, until: string | null): void;
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

/** Read by request-open.ts outside React, where the hook is not available. */
export function getRequestsSnapshot(): RequestsUiState | null {
  return snapshot?.requests ?? null;
}

const api: Omit<ConduitMcpApi, 'state'> = {
  async acknowledgeMigration(expectedToken) {
    const r = await requestHost(
      (requestId) => ({ type: 'mcp:acknowledgeMigration', requestId, expectedToken }),
      ['mcp:policyEditResult'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.result ?? null;
  },
  async saveAssignment(point, assignment, expectedToken, nativeReview) {
    const r = await requestHost(
      (requestId) => ({
        type: 'mcp:saveAssignment',
        requestId,
        point,
        assignment,
        expectedToken,
        ...(nativeReview === undefined ? {} : { nativeReview }),
      }),
      ['mcp:policyEditResult'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.result ?? null;
  },
  async saveProfile(profile, expectedToken, nativeReview) {
    const r = await requestHost(
      (requestId) => ({
        type: 'mcp:saveProfile',
        requestId,
        profile,
        expectedToken,
        ...(nativeReview === undefined ? {} : { nativeReview }),
      }),
      ['mcp:policyEditResult'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.result ?? null;
  },
  async deleteProfile(profileId, replacement, expectedToken, nativeReview) {
    const r = await requestHost(
      (requestId) => ({
        type: 'mcp:deleteProfile',
        requestId,
        profileId,
        replacement,
        expectedToken,
        ...(nativeReview === undefined ? {} : { nativeReview }),
      }),
      ['mcp:policyEditResult'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.result ?? null;
  },
  async reviewLocalPolicy(edit, expectedToken) {
    const r = await requestHost(
      (requestId) => ({ type: 'mcp:reviewLocalPolicy', requestId, expectedToken, edit }),
      ['mcp:reviewLocalPolicyResult'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.result ?? null;
  },
  async retryPolicy() {
    const r = await requestHost(
      (requestId) => ({ type: 'mcp:policyRetry', requestId }),
      ['mcp:policyEditResult'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.result ?? null;
  },
  async linkCodexThread(sessionId, generation, threadId) {
    const r = await requestHost(
      (requestId) => ({ type: 'mcp:linkCodexThread', requestId, sessionId, generation, threadId }),
      ['mcp:codexPostureResult'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.sessionId === sessionId && r.generation === generation
      ? r.view
      : { status: 'unavailable' };
  },
  async codexPostureQuery(sessionId, generation) {
    const r = await requestHost(
      (requestId) => ({ type: 'mcp:codexPostureQuery', requestId, sessionId, generation }),
      ['mcp:codexPostureResult'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.sessionId === sessionId && r.generation === generation
      ? r.view
      : { status: 'unavailable' };
  },
  async getOwnerPermissions(state, cursor) {
    const r = await requestHost(
      (requestId) => ({
        type: 'mcp:ownerPermissions:get',
        requestId,
        state,
        ...(cursor ? { cursor } : {}),
      }),
      ['mcp:ownerPermissions'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.page ?? null;
  },
  async dismissNativeImpact(id) {
    const r = await requestHost(
      (requestId) => ({ type: 'mcp:dismissNativeImpact', requestId, id }),
      ['mcp:dismissNativeImpactResult'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.dismissed ?? false;
  },
  async grantLifecycle(operation) {
    const r = await requestHost(
      (requestId) => ({ type: 'mcp:grantLifecycle', requestId, operation }),
      ['mcp:grantLifecycleResult'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.result ?? null;
  },
  async previewPolicy(sessionId, intent, draft, expectedToken) {
    const r = await requestHost(
      (requestId) => ({ type: 'mcp:preview', requestId, sessionId, intent, draft, expectedToken }),
      ['mcp:previewResult'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.result ?? null;
  },
  async replayPolicy(draft, expectedToken) {
    const r = await requestHost(
      (requestId) => ({ type: 'mcp:replay', requestId, draft, expectedToken }),
      ['mcp:replayResult'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.result ?? null;
  },
  async getActivityRow(id, at) {
    const response = await requestHost(
      (requestId) => ({ type: 'mcp:activity:lookup', requestId, id, at }),
      ['mcp:activity:row'],
      10_000,
    );
    return response?.result ?? null;
  },
  async getActivity(query) {
    const r = await requestHost(
      (requestId) => ({ type: 'mcp:activity:get', requestId, query }),
      ['mcp:activity'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.page ?? null;
  },
  async revokeGrant(grantId, machine) {
    const r = await requestHost(
      (requestId) => ({ type: 'mcp:revokeGrant', requestId, grantId, machine }),
      ['mcp:policyResult'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.ok === true;
  },
  async allowOnce(activityId, at) {
    const r = await requestHost(
      (requestId) => ({ type: 'mcp:allowOnce', requestId, activityId, at }),
      ['mcp:policyResult'],
      REQUEST_TIMEOUT_MS,
    );
    return r?.ok === true;
  },
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
  async remoteEdit(machine, expectedToken, edit, nativeConsent) {
    const result = await requestHost(
      (requestId) => ({
        type: 'mcp:remoteEdit',
        requestId,
        machine,
        expectedToken,
        edit,
        ...(nativeConsent === undefined ? {} : { nativeConsent }),
      }),
      ['mcp:policyEditResult'],
      REQUEST_TIMEOUT_MS,
    );
    return result?.result ?? null;
  },
  async remotePolicy(machine, action, expectedToken, nativeConsent) {
    const result = await requestHost(
      (requestId) => ({
        type: 'mcp:remotePolicy',
        requestId,
        machine,
        action,
        expectedToken,
        ...(nativeConsent === undefined ? {} : { nativeConsent }),
      }),
      ['mcp:policyEditResult'],
      REQUEST_TIMEOUT_MS,
    );
    return result?.result ?? null;
  },
  answerRequest(requestId, answer) {
    // Not requestHost: it correlates by the numeric id it mints, and this reply carries the
    // request's own id.
    return new Promise((resolve) => {
      const settle = (result: RequestAnswerResult) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(result);
      };
      const unsubscribe = subscribe((m) => {
        if (m.type === 'mcp:requestResult' && m.requestId === requestId) settle(m.result);
      });
      // Armed before post so a reply that lands synchronously still finds both handles set.
      const timer = setTimeout(
        () =>
          settle({
            ok: false,
            reason: 'not_found',
            message: 'Conduit did not answer; try again',
            request: null,
          }),
        REQUEST_TIMEOUT_MS,
      );
      post({ type: 'mcp:requestAnswer', requestId, answer });
    });
  },
  answerPermission(requestId, answer) {
    return new Promise((resolve) => {
      const settle = (result: PermissionAnswerResult) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(result);
      };
      const unsubscribe = subscribe((m) => {
        if (m.type !== 'mcp:permissionResult' || m.requestId !== requestId) return;
        settle(
          m.ok
            ? { ok: true }
            : {
                ok: false,
                reason: refusalOf(m.reason),
                message: m.message ?? 'Conduit refused the answer',
              },
        );
      });
      const timer = setTimeout(
        () =>
          settle({
            ok: false,
            reason: 'not_answerable',
            message: 'Conduit did not answer; try again',
          }),
        REQUEST_TIMEOUT_MS,
      );
      post({ type: 'mcp:permissionAnswer', requestId, answer });
    });
  },
  setAway(away, until) {
    post({ type: 'mcp:setAway', away, until });
  },
};

export function useConduitMcp(): ConduitMcpApi {
  const state = useSyncExternalStore(subscribeState, getState, getState);
  return useMemo(() => ({ ...api, state }), [state]);
}
