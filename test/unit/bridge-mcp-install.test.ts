// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpInstallResult } from '../../src/conduit-mcp/install-types';

const REQ = { cli: 'codex', scope: 'user', action: 'install' } as const;
const result = (ok: boolean): McpInstallResult =>
  ok
    ? {
        ok: true,
        status: {
          cli: 'codex',
          found: true,
          user: { state: 'installed', path: '/p' },
          project: null,
        },
      }
    : {
        ok: false,
        errorCode: 'EACCES',
        status: { cli: 'codex', found: true, user: { state: 'error', path: '/p' }, project: null },
      };

async function loadBridge(act: () => Promise<McpInstallResult>) {
  vi.resetModules();
  (window as { agentDeck?: unknown }).agentDeck = {
    post: vi.fn(),
    subscribe: () => () => {},
    win: undefined,
    mcpInstall: { status: vi.fn(), act },
  };
  return import('../../webview/bridge');
}

afterEach(() => {
  delete (window as { agentDeck?: unknown }).agentDeck;
  vi.resetModules();
});

describe('onMcpInstallChanged', () => {
  it('fires after a resolved ok act, once per act, and returns the result', async () => {
    const bridge = await loadBridge(async () => result(true));
    const cb = vi.fn();
    bridge.onMcpInstallChanged(cb);
    const r = await bridge.mcpInstallAct(REQ);
    expect(r.ok).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not fire for a failed act or a rejected invoke', async () => {
    const failing = await loadBridge(async () => result(false));
    const cb = vi.fn();
    failing.onMcpInstallChanged(cb);
    await failing.mcpInstallAct(REQ);
    expect(cb).not.toHaveBeenCalled();

    const rejecting = await loadBridge(async () => {
      throw new Error('ipc');
    });
    rejecting.onMcpInstallChanged(cb);
    await expect(rejecting.mcpInstallAct(REQ)).rejects.toThrow('ipc');
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe stops notifications', async () => {
    const bridge = await loadBridge(async () => result(true));
    const cb = vi.fn();
    const off = bridge.onMcpInstallChanged(cb);
    off();
    await bridge.mcpInstallAct(REQ);
    expect(cb).not.toHaveBeenCalled();
  });
});
