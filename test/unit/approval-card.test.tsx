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
const owner = vi.hoisted(() => ({ loaded: true }));
vi.mock('../../webview/use-owner-permissions', () => {
  return {
    useOwnerPermissions: (_api: unknown, asks: AskMsg[]) => ({
      error: false,
      retry: vi.fn(),
      rows: asks
        .map((ask) =>
          owner.loaded
            ? {
                id: ask.askId,
                sessionId: ask.callerSessionId,
                requester: ask.callerHandle,
                space: null,
                lead: null,
                machine: 'local',
                title: 'Permission',
                tool: ask.tool,
                why: 'Worker',
                state: 'open',
                createdAt: new Date(0).toISOString(),
                expiresAt: null,
                endedAt: null,
                withdrawReason: null,
                grantable: ask.grantable,
                answerable: true,
                choices: ask.grantable
                  ? [{ who: 'session', on: 'target', for: 'session-end' }]
                  : [],
              }
            : null,
        )
        .filter(Boolean),
    }),
  };
});
vi.mock('../../webview/use-conduit-mcp', () => ({
  useConduitMcp: () => ({
    getOwnerPermissions: vi.fn(),
    answerPermission: async (requestId: string, answer: unknown) => {
      bridge.post({ type: 'mcp:permissionAnswer', requestId, answer });
      for (const listener of bridge.listeners)
        listener({ type: 'mcp:askClosed', askId: requestId, outcome: 'answered' });
      return { ok: true };
    },
  }),
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
  owner.loaded = true;
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function emit(m: HostToWebview): void {
  act(() => {
    for (const l of bridge.listeners) l(m);
  });
}

type AskMsg = Extract<HostToWebview, { type: 'mcp:ask' }>;
function ask(
  askId: string,
  p: { handle?: string; source?: PolicySource; grantable?: boolean } = {},
): AskMsg {
  return {
    type: 'mcp:ask',
    grantable: p.grantable ?? true,
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
const button = (answer: string) => {
  const label = answer === 'deny' ? 'Deny' : answer === 'always' ? 'Allow' : 'Allow once';
  return [...document.querySelectorAll<HTMLButtonElement>('.askcard button')].find(
    (b) => b.textContent === label,
  );
};
const openAnswer = (answer: string) => {
  const label = answer === 'deny' ? 'Deny ▾' : answer === 'always' ? 'Allow…' : null;
  if (label)
    act(() =>
      [...document.querySelectorAll<HTMLButtonElement>('.askcard button')]
        .find((b) => b.textContent === label)
        ?.click(),
    );
};
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
const answerPosts = () =>
  bridge.post.mock.calls.map(([m]) => m).filter((m) => m.type === 'mcp:permissionAnswer');
const answered = () => answerPosts().map((m) => (m as { requestId: string }).requestId);

describe('ApprovalCard', () => {
  it('offers no mutation while owner options are loading', () => {
    owner.loaded = false;
    mount();
    emit(ask('a1'));
    expect(region()?.textContent).toContain('Loading permission options');
    expect(region()?.textContent).not.toContain('Allow once');
    expect(answerPosts()).toEqual([]);
  });

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
    // In place, not portaled: the floating stack (<Toasts>) owns the portal and the anchor.
    expect(r?.parentElement).toBe(host);
    expect(r?.textContent).toContain('fake-1 requests open_session');
    expect(r?.textContent).toContain('Open a claude session in /w/a1');
    expect(r?.textContent).toContain('Ask: set for Other');
    expect(r?.textContent).toContain('Allow once');
    expect(r?.textContent).toContain('Allow…');
    expect(r?.textContent).not.toContain('1 of');
  });

  it('a forced ask offers Deny and Approve only: no Always', () => {
    mount();
    emit({ ...ask('a1'), grantable: false });
    expect(region()?.textContent).toContain('Allow once');
    expect(region()?.textContent).not.toContain('Allow…');
  });

  it('names the model and the first message length in the open_session summary', () => {
    mount();
    emit({
      ...ask('a1'),
      summary: {
        tool: 'open_session',
        path: '/w/a1',
        agent: 'codex',
        focus: true,
        model: 'gpt-6.1-terra',
        message: 5,
      },
    });
    expect(region()?.textContent).toContain(
      'Open a codex (model gpt-6.1-terra) session in /w/a1, with a first message (5 chars)',
    );
  });

  it('summarises each app-control tool', () => {
    const cases: [AskSummary, string][] = [
      [{ tool: 'close_session', target: 'fake-2' }, 'Close fake-2'],
      [{ tool: 'focus_session', target: 'fake-2' }, 'Switch your view to fake-2'],
      [{ tool: 'read_screen', target: 'fake-2' }, 'Read the screen of fake-2'],
      [
        {
          tool: 'send_input',
          target: 'fake-2',
          label: 'Kiro',
          home: '/work/kiro',
          text: 'continue',
          keys: [],
        },
        'Type into fake-2 (Kiro, /work/kiro)',
      ],
      [{ tool: 'attach_folder', path: '/w/sub', target: 'fake-1' }, 'Attach /w/sub to fake-1'],
      [{ tool: 'close_files', count: 3, all: false }, 'Close 3 tabs'],
      [{ tool: 'close_files', count: 1, all: false }, 'Close 1 tab'],
      [{ tool: 'close_files', count: 0, all: true }, 'Close all of its tabs'],
      [{ tool: 'open_review', what: 'v1…feature' }, 'Open Review for v1…feature'],
      [{ tool: 'open_diff', title: 'a.txt' }, 'Show a diff: a.txt'],
      [
        { tool: 'open_diff', title: '/home/main/changes.diff' },
        'Show a diff: /home/main/changes.diff',
      ],
      [
        { tool: 'open_diff', title: 'My diff', path: '/home/main/changes.diff' },
        'Show a diff: My diff (/home/main/changes.diff)',
      ],
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

  it('shows the full send_input text in a scrollable area and warns for ctrl+c', () => {
    mount();
    emit({
      ...ask('input'),
      tool: 'send_input',
      summary: {
        tool: 'send_input',
        target: 'kiro-1',
        label: 'Kiro',
        home: '/work/kiro',
        text: 'line one\nline two — full text',
        keys: ['enter', 'ctrl+c'],
      },
      args: {},
    });
    const text = document.querySelector<HTMLElement>('.askcard__inputtext');
    expect(text?.textContent).toBe('line one\nline two — full text');
    expect(text?.tagName).toBe('PRE');
    expect(region()?.textContent).toContain('Keys: enter, ctrl+c — may stop the program');
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
      openAnswer(answer);
      act(() => button(answer)?.click());
      expect(answered()).toEqual(['a1']);
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
    expect(answered()).toEqual(['a2']);
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
    expect(answerPosts()).toEqual([]);
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

    it('Enter twice → one answer; focus moves to the region', async () => {
      mount();
      emit(ask('a1'));
      emit(ask('a2', { handle: 'codex-2' }));
      act(() => button('approve')?.focus());
      pressEnter();
      await act(async () => undefined);
      expect(document.activeElement).toBe(region());
      pressEnter();
      expect(answered()).toEqual(['a1']);
    });

    it('a bare click on the next ask after the guard answers it (screen-reader browse mode)', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      mount();
      emit(ask('a1'));
      emit(ask('a2', { handle: 'codex-2' }));
      act(() => button('approve')?.click());
      clock.advance(400);
      act(() => vi.advanceTimersByTime(400));
      openAnswer('deny');
      act(() => button('deny')?.click());
      expect(answerPosts()).toEqual([
        { type: 'mcp:permissionAnswer', requestId: 'a1', answer: { outcome: 'allowed' } },
        { type: 'mcp:permissionAnswer', requestId: 'a2', answer: { outcome: 'denied' } },
      ]);
    });

    it('a click within 400 ms of the shown ask expiring is ignored', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      mount();
      emit(ask('a1'));
      emit(ask('a2', { handle: 'codex-2' }));
      closed('a1');
      clock.advance(399);
      press('approve');
      expect(answered()).toEqual([]);
      clock.advance(1);
      act(() => vi.advanceTimersByTime(400));
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

  it('the bottom-docked actions follow all variable-height content (QA L2)', () => {
    mount();
    emit(ask('a1'));
    emit(ask('a2', { handle: 'codex-2' }));
    const order = () => [...(region()?.children ?? [])].map((c) => c.className);
    const want = [
      'askcard__head',
      'askcard__summary',
      'askcard__reason',
      'askcard__raw',
      'permissions-request-body',
    ];
    expect(order()).toEqual(want);
    expect(region()?.querySelector('.askcard__head .askcard__pager')?.textContent).toContain(
      '1 of 2',
    );
    closed('a1');
    const pager = region()?.querySelector('.askcard__head .askcard__pager');
    expect(pager?.classList.contains('askcard__pager--idle')).toBe(true);
    expect(pager?.textContent).toBe('');
    expect(order()).toEqual(want);
  });

  it('disables answer controls during the swap guard', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mount();
    emit(ask('a1'));
    emit(ask('a2'));
    press('approve');
    expect(button('approve')?.disabled).toBe(true);
    act(() => {
      clock.advance(400);
      vi.advanceTimersByTime(400);
    });
    expect(button('approve')?.disabled).toBe(false);
  });

  it('answering the last ask from inside the card returns focus (review r1-S2 C7)', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    mount();
    emit(ask('a1'));
    act(() => store.requestAskFocus());
    act(() => button('approve')?.focus());
    press('approve');
    await act(async () => undefined);
    expect(region()).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("with nowhere to return to, the last answer lands in the caller's terminal (QA)", async () => {
    const textarea = document.createElement('textarea');
    textarea.className = 'xterm-helper-textarea';
    document.body.appendChild(textarea);
    terminals.focus.mockImplementation(() => textarea.focus());
    mount();
    emit(ask('a1'));
    // Tabbed in, not sent by the chip: nothing recorded to go back to.
    openAnswer('deny');
    act(() => button('deny')?.focus());
    pressEnter();
    await act(async () => undefined);
    expect(region()).toBeNull();
    expect(terminals.focus).toHaveBeenCalledWith('s-a1');
    expect(document.activeElement).toBe(textarea);
  });

  it('a focus request from nowhere (body) also returns to the terminal', async () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    terminals.focus.mockImplementation(() => textarea.focus());
    mount();
    emit(ask('a1'));
    act(() => store.requestAskFocus());
    act(() => button('approve')?.focus());
    pressEnter();
    await act(async () => undefined);
    expect(terminals.focus).toHaveBeenCalledWith('s-a1');
    expect(document.activeElement).toBe(textarea);
  });
});
