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
