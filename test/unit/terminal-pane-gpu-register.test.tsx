// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TerminalPane } from '../../webview/components/terminal-pane';

const gpu = vi.hoisted(() => {
  const state = {
    registered: 0,
    unregistered: 0,
    initThrew: false,
    throwInit: true,
    calls: [] as string[],
  };
  return {
    state,
    terminalGpu: {
      register: (_term: unknown, _onFont: unknown, opts?: { visible?: boolean }) => {
        state.registered++;
        state.calls.push(`register:${opts?.visible}`);
        return () => {
          state.unregistered++;
        };
      },
      reportLoss: () => {},
      setVisible: (_term: unknown, v: boolean) => {
        state.calls.push(`visible:${v}`);
      },
    },
  };
});
vi.mock('../../webview/terminal-gpu', () => ({ terminalGpu: gpu.terminalGpu }));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    element: HTMLElement | undefined;
    options: Record<string, unknown> = {};
    modes = { bracketedPasteMode: false };
    parser = {
      registerCsiHandler: () => ({ dispose() {} }),
      registerOscHandler: () => ({ dispose() {} }),
      registerDcsHandler: () => ({ dispose() {} }),
    };
    unicode = { activeVersion: '6' };
    loadAddon() {}
    open(parent: HTMLElement) {
      this.element = document.createElement('div');
      const screen = document.createElement('div');
      screen.className = 'xterm-screen';
      this.element.appendChild(screen);
      parent.appendChild(this.element);
    }
    attachCustomWheelEventHandler() {
      if (!gpu.state.throwInit) return;
      gpu.state.initThrew = true;
      throw new Error('init failed after the renderer was chosen');
    }
    onWriteParsed() {
      return { dispose() {} };
    }
    dispose() {}
    // Anything else the pane wires up is a no-op subscription (only reached with throwInit off).
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: a permissive fake of the xterm surface.
      return new Proxy(this, {
        get: (t, k) =>
          k in t
            ? (t as Record<string | symbol, unknown>)[k]
            : k === 'buffer'
              ? { active: { viewportY: 0, baseY: 0, type: 'normal' } }
              : () => ({ dispose() {} }),
      });
    }
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
    await act(async () =>
      r.render(
        <TerminalPane sessionId="s1" rootsSig="" visible serverState={{ state: 'connected' }} />,
      ),
    );
    await act(async () => r.unmount());
    root = null;
    expect(gpu.state.initThrew).toBe(true);
    expect(gpu.state.registered).toBe(gpu.state.unregistered);
    host.remove();
  });

  it('pauses terminal input behind a reconnecting overlay', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r = createRoot(host);
    root = r;
    await act(async () =>
      r.render(
        <TerminalPane sessionId="s1" rootsSig="" visible serverState={{ state: 'reconnecting' }} />,
      ),
    );
    expect(host.textContent).toContain('Reconnecting — input paused');
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    host.remove();
  });

  it('says the service is down, not reconnecting, when it has stopped', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r = createRoot(host);
    root = r;
    await act(async () =>
      r.render(
        <TerminalPane
          sessionId="s1"
          rootsSig=""
          visible
          serverState={{ state: 'stopped', reason: 'x', logPath: '/l' }}
        />,
      ),
    );
    expect(host.textContent).toContain("Input paused — background service isn't running");
    expect(host.textContent).not.toContain('Reconnecting');
    host.remove();
  });
});

// Memory audit 2026-11-03 (mem-terminals #2): a hidden pane holds no WebGL context.
describe('TerminalPane WebGL follows visibility', () => {
  const render = async (r: Root, visible: boolean) =>
    act(async () =>
      r.render(
        <TerminalPane
          sessionId="s1"
          rootsSig=""
          visible={visible}
          serverState={{ state: 'connected' }}
        />,
      ),
    );

  it('registers a hidden pane without WebGL, attaches on show and releases on hide', async () => {
    gpu.state.throwInit = false;
    gpu.state.calls = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r = createRoot(host);
    root = r;
    try {
      await render(r, false);
      expect(gpu.state.calls).toEqual(['register:false']);
      await render(r, true);
      await render(r, false);
      expect(gpu.state.calls).toEqual(['register:false', 'visible:true', 'visible:false']);
    } finally {
      gpu.state.throwInit = true;
      vi.unstubAllGlobals();
      host.remove();
    }
  });

  // terminal-local-font regression: the DOM and WebGL renderers size the cell differently, so an
  // attach after the show's fit leaves the cols fitted to the wrong cell (and resizes the PTY twice).
  it('attaches WebGL in the commit that shows the pane, before its first fit', async () => {
    gpu.state.throwInit = false;
    gpu.state.calls = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    // A real observer reports a display:none pane as not intersecting, and reports it shown only
    // after the frame that first paints it.
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
        observe() {
          this.cb([{ isIntersecting: false }]);
        }
        disconnect() {}
      },
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r = createRoot(host);
    root = r;
    try {
      await render(r, false);
      await render(r, true);
      expect(gpu.state.calls).toEqual(['register:false', 'visible:true']);
    } finally {
      gpu.state.throwInit = true;
      vi.unstubAllGlobals();
      host.remove();
    }
  });
});
