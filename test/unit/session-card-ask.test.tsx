// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types';
import { SessionCard } from '../../webview/components/session-card';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const session: Session = {
  id: 's1',
  name: 'api fix',
  agentId: 'claude',
  home: '/w/api',
  roots: [],
  status: 'running',
  createdAt: 1,
  lastActiveAt: 1,
};

let root: Root | null = null;
let host: HTMLDivElement;
afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  host?.remove();
});

function mount(p: { awaitingApproval?: boolean; editing?: boolean } = {}) {
  const onSelect = vi.fn();
  const onFocusAsk = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  const r = createRoot(host);
  root = r;
  act(() =>
    r.render(
      <SessionCard
        session={session}
        agentLabel="claude"
        resolvedIcon={{ type: 'kind', kind: 'claude' }}
        active={false}
        onSelect={onSelect}
        onKill={() => {}}
        onRename={() => {}}
        onRelaunch={() => {}}
        onSnooze={() => {}}
        editing={p.editing ?? false}
        onEditStart={() => {}}
        onEditEnd={() => {}}
        roles={{ title: 'name', subtitle: 'agent', detail: 'none' }}
        awaitingApproval={p.awaitingApproval}
        onFocusAsk={onFocusAsk}
      />,
    ),
  );
  return { onSelect, onFocusAsk };
}

const askButton = () => host.querySelector<HTMLButtonElement>('button.session__ask');

describe('SessionCard ask badge', () => {
  it('shows only while awaiting', () => {
    mount({ awaitingApproval: true });
    expect(askButton()?.textContent).toBe('Waiting for your approval');
    expect(askButton()?.type).toBe('button');
  });

  it('is absent when not awaiting or while renaming', () => {
    mount();
    expect(askButton()).toBeNull();
    act(() => root?.unmount());
    root = null;
    host.remove();
    mount({ awaitingApproval: true, editing: true });
    expect(askButton()).toBeNull();
  });

  it('click calls onFocusAsk and does not select the session', () => {
    const { onSelect, onFocusAsk } = mount({ awaitingApproval: true });
    act(() => askButton()?.click());
    expect(onFocusAsk).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
