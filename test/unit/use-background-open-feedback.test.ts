// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBackgroundOpenFeedback } from '../../webview/use-background-open-feedback';

type Feedback = ReturnType<typeof useBackgroundOpenFeedback>;

let frames: Map<number, FrameRequestCallback>;
let nextFrame = 1;
const flushFrames = () => {
  const due = [...frames.values()];
  frames.clear();
  for (const cb of due) cb(0);
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let latest: Feedback;
let writes: string[];

function Probe() {
  latest = useBackgroundOpenFeedback();
  return createElement('div', { ref: latest.statusRef, role: 'status' });
}

beforeEach(async () => {
  vi.useFakeTimers();
  frames = new Map();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(createElement(Probe)));
  writes = [];
  const el = latest.statusRef.current as HTMLDivElement;
  new MutationObserver(() => writes.push(el.textContent ?? '')).observe(el, {
    childList: true,
    characterData: true,
    subtree: true,
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const report = (id = 'file:/a.ts', outcome: 'opened' | 'pinned' | 'already-open' = 'opened') =>
  act(async () => latest.report({ id, title: 'a.ts', outcome, sessionName: null }));

const frame = () => act(async () => flushFrames());

describe('useBackgroundOpenFeedback', () => {
  it('sets flashTabId on the next frame and clears it 600 ms later', async () => {
    await report();
    expect(latest.flashTabId).toBeNull();
    await frame();
    expect(latest.flashTabId).toBe('file:/a.ts');
    await act(async () => vi.advanceTimersByTime(599));
    expect(latest.flashTabId).toBe('file:/a.ts');
    await act(async () => vi.advanceTimersByTime(1));
    expect(latest.flashTabId).toBeNull();
  });

  it('a second report restarts the timer and replaces the id', async () => {
    await report('file:/a.ts');
    await frame();
    await act(async () => vi.advanceTimersByTime(400));
    await report('file:/b.ts');
    await frame();
    expect(latest.flashTabId).toBe('file:/b.ts');
    await act(async () => vi.advanceTimersByTime(400));
    expect(latest.flashTabId).toBe('file:/b.ts');
    await act(async () => vi.advanceTimersByTime(200));
    expect(latest.flashTabId).toBeNull();
  });

  it('a repeat on the SAME tab mid-cue drops the cue for a frame, so the animation replays', async () => {
    await report('file:/a.ts');
    await frame();
    await act(async () => vi.advanceTimersByTime(300));
    await report('file:/a.ts');
    expect(latest.flashTabId).toBeNull();
    await frame();
    expect(latest.flashTabId).toBe('file:/a.ts');
    await act(async () => vi.advanceTimersByTime(599));
    expect(latest.flashTabId).toBe('file:/a.ts');
  });

  it('clears the status text synchronously and sets it on the next frame', async () => {
    const el = latest.statusRef.current as HTMLDivElement;
    el.textContent = 'stale';
    await report();
    expect(el.textContent).toBe('');
    flushFrames();
    expect(el.textContent).toBe('Opened a.ts in a background tab');
  });

  it('two identical reports produce two writes separated by an empty one (AC-14)', async () => {
    await report('file:/a.ts', 'already-open');
    await act(async () => flushFrames());
    await report('file:/a.ts', 'already-open');
    await act(async () => flushFrames());
    const msg = 'a.ts is already open';
    const first = writes.indexOf(msg);
    const second = writes.indexOf(msg, first + 1);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(writes.slice(first + 1, second)).toContain('');
  });

  it('unmount cancels the pending frame', async () => {
    await report();
    expect(frames.size).toBe(1);
    await act(async () => root?.unmount());
    root = null;
    expect(frames.size).toBe(0);
  });

  it('unmount cancels the running cue timer', async () => {
    await report();
    await frame();
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });
});
