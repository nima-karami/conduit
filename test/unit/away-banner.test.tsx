// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HumanPresence } from '../../src/conduit-mcp/request-types';
import { AwayBanner } from '../../webview/components/away-banner';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const HERE: HumanPresence = {
  state: 'here',
  since: '2026-11-14T00:00:00.000Z',
  until: null,
  lastAway: null,
};
const AWAY_UNTIL: HumanPresence = {
  state: 'away',
  since: '2026-11-14T00:00:00.000Z',
  until: new Date(2026, 10, 15, 9, 0).toISOString(),
  lastAway: null,
};

let host: HTMLDivElement;
let root: Root;

function mount(presence: HumanPresence, onBack = vi.fn()) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<AwayBanner presence={presence} onBack={onBack} />));
  return { onBack };
}

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('AwayBanner', () => {
  it('hidden when here', () => {
    mount(HERE);
    expect(host.innerHTML).toBe('');
  });

  it("I'm back calls onBack", () => {
    const { onBack } = mount(AWAY_UNTIL);
    expect(host.textContent).toContain("You're away until 09:00.");
    expect(host.textContent).toContain('Only urgent requests send notifications.');
    const back = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === "I'm back",
    );
    act(() => back?.click());
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
