// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AnimatedBg } from '../../webview/components/animated-bg';

const seen = vi.hoisted((): unknown[] => []);
vi.mock('../../webview/components/shader-bg', () => ({
  ShaderBg: (props: { onUnsupported: () => void }) => {
    seen.push(props.onUnsupported);
    return null;
  },
}));
vi.mock('../../webview/settings', () => ({
  useSettings: () => ({
    settings: {
      background: 'shader',
      bgIntensity: 'balanced',
      reduceMotion: false,
      theme: 'neon',
      customShader: '',
    },
  }),
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
});

describe('AnimatedBg shader backdrop', () => {
  // ShaderBg's GL effect depends on onUnsupported, so a fresh callback per render tore the scene
  // down and rebuilt it on every App render (the plasma jumped on each state broadcast).
  it('hands ShaderBg the same onUnsupported across re-renders', async () => {
    const host = document.createElement('div');
    const r = createRoot(host);
    root = r;
    await act(async () => r.render(<AnimatedBg />));
    await act(async () => r.render(<AnimatedBg />));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size).toBe(1);
  });
});
