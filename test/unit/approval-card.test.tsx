// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolicySource } from '../../src/conduit-mcp/tool-policy';
import type { AskSummary } from '../../src/conduit-mcp/ui-types';
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
const terminals = vi.hoisted(() => ({ focus: vi.fn() }));
vi.mock('../../webview/terminal-bus', () => ({ requestTerminalFocus: terminals.focus }));

type Card = typeof import('../../webview/components/approval-card');
type Store = typeof import('../../webview/mcp-ask-store');
let card: Card;
let store: Store;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

/** Animation frames run only when a test flushes them. */
let frames: FrameRequestCallback[] = [];
/** Date.now, moved only by the test (the swap guard reads it). */
const clock = {
  t: 1_000_000,
  advance(ms: number) {
    clock.t += ms;
  },
};
const flushFrames = () =>
  act(() => {
    for (const f of frames.splice(0)) f(0);
  });

beforeEach(async () => {
  frames = [];
  clock.t = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.t);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames[id - 1] = () => undefined;
  });
  vi.resetModules();
  bridge.listeners.length = 0;
  bridge.post.mockReset();
  terminals.focus.mockReset();
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function emit(m: HostToWebview): void {
  act(() => {
    for (const l of bridge.listeners) l(m);
  });
}

type AskMsg = Extract<HostToWebview, { type: 'mcp:ask' }>;
function ask(askId: string, p: { handle?: string; source?: PolicySource } = {}): AskMsg {
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
const next = () =>
  act(() =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Next request"]')?.click(),
  );
const closed = (askId: string) => emit({ type: 'mcp:askClosed', askId, outcome: 'expired' });
const shownHandle = () => region()?.querySelector('.askcard__title')?.textContent;
/** A real press: mousedown (click count `detail`) then click, on the button there now. */
const press = (answer: string, detail = 1) =>
  act(() => {
    const b = button(answer);
    b?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail }));
    b?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
  });
/** Enter on the focused element: its keydown, and the click a browser makes of it on a button. */
const pressEnter = () =>
  act(() => {
    const el = document.activeElement;
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    if (el instanceof HTMLButtonElement) el.click();
  });
