// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview } from '../../src/protocol';
import type { AgentScopeView, Session } from '../../src/types';

const hostReplies: Array<(m: unknown) => void> = [];
const sent: unknown[] = [];
vi.mock('../../webview/host-request', () => ({
  requestHost: vi.fn((send: (id: number) => unknown) => {
    sent.push(send(7));
    return new Promise((resolve) => hostReplies.push(resolve));
  }),
}));
vi.mock('../../webview/terminal-bus', () => ({ requestTerminalFocus: vi.fn() }));
vi.mock('../../webview/toast-store', () => ({ pushToast: vi.fn() }));
vi.mock('../../webview/bridge', () => ({ post: vi.fn() }));

import { post } from '../../webview/bridge';
import { AgentScopeBanner } from '../../webview/components/agent-scope-banner';
import { requestTerminalFocus } from '../../webview/terminal-bus';
import { pushToast } from '../../webview/toast-store';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLDivElement;

const scope = (o: Partial<AgentScopeView> = {}): AgentScopeView => ({
  unseen: ['C:\\w\\D with space'],
  stillSeen: [],
  typeable: ['C:\\w\\D with space'],
  ...o,
});

function session(o: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 's',
    agentId: 'claude',
    home: 'C:\\w\\h',
    roots: ['C:\\w\\D with space'],
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
    agentScope: scope(),
    ...o,
  };
}

async function render(s: Session) {
  if (!root) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root?.render(createElement(AgentScopeBanner, { session: s })));
}

const button = (label: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent === label,
  );
const click = async (el: Element | undefined) => {
  await act(async () => {
    (el as HTMLElement).click();
  });
};
const reply = async (m: Partial<Extract<HostToWebview, { type: 'agentScope:result' }>>) => {
  await act(async () => {
    hostReplies.shift()?.({ type: 'agentScope:result', requestId: 7, sessionId: 's1', ...m });
  });
};

