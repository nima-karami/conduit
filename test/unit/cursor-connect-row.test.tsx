// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CursorConnectRow } from '../../webview/components/cursor-connect-row';

const bridge = vi.hoisted(() => ({
  readCursorConnection: vi.fn(),
  connectCursor: vi.fn(),
  disconnectCursor: vi.fn(),
}));
vi.mock('../../webview/bridge', () => bridge);

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLDivElement;
afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  host?.remove();
  vi.clearAllMocks();
});

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<CursorConnectRow />));
}

describe('Cursor connection settings row', () => {
  it('announces the connected state and gives Disconnect its accessible name', async () => {
    bridge.readCursorConnection.mockResolvedValue({
      state: 'connected',
      path: 'C:\\Users\\Ada\\.cursor\\mcp.json',
    });

    await mount();

    expect(host.querySelector('[aria-live="polite"]')?.textContent).toContain('Connected');
    expect(host.querySelector('button[aria-label="Disconnect Cursor"]')).not.toBeNull();
  });

  it('announces a file path and OS error code when a connect action fails', async () => {
    bridge.readCursorConnection.mockResolvedValue({
      state: 'disconnected',
      path: '/home/ada/.cursor/mcp.json',
    });
    bridge.connectCursor.mockResolvedValue({
      state: 'disconnected',
      path: '/home/ada/.cursor/mcp.json',
      actionFailed: true,
      errorCode: 'EACCES',
    });
    await mount();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button')?.click();
    });

    const live = host.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('/home/ada/.cursor/mcp.json');
    expect(live?.textContent).toContain('EACCES');
    expect(live?.textContent).toContain('Not connected');
    expect(document.activeElement).toBe(host.querySelector('button'));
  });

  it('keeps the existing actions visible and disabled while an action is pending', async () => {
    bridge.readCursorConnection.mockResolvedValue({
      state: 'stale',
      path: '/home/ada/.cursor/mcp.json',
    });
    let complete!: (result: { state: 'connected'; path: string }) => void;
    bridge.connectCursor.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await mount();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button')?.click();
    });

    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['Connect Cursor', 'Disconnect']);
    expect(buttons.every((button) => button.disabled)).toBe(true);

    await act(async () => {
      complete({ state: 'connected', path: '/home/ada/.cursor/mcp.json' });
    });
    expect(host.querySelector('button')?.textContent).toBe('Disconnect');
  });

  it('offers both actions for a stale entry and only Check again for invalid config', async () => {
    bridge.readCursorConnection.mockResolvedValueOnce({
      state: 'stale',
      path: '/home/ada/.cursor/mcp.json',
    });
    await mount();
    expect(host.querySelectorAll('button')).toHaveLength(2);
    expect(host.querySelector('button')?.textContent).toBe('Connect Cursor');
    expect(host.querySelector('button[aria-label="Disconnect Cursor"]')).not.toBeNull();

    bridge.readCursorConnection.mockResolvedValueOnce({
      state: 'error',
      path: '/home/ada/.cursor/mcp.json',
    });
    await act(async () => root?.render(null));
    await act(async () => root?.render(<CursorConnectRow />));
    expect(host.querySelectorAll('button')).toHaveLength(1);
    expect(host.querySelector('button')?.textContent).toBe('Check again');
  });
});
