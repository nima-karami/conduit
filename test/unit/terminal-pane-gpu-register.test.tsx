// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TerminalPane } from '../../webview/components/terminal-pane';

const gpu = vi.hoisted(() => {
  const state = { registered: 0, unregistered: 0, initThrew: false };
  return {
    state,
    terminalGpu: {
      register: () => {
        state.registered++;
        return () => {
          state.unregistered++;
        };
      },
      reportLoss: () => {},
    },
  };
});
vi.mock('../../webview/terminal-gpu', () => ({ terminalGpu: gpu.terminalGpu }));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    element: HTMLElement | undefined;
    options: Record<string, unknown> = {};
    modes = { bracketedPasteMode: false };
    unicode = { activeVersion: '6' };
    loadAddon() {}
    open(parent: HTMLElement) {
      this.element = document.createElement('div');
      parent.appendChild(this.element);
    }
    attachCustomWheelEventHandler() {
      gpu.state.initThrew = true;
      throw new Error('init failed after the renderer was chosen');
    }
    onWriteParsed() {
      return { dispose() {} };
    }
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('../../webview/settings', () => ({
  useSettings: () => ({ settings: { terminalFontSize: 13, fontMono: '' }, update: () => {} }),
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

describe('TerminalPane GPU registration', () => {
  it('never holds a WebGL slot for a terminal whose init threw', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r = createRoot(host);
    root = r;
    await act(async () => r.render(<TerminalPane sessionId="s1" visible />));
    await act(async () => r.unmount());
    root = null;
    expect(gpu.state.initThrew).toBe(true);
    expect(gpu.state.registered).toBe(gpu.state.unregistered);
    host.remove();
  });
});
