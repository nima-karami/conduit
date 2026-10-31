// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolicySource } from '../../src/conduit-mcp/tool-policy';
import type { HostToWebview } from '../../src/protocol';

const bridge = vi.hoisted(() => ({
  listeners: [] as ((m: HostToWebview) => void)[],
  post: vi.fn(),
}));
vi.mock('../../webview/bridge', () => ({
  subscribe: (cb: (m: HostToWebview) => void) => {
    bridge.listeners.push(cb);
    return () => {};
  },
  post: bridge.post,
}));

type Card = typeof import('../../webview/components/approval-card');
type Store = typeof import('../../webview/mcp-ask-store');
let card: Card;
let store: Store;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  vi.resetModules();
  bridge.listeners.length = 0;
  bridge.post.mockReset();
  store = await import('../../webview/mcp-ask-store');
  card = await import('../../webview/components/approval-card');
});

let root: Root | null = null;
let host: HTMLDivElement;
afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  host?.remove();
  document.body.innerHTML = '';
});

function emit(m: HostToWebview): void {
  act(() => {
    for (const l of bridge.listeners) l(m);
  });
}

function ask(askId: string, p: { handle?: string; source?: PolicySource } = {}): HostToWebview {
  return {
    type: 'mcp:ask',
    askId,
    callerSessionId: `s-${askId}`,
    callerHandle: p.handle ?? 'fake-1',
    tool: 'open_session',
    summary: { tool: 'open_session', path: `/w/${askId}`, agent: 'claude', focus: true },
    args: { path: `/w/${askId}`, agent: 'claude' },
    source: p.source ?? 'cli',
  };
}

function mount(announce = vi.fn()): typeof announce {
  host = document.createElement('div');
  document.body.appendChild(host);
  const r = createRoot(host);
  root = r;
  act(() => r.render(<card.ApprovalCard announce={announce} />));
  return announce;
}

const region = () => document.querySelector<HTMLElement>('.askcard');
const rawToggle = () => document.querySelector<HTMLButtonElement>('.askcard button[aria-expanded]');
const rawArgs = () => document.querySelector('.askcard pre.askcard__args');
const button = (answer: string) =>
  document.querySelector<HTMLButtonElement>(`.askcard button[data-answer="${answer}"]`);

describe('ApprovalCard', () => {
  it('renders nothing with no asks', () => {
    mount();
    expect(region()).toBeNull();
  });

  it('renders title, summary and reason', () => {
    mount();
    emit(ask('a1'));
    const r = region();
    expect(r?.getAttribute('role')).toBe('region');
    expect(r?.getAttribute('aria-label')).toBe('Agent request');
    expect(r?.parentElement).toBe(document.body);
    expect(r?.textContent).toContain('fake-1 requests open_session');
    expect(r?.textContent).toContain('Open a claude session in /w/a1');
    expect(r?.textContent).toContain('Ask: set for Other');
    expect(
      [...(r?.querySelectorAll('button[data-answer]') ?? [])].map((b) => b.textContent),
    ).toEqual(['Deny', 'Approve', 'Always for this session']);
    expect(r?.textContent).not.toContain('1 of');
  });

  it('raw arguments start collapsed, expand on the button, and collapse again per ask', () => {
    mount();
    emit(ask('a1'));
    emit(ask('a2', { handle: 'codex-2' }));
    expect(rawToggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(rawToggle()?.textContent).toBe('Arguments');
    expect(rawArgs()).toBeNull();
    act(() => rawToggle()?.click());
    expect(rawToggle()?.getAttribute('aria-expanded')).toBe('true');
    const shown = rawArgs();
    expect(shown?.textContent).toBe(JSON.stringify({ path: '/w/a1', agent: 'claude' }, null, 2));
    expect(rawToggle()?.getAttribute('aria-controls')).toBe(shown?.parentElement?.id);
    act(() =>
      document
        .querySelector<HTMLButtonElement>('.askcard button[aria-label="Next request"]')
        ?.click(),
    );
    expect(rawToggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(rawArgs()).toBeNull();
    act(() => rawToggle()?.click());
    expect(rawArgs()?.textContent).toContain('/w/a2');
    act(() => rawToggle()?.click());
    expect(rawArgs()).toBeNull();
  });

  it('names the session and global layers in the reason', () => {
    mount();
    emit(ask('a1', { source: 'session' }));
    expect(region()?.textContent).toContain('Ask: set for this session');
    act(() => store.answerAsk('a1', 'deny'));
    emit(ask('a2', { source: 'global', handle: 'codex-2' }));
    expect(region()?.textContent).toContain('Ask: the default for all CLIs');
  });

  it('does not take focus on arrival', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    mount();
    emit(ask('a1'));
    expect(document.activeElement).toBe(outside);
  });

  it.each(['approve', 'deny', 'always'] as const)(
    '%s calls answerAsk with that answer',
    (answer) => {
      mount();
      emit(ask('a1'));
      act(() => button(answer)?.click());
      expect(bridge.post).toHaveBeenCalledWith({ type: 'mcp:askAnswer', askId: 'a1', answer });
      expect(region()).toBeNull();
    },
  );

  it('pager 1 of 2 → next', () => {
    mount();
    emit(ask('a1'));
    emit(ask('a2', { handle: 'codex-2' }));
    expect(region()?.textContent).toContain('1 of 2');
    expect(region()?.textContent).toContain('fake-1 requests open_session');
    act(() =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Next request"]')?.click(),
    );
    expect(region()?.textContent).toContain('2 of 2');
    expect(region()?.textContent).toContain('codex-2 requests open_session');
    act(() => button('approve')?.click());
    expect(bridge.post).toHaveBeenCalledWith({
      type: 'mcp:askAnswer',
      askId: 'a2',
      answer: 'approve',
    });
    // The index clamps to the one left, and the pager goes away.
    expect(region()?.textContent).toContain('fake-1 requests open_session');
    expect(region()?.textContent).not.toContain('of 1');
  });

  it('focuses the region on a focus request and Esc returns focus without answering', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    mount();
    emit(ask('a1'));
    act(() => store.requestAskFocus());
    expect(document.activeElement).toBe(region());
    act(() => {
      region()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.activeElement).toBe(outside);
    expect(bridge.post).not.toHaveBeenCalled();
    expect(region()).not.toBeNull();
  });

  it('announces each new ask once', () => {
    const announce = mount();
    emit(ask('a1'));
    emit(ask('a2', { handle: 'codex-2' }));
    act(() => store.answerAsk('a1', 'deny'));
    expect(announce.mock.calls).toEqual([
      ['fake-1 requests open_session'],
      ['codex-2 requests open_session'],
    ]);
  });
});
