// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { usePanZoomStage } from '../../webview/use-pan-zoom-stage';

/**
 * `ready` and the snap-to-fit are the two things the reset clears, and both used to be
 * keyed on dependencies that a reset does not move. A consumer that changes `resetKey`
 * while its content stays the same size (the same `natural` object, or a same-sized
 * replacement) got a stage stuck at `opacity: 0` — visible controls and caption over
 * nothing — and a zoom stuck at 100%. `ImageStage` only escapes it by nulling `natural`
 * in the same commit, which is a property of the consumer, not of this hook.
 *
 * jsdom lays nothing out, so the stage's measured size is stubbed below; everything else
 * (effect order, dependency arrays, the reset) is the real hook.
 */

const STAGE = { w: 800, h: 600 };
// Twice the stage on both axes, so a correct fit is 0.5 and a lost one reads as 1.
const NATURAL = { w: 1600, h: 1200 };

let latest: { ready: boolean; zoom: number };

function Probe({ resetKey }: { resetKey: string }): ReactNode {
  const stage = usePanZoomStage(NATURAL, { resetKey });
  latest = { ready: stage.ready, zoom: stage.zoom };
  return createElement('div', { ref: stage.stageRef });
}

let root: Root | null = null;

async function render(resetKey: string) {
  await act(async () => {
    root?.render(createElement(Probe, { resetKey }));
  });
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  for (const [prop, value] of [
    ['clientWidth', STAGE.w],
    ['clientHeight', STAGE.h],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { get: () => value, configurable: true });
  }
});

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
});

describe('usePanZoomStage — readiness across a reset', () => {
  it('returns to ready and to fit when resetKey changes but the content does not', async () => {
    root = createRoot(document.createElement('div'));
    await render('a');
    expect(latest).toEqual({ ready: true, zoom: 0.5 });

    await render('b');
    expect(latest.ready).toBe(true);
    expect(latest.zoom).toBe(0.5);
  });

  it('stays ready across several consecutive resets', async () => {
    root = createRoot(document.createElement('div'));
    for (const key of ['a', 'b', 'c', 'd']) {
      await render(key);
      expect(latest.ready).toBe(true);
    }
  });
});