const answered = () => bridge.post.mock.calls.map(([m]) => (m as { askId: string }).askId);

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

  it('summarises each app-control tool', () => {
    const cases: [AskSummary, string][] = [
      [{ tool: 'close_session', target: 'fake-2' }, 'Close fake-2'],
      [{ tool: 'focus_session', target: 'fake-2' }, 'Switch your view to fake-2'],
      [{ tool: 'attach_folder', path: '/w/sub', target: 'fake-1' }, 'Attach /w/sub to fake-1'],
      [{ tool: 'close_files', count: 3, all: false }, 'Close 3 tabs'],
      [{ tool: 'close_files', count: 1, all: false }, 'Close 1 tab'],
      [{ tool: 'close_files', count: 0, all: true }, 'Close all of its tabs'],
      [{ tool: 'open_review', what: 'v1…feature' }, 'Open Review for v1…feature'],
      [{ tool: 'open_git_history', ref: null }, 'Open the commit history'],
      [{ tool: 'open_git_history', ref: 'main' }, 'Open the commit history at main'],
      [{ tool: 'open_url', url: 'http://x/' }, 'Open http://x/ in a Conduit tab'],
    ];
    mount();
    cases.forEach(([summary, text], i) => {
      emit({ ...ask(`b${i}`), tool: summary.tool, summary });
      expect(document.querySelector('.askcard__summary')?.textContent).toBe(text);
      closed(`b${i}`);
    });
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

  it('announces each new ask once, clearing the region first and saying N of M', () => {
    const announce = mount();
    emit(ask('a1'));
    expect(announce.mock.calls).toEqual([['']]);
    flushFrames();
    emit(ask('a2', { handle: 'codex-2' }));
    flushFrames();
    act(() => store.answerAsk('a1', 'deny'));
    flushFrames();
    expect(announce.mock.calls).toEqual([
      [''],
      ['fake-1 requests open_session, 1 of 1'],
      [''],
      ['codex-2 requests open_session, 2 of 2'],
    ]);
  });

  it('an identical repeat is announced again', () => {
    const announce = mount();
    emit(ask('a1'));
    flushFrames();
    act(() => store.answerAsk('a1', 'deny'));
    emit(ask('a2'));
    flushFrames();
    expect(announce.mock.calls).toEqual([
      [''],
      ['fake-1 requests open_session, 1 of 1'],
      [''],
      ['fake-1 requests open_session, 1 of 1'],
    ]);
  });

  describe('the shown ask is pinned by id (review r1-S2 C1)', () => {
    it('an arrival after paging keeps the shown ask', () => {
      mount();
      emit(ask('a1'));
      emit(ask('a2', { handle: 'codex-2' }));
      next();
      emit(ask('a3', { handle: 'cursor-3' }));
      expect(shownHandle()).toBe('codex-2 requests open_session');
      expect(region()?.textContent).toContain('2 of 3');
    });

    it('an older ask closing while on page 2 keeps the shown ask', () => {
      mount();
      emit(ask('a1'));
      emit(ask('a2', { handle: 'codex-2' }));
      emit(ask('a3', { handle: 'cursor-3' }));
      next();
      closed('a1');
      expect(shownHandle()).toBe('codex-2 requests open_session');
      expect(region()?.textContent).toContain('1 of 2');
      press('approve');
      expect(answered()).toEqual(['a2']);
    });

    it('when the shown ask closes, the oldest remaining shows', () => {
      mount();
      emit(ask('a1'));
      emit(ask('a2', { handle: 'codex-2' }));
      emit(ask('a3', { handle: 'cursor-3' }));
      next();
      closed('a2');
      expect(shownHandle()).toBe('fake-1 requests open_session');
    });
  });

  describe('a swap the user did not cause guards the buttons for 400 ms (review r1-S3 D1)', () => {
    it('two clicks → exactly one answer', () => {
      mount();
      emit(ask('a1'));
      emit(ask('a2', { handle: 'codex-2' }));
      act(() => button('approve')?.click());
      act(() => button('approve')?.click());
      expect(answered()).toEqual(['a1']);
      expect(shownHandle()).toBe('codex-2 requests open_session');
    });

    it('a double-click answers only the first', () => {
      mount();
      emit(ask('a1'));
      emit(ask('a2', { handle: 'codex-2' }));
      press('approve', 1);
      clock.advance(150);
      press('approve', 2);
      expect(answered()).toEqual(['a1']);
    });

    it('Enter twice → one answer; focus moves to the region', () => {
      mount();
      emit(ask('a1'));
      emit(ask('a2', { handle: 'codex-2' }));
      act(() => button('approve')?.focus());
      pressEnter();
      expect(document.activeElement).toBe(region());
      pressEnter();
      expect(answered()).toEqual(['a1']);
    });

    it('a bare click on the next ask after the guard answers it (screen-reader browse mode)', () => {
      mount();
      emit(ask('a1'));
      emit(ask('a2', { handle: 'codex-2' }));
      act(() => button('approve')?.click());
      clock.advance(400);
      act(() => button('deny')?.click());
      expect(bridge.post.mock.calls.map(([m]) => m)).toEqual([
        { type: 'mcp:askAnswer', askId: 'a1', answer: 'approve' },
        { type: 'mcp:askAnswer', askId: 'a2', answer: 'deny' },
      ]);
    });

    it('a click within 400 ms of the shown ask expiring is ignored', () => {
      mount();
      emit(ask('a1'));
      emit(ask('a2', { handle: 'codex-2' }));
      closed('a1');
      clock.advance(399);
      press('approve');
      expect(answered()).toEqual([]);
      clock.advance(1);
      press('approve');
      expect(answered()).toEqual(['a2']);
    });

    it('paging is not a swap: a click right after it answers', () => {
      mount();
      emit(ask('a1'));
      emit(ask('a2', { handle: 'codex-2' }));
      next();
      press('approve');
      expect(answered()).toEqual(['a2']);
    });

    it('the first ask to appear is not a swap', () => {
      mount();
      emit(ask('a1'));
      press('approve');
      expect(answered()).toEqual(['a1']);
    });
  });

  it('answering the last ask from inside the card returns focus (review r1-S2 C7)', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    mount();
    emit(ask('a1'));
    act(() => store.requestAskFocus());
    act(() => button('approve')?.focus());
    press('approve');
    expect(region()).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("with nowhere to return to, the last answer lands in the caller's terminal (QA)", () => {
    const textarea = document.createElement('textarea');
    textarea.className = 'xterm-helper-textarea';
    document.body.appendChild(textarea);
    terminals.focus.mockImplementation(() => textarea.focus());
    mount();
    emit(ask('a1'));
    // Tabbed in, not sent by the chip: nothing recorded to go back to.
    act(() => button('deny')?.focus());
    pressEnter();
    expect(region()).toBeNull();
    expect(terminals.focus).toHaveBeenCalledWith('s-a1');
    expect(document.activeElement).toBe(textarea);
  });

  it('a focus request from nowhere (body) also returns to the terminal', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    terminals.focus.mockImplementation(() => textarea.focus());
    mount();
    emit(ask('a1'));
    act(() => store.requestAskFocus());
    act(() => button('approve')?.focus());
    pressEnter();
    expect(terminals.focus).toHaveBeenCalledWith('s-a1');
    expect(document.activeElement).toBe(textarea);
  });
});
