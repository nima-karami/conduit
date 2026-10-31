// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AttentionAsk } from '../../src/attention';
import type { Session } from '../../src/types';
import { TopBar } from '../../webview/components/top-bar';
import { MCP_STR } from '../../webview/conduit-mcp-strings';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  document.body.innerHTML = '';
});

const session = (id: string): Session => ({
  id,
  name: `S ${id}`,
  agentId: 'cli:claude',
  home: '/p',
  roots: [],
  status: 'running',
  createdAt: 1,
  lastActiveAt: 1,
});

function mount(asks: readonly AttentionAsk[]) {
  const spies = { onFocusAsk: vi.fn(), onFocusAttention: vi.fn() };
  const host = document.createElement('div');
  document.body.append(host);
  const r = createRoot(host);
  root = r;
  act(() =>
    r.render(
      <TopBar
        onOpenSearch={() => undefined}
        onBack={() => undefined}
        onForward={() => undefined}
        canBack={false}
        canForward={false}
        centerView="editor"
        onSelectView={() => undefined}
        sessions={[session('s1')]}
        onFocusAttention={spies.onFocusAttention}
        asks={asks}
        onFocusAsk={spies.onFocusAsk}
      />,
    ),
  );
  return spies;
}

const chip = () => document.querySelector<HTMLButtonElement>('.attnchip');

describe('TopBar chip with a waiting ask (tool-policy spec §2.4; review r1-S2 C5)', () => {
  it("names the asking handle and focuses the card, not the caller's session", () => {
    const spies = mount([{ askId: 'a1', callerSessionId: 's1', callerHandle: 'claude-1' }]);
    expect(chip()?.title).toBe(MCP_STR.ask.chipReason('claude-1'));
    expect(chip()?.textContent).toContain(MCP_STR.ask.chipReason('claude-1'));
    act(() => chip()?.click());
    expect(spies.onFocusAsk).toHaveBeenCalledTimes(1);
    expect(spies.onFocusAttention).not.toHaveBeenCalled();
  });

  it('no asks → no chip', () => {
    mount([]);
    expect(chip()).toBeNull();
  });
});