beforeEach(() => {
  hostReplies.length = 0;
  sent.length = 0;
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('AgentScopeBanner', () => {
  it('renders nothing without agentScope', async () => {
    await render(session({ agentScope: undefined }));
    expect(host.innerHTML).toBe('');
  });

  it('shows the message, the full paths as title, and the three controls', async () => {
    await render(session());
    const msg = host.querySelector('.scope-banner__msg');
    expect(msg?.textContent).toBe("claude can't see D with space yet");
    expect(msg?.getAttribute('title')).toBe('C:\\w\\D with space');
    expect(host.querySelector('.scope-banner__name')?.getAttribute('dir')).toBe('ltr');
    expect(button('Run /add-dir')?.className).toBe('btn btn--warn');
    expect(button('Restart claude')?.className).toBe('btn');
    expect(host.querySelector('.scope-banner__close')?.getAttribute('aria-label')).toBe('Dismiss');
  });

  it('busy disables Run /add-dir with the busy title', async () => {
    await render(session({ busy: true }));
    const run = button('Run /add-dir');
    expect(run?.disabled).toBe(true);
    expect(run?.title).toBe("claude is working — try again when it's idle");
    expect(button('Restart claude')?.disabled).toBe(false);
  });

  it('Run posts addDirsToAgent BEFORE focusing the terminal; disabled while sending', async () => {
    await render(session());
    await click(button('Run /add-dir'));
    expect(sent).toEqual([{ type: 'session:addDirsToAgent', sessionId: 's1', requestId: 7 }]);
    // The focus change makes claude print; it must not land before the host's busy check
    // (QA F1).
    expect(requestTerminalFocus).not.toHaveBeenCalled();
    expect(button('Run /add-dir')?.disabled).toBe(true);
    expect(button('Run /add-dir')?.title).toBe('');
    await click(button('Run /add-dir'));
    expect(sent).toHaveLength(1);
    await reply({ ok: true });
    expect(requestTerminalFocus).toHaveBeenCalledWith('s1');
    expect(button('Run /add-dir')?.disabled).toBe(false);
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('a pasted folder reads "Press Enter in claude to add …"', async () => {
    await render(session({ agentScope: scope({ pasted: 'C:\\w\\D with space' }) }));
    const msg = host.querySelector('.scope-banner__msg');
    expect(msg?.textContent).toBe('Press Enter in claude to add D with space');
    expect(msg?.getAttribute('title')).toBe('C:\\w\\D with space');
  });

  it('busy result → busy toast; a silent reason → no toast', async () => {
    await render(session());
    await click(button('Run /add-dir'));
    await reply({ ok: false, reason: 'busy' });
    expect(pushToast).toHaveBeenCalledWith({
      message: "claude is working — try again when it's idle",
      variant: 'error',
    });
    vi.mocked(pushToast).mockClear();
    await click(button('Run /add-dir'));
    await reply({ ok: false, reason: 'nothingPending' });
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('first Restart click shows the confirm and focuses Cancel', async () => {
    await render(session());
    await click(button('Restart claude'));
    expect(host.querySelector('.scope-banner__msg')?.textContent).toBe(
      'Restart claude? This conversation ends.',
    );
    expect(button('Restart')?.className).toBe('btn btn--warn');
    expect(document.activeElement).toBe(button('Cancel'));
    expect(button('Run /add-dir')).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('Esc in the banner cancels and focuses Restart claude', async () => {
    await render(session());
    await click(button('Restart claude'));
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const outer = vi.fn();
    document.body.addEventListener('keydown', outer);
    await act(async () => {
      button('Cancel')?.dispatchEvent(esc);
    });
    document.body.removeEventListener('keydown', outer);
    expect(outer).not.toHaveBeenCalled();
    expect(host.querySelector('.scope-banner__msg')?.textContent).toBe(
      "claude can't see D with space yet",
    );
    expect(document.activeElement).toBe(button('Restart claude'));
  });

  it('Esc outside the confirm is left alone', async () => {
    await render(session());
    const outer = vi.fn();
    document.body.addEventListener('keydown', outer);
    await act(async () => {
      button('Run /add-dir')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    document.body.removeEventListener('keydown', outer);
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('Cancel click restores the banner', async () => {
    await render(session());
    await click(button('Restart claude'));
    await click(button('Cancel'));
    expect(button('Run /add-dir')).toBeDefined();
    expect(document.activeElement).toBe(button('Restart claude'));
  });

  it('confirm posts session:restart once, then refocuses the terminal', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    await render(session());
    await click(button('Restart claude'));
    await click(button('Restart'));
    expect(sent).toEqual([{ type: 'session:restart', sessionId: 's1', requestId: 7 }]);
    expect(button('Restart')?.disabled).toBe(true);
    await click(button('Restart'));
    expect(sent).toHaveLength(1);
    await reply({ ok: true });
    expect(requestTerminalFocus).toHaveBeenCalledWith('s1');
    raf.mockRestore();
  });

  it('× posts dismissAgentScope', async () => {
    await render(session());
    await click(host.querySelector('.scope-banner__close') ?? undefined);
    expect(post).toHaveBeenCalledWith({ type: 'session:dismissAgentScope', sessionId: 's1' });
  });

  it('only the message element is role=status', async () => {
    await render(session({ agentScope: scope({ stillSeen: ['C:\\w\\old'] }) }));
    const live = host.querySelectorAll('[role="status"]');
    expect(live).toHaveLength(1);
    expect(live[0].className).toBe('scope-banner__msg');
    expect(live[0].getAttribute('aria-live')).toBe('polite');
    expect(host.querySelector('.scope-banner__second')?.textContent).toBe(
      'It can still see old until it restarts.',
    );
  });

  it('stillSeen only → Restart claude is the primary and there is no Run', async () => {
    await render(session({ agentScope: scope({ unseen: [], typeable: [], stillSeen: ['/o'] }) }));
    expect(button('Run /add-dir')).toBeUndefined();
    expect(button('Restart claude')?.className).toBe('btn btn--warn');
  });

  it('a banner that disappears mid-confirm comes back ready', async () => {
    await render(session());
    await click(button('Restart claude'));
    await render(session({ agentScope: undefined }));
    await render(session());
    expect(button('Run /add-dir')).toBeDefined();
  });
});
