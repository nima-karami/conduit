import { afterEach, expect, it, vi } from 'vitest';
import { runRenderLoop } from '../../webview/render-loop';

afterEach(() => vi.unstubAllGlobals());

it('does not schedule frames until an initially hidden document becomes visible', () => {
  let visibility = () => {};
  const doc = {
    hidden: true,
    addEventListener: vi.fn((_name, listener) => {
      visibility = listener;
    }),
    removeEventListener: vi.fn(),
  };
  const request = vi.fn(() => 1);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const stop = runRenderLoop(vi.fn());
  expect(request).not.toHaveBeenCalled();
  doc.hidden = false;
  visibility();
  expect(request).toHaveBeenCalledTimes(1);
  visibility();
  expect(request).toHaveBeenCalledTimes(1);
  stop();
  expect(doc.removeEventListener).toHaveBeenCalledTimes(1);
});
