// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DigestCounts } from '../../webview/away-view-model';
import { NeedsYouDigest } from '../../webview/components/needs-you-digest';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const COUNTS: DigestCounts = {
  from: new Date(2026, 10, 14, 0, 31).toISOString(),
  to: new Date(2026, 10, 14, 9, 12).toISOString(),
  durationLabel: '8 h 41 m',
  stillNeedYou: 3,
  wentWithDefault: 2,
  expired: 2,
  cleared: 6,
};

let host: HTMLDivElement;
let root: Root;

function mount(counts: DigestCounts, onDismiss = vi.fn(), onShowHistory = vi.fn()) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <NeedsYouDigest counts={counts} onDismiss={onDismiss} onShowHistory={onShowHistory} />,
    ),
  );
  return { onDismiss, onShowHistory };
}

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const buttons = (label: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('button')).filter(
    (b) => b.textContent === label,
  );

describe('NeedsYouDigest', () => {
  it('zero lines are omitted except still need you', () => {
    mount({ ...COUNTS, wentWithDefault: 0, expired: 0, cleared: 0 });
    expect(host.textContent).toContain('3 requests still need you');
    expect(host.textContent).not.toContain('went with the default');
    expect(host.textContent).not.toContain('expired');
    expect(host.textContent).not.toContain('cleared by themselves');
    expect(buttons('show')).toHaveLength(0);
  });

  it('show and Dismiss call back', () => {
    const { onDismiss, onShowHistory } = mount(COUNTS);
    expect(host.textContent).toContain('While you were away');
    expect(host.textContent).toContain('listed below');
    const shows = buttons('show');
    expect(shows).toHaveLength(3);
    act(() => shows[0].click());
    act(() => shows[2].click());
    expect(onShowHistory).toHaveBeenCalledTimes(2);
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => buttons('Dismiss')[0].click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain('Follow up');
  });
});
