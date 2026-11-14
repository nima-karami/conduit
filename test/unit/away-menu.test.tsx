// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HumanPresence } from '../../src/conduit-mcp/request-types';
import { AwayMenu } from '../../webview/components/away-menu';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const HERE: HumanPresence = {
  state: 'here',
  since: '2026-11-14T00:00:00.000Z',
  until: null,
  lastAway: null,
};
const AWAY: HumanPresence = { ...HERE, state: 'away', until: null };
const NOW = new Date(2026, 10, 14, 10, 20).getTime();

let host: HTMLDivElement;
let root: Root;

function mount(presence: HumanPresence, onSetAway = vi.fn(), onClose = vi.fn()) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(<AwayMenu presence={presence} now={NOW} onSetAway={onSetAway} onClose={onClose} />),
  );
  return { onSetAway, onClose };
}

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const menu = () => host.querySelector<HTMLElement>('[role="menu"]');
const item = (name: string) =>
  Array.from(host.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (el) => el.textContent === name,
  );
const key = (el: Element, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });

describe('AwayMenu', () => {
  it('choosing For 1 hour sets away with an end', () => {
    const { onSetAway, onClose } = mount(HERE);
    expect(menu()?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(host.textContent).toContain('Set yourself away');
    act(() => item('For 1 hour')?.click());
    expect(onSetAway).toHaveBeenCalledTimes(1);
    const [away, until] = onSetAway.mock.calls[0] as [boolean, string];
    expect(away).toBe(true);
    expect(new Date(until).getTime()).toBe(NOW + 60 * 60 * 1000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("I'm back shows only while away", () => {
    mount(HERE);
    expect(item("I'm back")).toBeUndefined();
    expect(item('Until 09:00 tomorrow')).toBeDefined();
    act(() => root.unmount());
    host.remove();

    const { onSetAway, onClose } = mount(AWAY);
    act(() => item("I'm back")?.click());
    expect(onSetAway).toHaveBeenCalledWith(false, null);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc closes', () => {
    const { onClose, onSetAway } = mount(HERE);
    key(item('For 1 hour') as HTMLElement, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSetAway).not.toHaveBeenCalled();
  });

  it('arrow keys move between items and Enter chooses', () => {
    const { onSetAway } = mount(HERE);
    const first = item('For 1 hour') as HTMLElement;
    expect(document.activeElement).toBe(first);
    key(first, 'ArrowDown');
    expect(document.activeElement).toBe(item('Until 09:00 tomorrow'));
    key(document.activeElement as HTMLElement, 'ArrowUp');
    expect(document.activeElement).toBe(first);
    key(first, 'Enter');
    expect(onSetAway).toHaveBeenCalledTimes(1);
  });
});
