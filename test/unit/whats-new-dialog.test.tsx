// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WhatsNewDialog } from '../../webview/components/whats-new-dialog';

const { openExternal, post } = vi.hoisted(() => ({ openExternal: vi.fn(), post: vi.fn() }));
vi.mock('../../webview/bridge', () => ({ openExternal, post }));
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.useRealTimers();
});
function render({
  currentVersion,
  ready = false,
  notes = '### Added\n- Useful feature',
}: {
  currentVersion?: string;
  ready?: boolean;
  notes?: string;
} = {}) {
  if (!root) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  const close = vi.fn();
  act(() =>
    root?.render(
      <WhatsNewDialog
        release={{ version: '2.0.0', notes, currentVersion }}
        ready={ready}
        onClose={close}
      />,
    ),
  );
  return close;
}
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label);

describe("What's new dialog", () => {
  it('does not fetch remote images until the user chooses to load them', () => {
    render({ notes: '![Release screenshot](https://example.com/screen.png)' });
    expect(document.querySelector('.whats-new__body img')).toBeNull();
    act(() => button('Load image from example.com — Release screenshot')?.click());
    expect(document.querySelector('.whats-new__body img')?.getAttribute('src')).toBe(
      'https://example.com/screen.png',
    );
    render({
      notes: '<img src="https://other.example/track.gif" onerror="alert(1)" alt="Remote">',
    });
    expect(document.querySelector('.whats-new__body img')).toBeNull();
    expect(button('Load image from other.example — Remote')).toBeDefined();
  });
  it('incoming notes have a labelled, portalled dialog, current version and ready-only relaunch', () => {
    render({ currentVersion: '1.0.0', ready: true });
    const dialog = document.querySelector('[role="dialog"]');
    expect(
      document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '')?.textContent,
    ).toBe("What's new in v2.0.0");
    expect(dialog?.parentElement?.parentElement).toBe(document.body);
    expect(dialog?.textContent).toContain('you have v1.0.0');
    expect(dialog?.querySelector('h3')?.textContent).toBe('Added');
    act(() => button('Relaunch to update')?.click());
    expect(post).toHaveBeenCalledWith({ type: 'updateRelaunch' });
    render({ currentVersion: '1.0.0', ready: false });
    expect(button('Relaunch to update')).toBeUndefined();
  });
  it('installed notes omit the current-version line and Relaunch even if an update is ready', () => {
    render({ ready: true });
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('you have');
    expect(button('Relaunch to update')).toBeUndefined();
  });
  it('opens the release and markdown links through the existing external path', () => {
    render({ notes: '[Details](https://example.com/notes)' });
    const links = [...document.querySelectorAll('a')];
    for (const a of links) {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      act(() => a.dispatchEvent(click));
      expect(click.defaultPrevented).toBe(true);
    }
    expect(openExternal).toHaveBeenCalledWith('https://example.com/notes');
    expect(openExternal).toHaveBeenCalledWith(
      'https://github.com/nima-karami/conduit/releases/tag/v2.0.0',
    );
    const middle = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true });
    act(() => links[0]?.dispatchEvent(middle));
    expect(middle.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenLastCalledWith('https://example.com/notes');
  });
  it('Later and Escape close and restore focus to the opener', () => {
    vi.useFakeTimers();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const close = render();
    expect(document.activeElement?.textContent).toBe('Later');
    act(() => button('Later')?.click());
    act(() => vi.advanceTimersToNextFrame());
    expect(close).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    act(() => vi.advanceTimersToNextFrame());
    expect(close).toHaveBeenCalledTimes(2);
  });
  it('traps Tab within the dialog', () => {
    render({ currentVersion: '1.0.0', ready: true });
    const first = document.querySelector<HTMLAnchorElement>('a');
    act(() => button('Relaunch to update')?.focus());
    act(() =>
      button('Relaunch to update')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      ),
    );
    expect(document.activeElement).toBe(first);
    act(() =>
      first?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.activeElement).toBe(button('Relaunch to update'));
  });
  it('uses the markdown viewer HTML guard for scripts, event handlers and javascript links', () => {
    render({
      notes:
        '<script>window.pwned=true</script>\n<img src="bad" onerror="window.pwned=true">\n<a href="javascript:alert(1)">unsafe</a>\n\n**Safe**',
    });
    const body = document.querySelector('.whats-new__body');
    expect(body?.querySelector('script')).toBeNull();
    expect(body?.querySelector('[onerror]')).toBeNull();
    expect(body?.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(body?.querySelector('strong')?.textContent).toBe('Safe');
    act(() => body?.querySelector('a')?.click());
    expect(openExternal).not.toHaveBeenCalled();
  });
});
