// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHADER_RESTORE_TIMEOUT_MS, ShaderBg } from '../../webview/components/shader-bg';
import { GPU_GIVE_UP_LOSSES } from '../../webview/gpu-loss-policy';

const res = vi.hoisted(() => ({ builds: 0, failNext: false }));
vi.mock('../../webview/shader-resources', () => ({
  createShaderResources: () => {
    res.builds++;
    if (res.failNext) return null;
    return { program: {}, buffer: {}, dispose() {} };
  },
}));
vi.mock('../../webview/render-loop', () => ({ runRenderLoop: () => () => {} }));

// Every WebGL call the scene makes is a no-op; only the lost flag matters here.
let contextLost = false;
const fakeGl = new Proxy(
  {},
  {
    get: (_t, k) =>
      k === 'isContextLost' ? () => contextLost : typeof k === 'string' ? () => null : undefined,
  },
);

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLCanvasElement.prototype.getContext = (() => fakeGl) as never;
});

let root: Root | null = null;
let host: HTMLDivElement;
let onUnsupported: ReturnType<typeof vi.fn<() => void>>;

beforeEach(async () => {
  vi.useFakeTimers();
  res.builds = 0;
  res.failNext = false;
  contextLost = false;
  onUnsupported = vi.fn<() => void>();
  host = document.createElement('div');
  document.body.appendChild(host);
  const r = createRoot(host);
  root = r;
  await act(async () =>
    r.render(<ShaderBg intensity="balanced" theme="neon" onUnsupported={onUnsupported} />),
  );
});

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  host.remove();
  vi.useRealTimers();
});

const canvas = () => host.querySelector('canvas');
const visible = () => !!canvas() && canvas()?.style.visibility !== 'hidden';
const fire = async (type: 'webglcontextlost' | 'webglcontextrestored') => {
  await act(async () => {
    contextLost = type === 'webglcontextlost';
    canvas()?.dispatchEvent(new Event(type, { cancelable: true }));
  });
};

describe('ShaderBg across a GPU reset', () => {
  it('shows the canvas once the scene runs', () => {
    expect(res.builds).toBe(1);
    expect(visible()).toBe(true);
  });

  // A canvas whose WebGL context could not be (re)created paints opaque white.
  it('hides the canvas while its context is lost', async () => {
    await fire('webglcontextlost');
    expect(visible()).toBe(false);
  });

  it('rebuilds the scene and shows it again on restore', async () => {
    await fire('webglcontextlost');
    await fire('webglcontextrestored');
    expect(res.builds).toBe(2);
    expect(visible()).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(SHADER_RESTORE_TIMEOUT_MS);
    });
    expect(onUnsupported).not.toHaveBeenCalled();
    expect(visible()).toBe(true);
  });

  it('gives up when no restore arrives in time', async () => {
    await fire('webglcontextlost');
    await act(async () => {
      vi.advanceTimersByTime(SHADER_RESTORE_TIMEOUT_MS);
    });
    expect(onUnsupported).toHaveBeenCalledTimes(1);
    expect(canvas()).toBeNull();
  });

  it('gives up when the rebuild on restore fails', async () => {
    await fire('webglcontextlost');
    res.failNext = true;
    await fire('webglcontextrestored');
    expect(onUnsupported).toHaveBeenCalledTimes(1);
    expect(canvas()).toBeNull();
  });

  it(`gives up on loss ${GPU_GIVE_UP_LOSSES + 1} inside the window`, async () => {
    for (let i = 0; i < GPU_GIVE_UP_LOSSES; i++) {
      await fire('webglcontextlost');
      await fire('webglcontextrestored');
    }
    expect(onUnsupported).not.toHaveBeenCalled();
    await fire('webglcontextlost');
    expect(onUnsupported).toHaveBeenCalledTimes(1);
    expect(canvas()).toBeNull();
  });
});
