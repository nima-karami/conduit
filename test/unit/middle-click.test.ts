import type { MouseEvent as ReactMouseEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  backgroundOpenAnnouncement,
  MIDDLE_CLICK_STRINGS,
  middleClickProps,
  terminalLinkMiddleAction,
} from '../../webview/middle-click';

function fakeEvent(button: number) {
  return {
    button,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as ReactMouseEvent<Element> & {
    preventDefault: ReturnType<typeof vi.fn>;
    stopPropagation: ReturnType<typeof vi.fn>;
  };
}

describe('middleClickProps', () => {
  it('default-prevents a middle mousedown and leaves a left one alone', () => {
    const p = middleClickProps(() => {});
    const mid = fakeEvent(1);
    const left = fakeEvent(0);
    p.onMouseDown(mid);
    p.onMouseDown(left);
    expect(mid.preventDefault).toHaveBeenCalledTimes(1);
    expect(left.preventDefault).not.toHaveBeenCalled();
  });

  it('runs the consumer onMouseDown first, for every button', () => {
    const order: string[] = [];
    const consumer = vi.fn((e: { button: number; preventDefault: () => void }) => {
      order.push(`consumer:${e.button}`);
    });
    const p = middleClickProps(() => {}, consumer);
    const mid = fakeEvent(1);
    mid.preventDefault.mockImplementation(() => order.push('suppress'));
    p.onMouseDown(mid);
    p.onMouseDown(fakeEvent(0));
    p.onMouseDown(fakeEvent(2));
    expect(order).toEqual(['consumer:1', 'suppress', 'consumer:0', 'consumer:2']);
  });

  it('never stops mousedown propagation (outside-click dismissal relies on it)', () => {
    const p = middleClickProps(() => {});
    const e = fakeEvent(1);
    p.onMouseDown(e);
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });

  it('on a middle auxclick prevents, stops and calls onMiddle once', () => {
    const onMiddle = vi.fn();
    const e = fakeEvent(1);
    middleClickProps(onMiddle).onAuxClick(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
    expect(onMiddle).toHaveBeenCalledTimes(1);
  });

  it('ignores a right-button auxclick', () => {
    const onMiddle = vi.fn();
    const e = fakeEvent(2);
    middleClickProps(onMiddle).onAuxClick(e);
    expect(onMiddle).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });

  it('with onMiddle null still prevents and stops the middle auxclick', () => {
    const e = fakeEvent(1);
    middleClickProps(null).onAuxClick(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
  });
});

describe('announcement strings', () => {
  it('reads each outcome, with and without a session', () => {
    expect(MIDDLE_CLICK_STRINGS.opened('a.ts')).toBe('Opened a.ts in a background tab');
    expect(MIDDLE_CLICK_STRINGS.openedIn('a.ts', 'api')).toBe(
      'Opened a.ts in a background tab in api',
    );
    expect(MIDDLE_CLICK_STRINGS.pinned('a.ts')).toBe('Pinned a.ts');
    expect(MIDDLE_CLICK_STRINGS.pinnedIn('a.ts', 'api')).toBe('Pinned a.ts in api');
    expect(MIDDLE_CLICK_STRINGS.alreadyOpen('a.ts')).toBe('a.ts is already open');
    expect(MIDDLE_CLICK_STRINGS.alreadyOpenIn('a.ts', 'api')).toBe('a.ts is already open in api');
  });

  it('picks the string for the outcome', () => {
    expect(backgroundOpenAnnouncement('opened', 'a.ts', null)).toBe(
      'Opened a.ts in a background tab',
    );
    expect(backgroundOpenAnnouncement('pinned', 'a.ts', 'api')).toBe('Pinned a.ts in api');
    expect(backgroundOpenAnnouncement('already-open', 'a.ts', null)).toBe('a.ts is already open');
  });
});

describe('terminalLinkMiddleAction (AC-16)', () => {
  it.each([
    [1, 'Win32', 'background'],
    [1, 'MacIntel', 'background'],
    [1, 'Linux x86_64', 'ignore'],
    [0, 'Linux x86_64', 'foreground'],
    [0, 'Win32', 'foreground'],
    [2, 'Win32', 'ignore'],
  ] as const)('button %i on %s → %s', (button, platform, want) => {
    expect(terminalLinkMiddleAction(button, platform)).toBe(want);
  });
});
