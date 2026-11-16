// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';

const h = vi.hoisted(() => ({
  posted: [] as WebviewToHost[],
  listeners: new Set<(m: HostToWebview) => void>(),
  terms: [] as FakeTerm[],
  fitTo: { cols: 120, rows: 40 },
}));

interface FakeTerm {
  cols: number;
  rows: number;
  options: Record<string, unknown>;
  written: string[];
  disposed: boolean;
  dataHandler: ((d: string) => void) | null;
  resize(cols: number, rows: number): void;
}

vi.mock('../../webview/bridge', () => ({
  post: (m: WebviewToHost) => h.posted.push(m),
  subscribe: (cb: (m: HostToWebview) => void) => {
    h.listeners.add(cb);
    return () => h.listeners.delete(cb);
  },
  windowsPty: undefined,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class implements FakeTerm {
    cols: number;
    rows: number;
    options: Record<string, unknown>;
    written: string[] = [];
    disposed = false;
    dataHandler: ((d: string) => void) | null = null;
    element: HTMLElement | undefined;
    unicode = { activeVersion: '6' };
    parser = {
      registerCsiHandler: () => ({ dispose() {} }),
      registerOscHandler: () => ({ dispose() {} }),
      registerDcsHandler: () => ({ dispose() {} }),
      registerEscHandler: () => ({ dispose() {} }),
    };
    constructor(opts: { cols: number; rows: number } & Record<string, unknown>) {
      this.cols = opts.cols;
      this.rows = opts.rows;
      this.options = { ...opts };
      h.terms.push(this);
    }
    loadAddon() {}
    open(parent: HTMLElement) {
      this.element = document.createElement('div');
      parent.appendChild(this.element);
    }
    write(data: string, cb?: () => void) {
      this.written.push(data);
      cb?.();
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    onData(cb: (d: string) => void) {
      this.dataHandler = cb;
      return { dispose() {} };
    }
    dispose() {
      this.disposed = true;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      const t = h.terms[h.terms.length - 1];
      t.resize(h.fitTo.cols, h.fitTo.rows);
    }
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('../../webview/terminal-fonts', () => ({ terminalFontFamily: () => undefined }));
vi.mock('../../webview/terminal-gpu', () => ({
  terminalGpu: {
    register: () => () => {},
    setVisible: () => {},
    reportLoss: () => {},
    hasAddon: () => false,
  },
}));
vi.mock('../../webview/settings', () => ({
  useSettings: () => ({
    settings: { terminalFontSize: 13, fontMono: '', theme: '' },
    update: () => {},
  }),
}));

import { RemotePane } from '../../webview/components/remote-pane';
import { MACHINES_STR } from '../../webview/machines-strings';

const REMOTE = { machineId: 'm-0000000b', sessionId: 'r1' };
const emit = async (m: HostToWebview) => {
  await act(async () => {
    for (const l of [...h.listeners]) l(m);
  });
};
const attachRequestId = (): number => {
  const m = h.posted.find((p) => p.type === 'remote:attach');
  if (m?.type !== 'remote:attach') throw new Error('no remote:attach posted');
  return m.requestId;
};
const attached = (
  drive = true,
  windowsPty: { backend: 'conpty'; buildNumber: number } | null = null,
): HostToWebview => ({
  type: 'remote:attached',
  requestId: attachRequestId(),
  result: {
    ok: true,
    viewId: 'v1',
    firstPaint: 'HELLO',
    size: { cols: 100, rows: 30 },
    windowsPty,
    drive,
  },
});
const sent = (type: WebviewToHost['type']) => h.posted.filter((p) => p.type === type);

let root: Root | null = null;
let host: HTMLElement;

function renderPane(drive = true) {
  void drive;
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  return act(async () =>
    root?.render(
      createElement(RemotePane, {
        remote: REMOTE,
        machineName: 'bee',
        label: 'Build',
        visible: true,
        onClosed: () => {},
      }),
    ),
  );
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom lays nothing out; the pane fits only a host that has a size, as in the browser.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 600,
  });
});

beforeEach(() => {
  h.posted.length = 0;
  h.listeners.clear();
  h.terms.length = 0;
  h.fitTo = { cols: 120, rows: 40 };
});

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  host?.remove();
});

describe('RemotePane', () => {
  it('creates the terminal only after attach and writes firstPaint', async () => {
    await renderPane();
    expect(sent('remote:attach')).toHaveLength(1);
    expect(h.terms).toHaveLength(0);

    await emit(attached(true, { backend: 'conpty', buildNumber: 22631 }));
    expect(h.terms).toHaveLength(1);
    const term = h.terms[0];
    expect([term.cols, term.rows]).toEqual([100, 30]);
    expect(term.options.windowsPty).toEqual({ backend: 'conpty', buildNumber: 22631 });
    expect(term.written).toContain('HELLO');
  });

  it('first keystroke sends resize then input', async () => {
    await renderPane();
    await emit(attached(true));
    const term = h.terms[0];

    term.dataHandler?.('l');
    expect(h.posted.slice(-2)).toEqual([
      {
        type: 'remote:resize',
        machineId: REMOTE.machineId,
        sessionId: REMOTE.sessionId,
        cols: 120,
        rows: 40,
      },
      { type: 'remote:input', machineId: REMOTE.machineId, sessionId: REMOTE.sessionId, data: 'l' },
    ]);

    term.dataHandler?.('s');
    expect(sent('remote:resize')).toHaveLength(1);
    expect(sent('remote:input').map((m) => (m.type === 'remote:input' ? m.data : ''))).toEqual([
      'l',
      's',
    ]);
  });

  it('drive false sends no input', async () => {
    await renderPane();
    await emit(attached(false));
    h.terms[0].dataHandler?.('x');
    expect(sent('remote:input')).toHaveLength(0);
    expect(sent('remote:resize')).toHaveLength(0);
    const note = host.querySelector('.remote-pane-note');
    expect(note?.textContent).toBe(MACHINES_STR.readOnly('bee'));
    expect(note?.getAttribute('aria-live')).toBe('polite');
  });

  it('frozen shows the reconnecting note', async () => {
    await renderPane();
    await emit(attached(true));
    await emit({ type: 'remote:state', viewId: 'v1', state: 'frozen', since: null, size: null });
    expect(host.querySelector('.remote-pane')?.classList.contains('remote-pane--frozen')).toBe(
      true,
    );
    expect(host.querySelector('.remote-pane-note')?.textContent).toBe(
      MACHINES_STR.reconnecting('bee'),
    );
    await emit({ type: 'remote:state', viewId: 'v1', state: 'live', since: null, size: null });
    expect(host.querySelector('.remote-pane')?.classList.contains('remote-pane--frozen')).toBe(
      false,
    );
  });

  it('unmount detaches', async () => {
    await renderPane();
    await emit(attached(true));
    await act(async () => root?.unmount());
    root = null;
    expect(sent('remote:detach')).toEqual([{ type: 'remote:detach', viewId: 'v1' }]);
    expect(h.terms[0].disposed).toBe(true);
  });
});
