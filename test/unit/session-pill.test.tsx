// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestView } from '../../src/conduit-mcp/request-types';
import { SessionPill } from '../../webview/components/session-pill';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const MIN = 60_000;

function req(over: Partial<RequestView> = {}): RequestView {
  return {
    id: 'r1',
    origin: 'srv',
    source: 'agent',
    kind: 'confirm',
    requester: 'codex-4',
    session: 's1',
    space: 'sp1',
    lead: null,
    machine: 'laptop',
    title: 'Run tests?',
    body: '',
    options: [],
    multi: false,
    draft: null,
    thread: null,
    messageId: null,
    blocked: null,
    priority: 'normal',
    createdAt: iso(NOW - 5 * MIN),
    expiresAt: null,
    default: null,
    contentKey: 'k',
    state: 'open',
    endedAt: null,
    answer: null,
    withdrawnBy: null,
    withdrawReason: null,
    supersededBy: null,
    deliveredAt: null,
    waiting: false,
    waitingUntil: null,
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root;
const onOpen = vi.fn();

const render = (requests: RequestView[], sessionId = 's1') =>
  act(() =>
    root.render(
      <SessionPill sessionId={sessionId} requests={requests} now={NOW} onOpen={onOpen} />,
    ),
  );
const click = (el: Element) => act(() => (el as HTMLElement).click());
const press = (el: Element, key: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
const trigger = () => host.querySelector<HTMLElement>('button');
const menu = () => host.querySelector<HTMLElement>('[role="menu"]');
const items = () => Array.from(host.querySelectorAll<HTMLElement>('[role="menuitem"]'));

beforeEach(() => {
  onOpen.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('SessionPill', () => {
  it('hidden with no request for this session', () => {
    render([req({ id: 'r1', session: 's2' })]);
    expect(trigger()).toBeNull();
    expect(host.textContent).toBe('');
  });

  it('one request opens it on click', () => {
    render([req({ id: 'r1' })]);
    expect(trigger()?.textContent).toBe('1 request');
    click(trigger() as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith('r1');
    expect(menu()).toBeNull();
  });

  it('a waiting request shows the countdown', () => {
    render([req({ id: 'r1', waiting: true, waitingUntil: iso(NOW + 46_000) })]);
    expect(trigger()?.textContent).toBe('◉ Waiting on you · 0:46');
  });

  it('several requests open a menu; choosing one opens it', () => {
    render([
      req({ id: 'calm', title: 'Pick a branch' }),
      req({ id: 'hot', title: 'Approve deploy', waiting: true, waitingUntil: iso(NOW + 10_000) }),
    ]);
    expect(trigger()?.textContent).toBe('◉ Waiting on you · 0:10 · 2 requests');
    expect(trigger()?.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false');

    click(trigger() as HTMLElement);
    expect(trigger()?.getAttribute('aria-expanded')).toBe('true');
    expect(menu()).not.toBeNull();
    expect(items().map((el) => el.textContent?.includes('Approve deploy'))).toEqual([true, false]);
    expect(items()[1]?.textContent).toContain('Pick a branch');

    click(items()[1] as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith('calm');
    expect(menu()).toBeNull();
  });

  it('Esc closes the menu and returns focus to the pill', () => {
    render([req({ id: 'a' }), req({ id: 'b', title: 'Second' })]);
    click(trigger() as HTMLElement);
    expect(document.activeElement).toBe(items()[0]);

    press(items()[0] as HTMLElement, 'Escape');
    expect(menu()).toBeNull();
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("only this session's requests count", () => {
    render(
      [
        req({ id: 'other-1', session: 's2', waiting: true, waitingUntil: iso(NOW + 5_000) }),
        req({ id: 'other-2', session: 's2' }),
        req({ id: 'mine', session: 's1' }),
      ],
      's1',
    );
    expect(trigger()?.textContent).toBe('1 request');
    click(trigger() as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith('mine');
  });
});
