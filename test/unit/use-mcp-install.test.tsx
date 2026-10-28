// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AGENT_CLIS,
  type CliInstallStatus,
  type McpInstallStatus,
} from '../../src/conduit-mcp/install-types';
import { STATUS_UNREADABLE } from '../../webview/mcp-install-codes';
import { type McpInstallApi, useMcpInstall } from '../../webview/use-mcp-install';

const bridge = vi.hoisted(() => ({
  mcpInstallStatus: vi.fn<(p: string | null) => Promise<McpInstallStatus>>(),
  mcpInstallAct: vi.fn(),
}));
vi.mock('../../webview/bridge', () => ({ ...bridge, isHosted: false, logToHost: vi.fn() }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLDivElement;
let api: McpInstallApi;
afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  host?.remove();
  vi.clearAllMocks();
});

const statusOf = (tag: string): McpInstallStatus => ({
  clis: AGENT_CLIS.map(
    (cli): CliInstallStatus => ({
      cli,
      found: true,
      user: { state: 'not-installed', path: `/${tag}/${cli}` },
      project: null,
    }),
  ),
});

function Probe({ projectPath }: { projectPath: string | null }) {
  api = useMcpInstall(projectPath);
  return null;
}

async function mount(projectPath: string | null = null) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<Probe projectPath={projectPath} />));
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useMcpInstall', () => {
  it('only the very first read is null; Check again keeps the last status', async () => {
    const first = deferred<McpInstallStatus>();
    bridge.mcpInstallStatus.mockReturnValueOnce(first.promise);
    await mount();
    expect(api.status).toBeNull();
    expect(api.checking.size).toBe(0);
    const initial = statusOf('a');
    await act(async () => first.resolve(initial));
    expect(api.status).toBe(initial);

    const second = deferred<McpInstallStatus>();
    bridge.mcpInstallStatus.mockReturnValueOnce(second.promise);
    await act(async () => api.refresh());
    expect(api.status).toBe(initial);
    expect([...api.checking].sort()).toEqual([...AGENT_CLIS].sort());

    const next = statusOf('b');
    await act(async () => second.resolve(next));
    expect(api.status).toBe(next);
    expect(api.checking.size).toBe(0);
  });

  it('a different project starts from null, never showing the old project’s entries', async () => {
    bridge.mcpInstallStatus.mockResolvedValueOnce(statusOf('a'));
    await mount('/p1');
    expect(api.status).not.toBeNull();
    const pending = deferred<McpInstallStatus>();
    bridge.mcpInstallStatus.mockReturnValueOnce(pending.promise);
    await act(async () => root?.render(<Probe projectPath="/p2" />));
    expect(api.status).toBeNull();
  });

  it('a rejected refresh keeps nothing stale: every row reads as unreadable', async () => {
    bridge.mcpInstallStatus.mockResolvedValueOnce(statusOf('a'));
    await mount();
    bridge.mcpInstallStatus.mockRejectedValueOnce(new Error('ipc'));
    await act(async () => api.refresh());
    expect(api.checking.size).toBe(0);
    expect(api.status?.clis.map((c) => c.user.errorCode)).toEqual(
      AGENT_CLIS.map(() => STATUS_UNREADABLE),
    );
  });
});
