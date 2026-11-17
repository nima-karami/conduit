// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AnswerInput, RequestAnswerResult } from '../../src/conduit-mcp/request-types';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';

const bridge = vi.hoisted(() => ({
  listeners: [] as ((m: HostToWebview) => void)[],
  post: vi.fn<(msg: WebviewToHost) => void>(),
}));
vi.mock('../../webview/bridge', () => ({
  subscribe: (cb: (m: HostToWebview) => void) => {
    bridge.listeners.push(cb);
    return () => {
      bridge.listeners = bridge.listeners.filter((l) => l !== cb);
    };
  },
  post: bridge.post,
}));

import { type ConduitMcpApi, useConduitMcp } from '../../webview/use-conduit-mcp';

const emit = (m: HostToWebview) => {
  for (const l of [...bridge.listeners]) l(m);
};

const answer: AnswerInput = { outcome: 'approved' };
const notAnswered: RequestAnswerResult = {
  ok: false,
  reason: 'not_found',
  message: 'Conduit did not answer; try again',
  request: null,
};
const otherResult: RequestAnswerResult = {
  ok: false,
  reason: 'already_ended',
  message: 'someone else',
  request: null,
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.useRealTimers();
  bridge.post.mockReset();
});

async function mountApi(): Promise<ConduitMcpApi> {
  let captured: ConduitMcpApi | null = null;
  function Probe() {
    captured = useConduitMcp();
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => {
    root.render(createElement(Probe));
  });
  if (!captured) throw new Error('probe did not render');
  return captured;
}

describe('answerPermission', () => {
  it('a permission answer that gets no reply settles not_answerable', async () => {
    const api = await mountApi();
    const baseline = bridge.listeners.length;
    vi.useFakeTimers();
    const p = api.answerPermission('perm-1', { outcome: 'denied' });
    expect(bridge.listeners.length).toBe(baseline + 1);
    vi.advanceTimersByTime(10_000);
    await expect(p).resolves.toMatchObject({ ok: false, reason: 'not_answerable' });
    expect(bridge.listeners.length).toBe(baseline);
  });

  it('a peer refusal keeps its reason, so the card can say why', async () => {
    const api = await mountApi();
    const p = api.answerPermission('perm-2', { outcome: 'allowed' });
    emit({
      type: 'mcp:permissionResult',
      requestId: 'perm-2',
      ok: false,
      reason: 'peer_revoked',
      message: 'the link was removed',
    });
    await expect(p).resolves.toMatchObject({ ok: false, reason: 'peer_revoked' });
  });
});

describe('answerRequest', () => {
  it('answerRequest resolves with the matching mcp:requestResult and ignores other ids', async () => {
    const api = await mountApi();
    const baseline = bridge.listeners.length;
    let settled = false;
    const p = api.answerRequest('req-1', answer).then((r) => {
      settled = true;
      return r;
    });

    expect(bridge.post).toHaveBeenCalledWith({
      type: 'mcp:requestAnswer',
      requestId: 'req-1',
      answer,
    });

    emit({ type: 'mcp:requestResult', requestId: 'req-2', result: otherResult });
    await Promise.resolve();
    expect(settled).toBe(false);

    emit({ type: 'mcp:requestResult', requestId: 'req-1', result: notAnswered });
    await expect(p).resolves.toEqual(notAnswered);
    expect(bridge.listeners.length).toBe(baseline);
  });

  it('answerRequest times out without leaving a listener', async () => {
    const api = await mountApi();
    const baseline = bridge.listeners.length;
    vi.useFakeTimers();
    const p = api.answerRequest('req-1', answer);
    expect(bridge.listeners.length).toBe(baseline + 1);

    vi.advanceTimersByTime(10_000);
    await expect(p).resolves.toEqual(notAnswered);
    expect(bridge.listeners.length).toBe(baseline);
  });
});

describe('setAway', () => {
  it('setAway posts mcp:setAway', async () => {
    const api = await mountApi();
    api.setAway(true, '2026-11-15T09:00:00.000Z');
    expect(bridge.post).toHaveBeenCalledWith({
      type: 'mcp:setAway',
      away: true,
      until: '2026-11-15T09:00:00.000Z',
    });
  });
});

describe('acknowledged remote policy edits', () => {
  it('correlates remoteEdit typed results and passes the selected owner token', async () => {
    const api = await mountApi();
    expect(typeof api.remoteEdit).toBe('function');
    const edit = {
      kind: 'assignment' as const,
      point: { kind: 'default' as const },
      assignment: { profileId: 'lead' as const, exceptions: [], onScreenOnly: false },
    };
    let settled = false;
    const pending = api.remoteEdit('m-1', 'owner-token', edit).then((result) => {
      settled = true;
      return result;
    });
    const request = bridge.post.mock.calls.at(-1)?.[0];
    if (request?.type !== 'mcp:remoteEdit') throw new Error('missing full edit');
    expect(request).toMatchObject({ machine: 'm-1', expectedToken: 'owner-token', edit });
    emit({ type: 'mcp:policyEditResult', requestId: request.requestId + 1, result: { ok: true } });
    await Promise.resolve();
    expect(settled).toBe(false);
    emit({
      type: 'mcp:policyEditResult',
      requestId: request.requestId,
      result: { ok: false, error: 'save-failed' },
    });
    await expect(pending).resolves.toEqual({ ok: false, error: 'save-failed' });
  });
  it('remotePolicy returns conflict and nullable timeout instead of unacknowledged success', async () => {
    const api = await mountApi();
    const first = api.remotePolicy('m-1', 'discard', 'owner-token');
    expect(first).toBeInstanceOf(Promise);
    const request = bridge.post.mock.calls.at(-1)?.[0];
    if (request?.type !== 'mcp:remotePolicy') throw new Error('missing acknowledged action');
    expect(request).toMatchObject({
      machine: 'm-1',
      action: 'discard',
      expectedToken: 'owner-token',
    });
    emit({
      type: 'mcp:policyEditResult',
      requestId: request.requestId,
      result: { ok: false, error: 'conflict' },
    });
    await expect(first).resolves.toEqual({ ok: false, error: 'conflict' });
    vi.useFakeTimers();
    const baseline = bridge.listeners.length;
    const second = api.remotePolicy('m-1', 'retry-save', 'owner-token');
    vi.advanceTimersByTime(10_000);
    await expect(second).resolves.toBeNull();
    expect(bridge.listeners.length).toBe(baseline);
  });
});
