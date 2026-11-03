// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgentRuntime, agentOwnState } from '../../src/sidebar-state';
import type { Session } from '../../src/types';
import { useAgentRuntime } from '../../webview/use-agent-runtime';

const session = (completions: number): Session => ({
  id: 's1',
  name: 's1',
  agentId: 'claude',
  home: '/w',
  roots: [],
  status: 'running',
  createdAt: 0,
  lastActiveAt: 0,
  attentionReason: null,
  completions,
});

let root: Root | null = null;
let host: HTMLDivElement;
let committed: Array<{ loaded: boolean; state: string }>;
const asks = new Set<string>();
let viewed = new Set<string>();

function Probe({ loaded, sessions }: { loaded: boolean; sessions: readonly Session[] }) {
  const runtime: AgentRuntime = useAgentRuntime({
    sessionsLoaded: loaded,
    sessions,
    askSessionIds: asks,
    viewedTerminalIds: viewed,
  });
  const state = sessions[0] ? agentOwnState(sessions[0], runtime.seen.s1 ?? 0, false) : 'idle';
  useLayoutEffect(() => {
    committed.push({ loaded, state });
  });
  return null;
}

beforeEach(() => {
  committed = [];
  viewed = new Set();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host.remove();
});

describe('useAgentRuntime', () => {
  it('does not commit Done when completion arrives in a strictly viewed terminal', () => {
    viewed = new Set(['s1']);
    act(() => root?.render(<Probe loaded sessions={[session(0)]} />));
    committed = [];
    act(() => root?.render(<Probe loaded sessions={[session(1)]} />));

    expect(committed.map((entry) => entry.state)).not.toContain('done');
    expect(committed.at(-1)?.state).toBe('idle');
  });

  it('shows Done for an unviewed completion and baselines only after sessions load', () => {
    act(() => root?.render(<Probe loaded={false} sessions={[session(5)]} />));
    committed = [];
    act(() => root?.render(<Probe loaded sessions={[session(5)]} />));

    expect(committed.map((entry) => entry.state)).not.toContain('done');
    expect(committed.at(-1)?.state).toBe('idle');

    act(() => root?.render(<Probe loaded sessions={[session(6)]} />));
    expect(committed.at(-1)?.state).toBe('done');
  });
});
