// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AgentCli,
  CliInstallStatus,
  McpInstallRequest,
  McpInstallResult,
  McpInstallStatus,
  ProjectInstall,
} from '../../src/conduit-mcp/install-types';
import { McpProjectEntries } from '../../webview/components/mcp-project-entries';
import { MCP_STR } from '../../webview/conduit-mcp-strings';

vi.mock('../../webview/bridge', () => ({ isHosted: false, logToHost: vi.fn() }));

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

const ROOT = '/work/app';
type Act = (req: McpInstallRequest) => Promise<McpInstallResult | null>;

const cliStatus = (cli: AgentCli, project: ProjectInstall | null): CliInstallStatus => ({
  cli,
  found: true,
  user: { state: 'installed', path: `/home/ada/${cli}` },
  project,
});
const none = (cli: AgentCli): ProjectInstall =>
  cli === 'cursor'
    ? { entries: [], installable: false, installPath: null }
    : { entries: [], installable: true, installPath: `${ROOT}/${cli}.cfg` };
const allNone = (): McpInstallStatus => ({
  clis: (['claude', 'codex', 'cursor', 'opencode'] as const).map((c) => cliStatus(c, none(c))),
});

async function mount(status: McpInstallStatus | null, onAct: Act = vi.fn<Act>(async () => null)) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(<McpProjectEntries status={status} projectPath={ROOT} onAct={onAct} />),
  );
}

const byName = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent) === name,
  );

describe('McpProjectEntries', () => {
  it('none found shows the commit warning and Install for this project (not for Cursor)', async () => {
    const onAct = vi.fn<Act>(async () => null);
    await mount(allNone(), onAct);
    expect(host.textContent).toContain(MCP_STR.install.projectNone);
    expect(host.textContent).toContain(MCP_STR.install.projectWarn(`${ROOT}/claude.cfg`));
    expect(byName(MCP_STR.install.installProjectAria('claude'))).toBeDefined();
    expect(byName(MCP_STR.install.installProjectAria('codex'))).toBeDefined();
    expect(byName(MCP_STR.install.installProjectAria('opencode'))).toBeDefined();
    expect(byName(MCP_STR.install.installProjectAria('cursor'))).toBeUndefined();
    await act(async () => byName(MCP_STR.install.installProjectAria('codex'))?.click());
    expect(onAct).toHaveBeenCalledWith({
      cli: 'codex',
      scope: 'project',
      action: 'install',
      projectPath: ROOT,
    });
  });

  it('Remove only for ours/other-conduit, with entryScope', async () => {
    const onAct = vi.fn<Act>(async () => null);
    const status: McpInstallStatus = {
      clis: [
        cliStatus('claude', {
          entries: [
            { scope: 'local', state: 'ours', path: '/home/ada/.claude.json' },
            { scope: 'project', state: 'conflict', path: `${ROOT}/.mcp.json` },
          ],
          installable: false,
          installPath: null,
        }),
        cliStatus('codex', {
          entries: [
            { scope: 'project', state: 'other-conduit', path: `${ROOT}/.codex/config.toml` },
          ],
          installable: false,
          installPath: null,
        }),
        cliStatus('cursor', none('cursor')),
        cliStatus('opencode', {
          entries: [{ scope: 'project', state: 'error', path: `${ROOT}/opencode.json` }],
          installable: false,
          installPath: null,
        }),
      ],
    };
    await mount(status, onAct);
    expect(host.textContent).not.toContain(MCP_STR.install.projectNone);
    expect(host.textContent).toContain(MCP_STR.install.projectState.conflict);
    expect(host.textContent).toContain(`${ROOT}/opencode.json`);
    const removes = [...host.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(removes).toEqual([
      MCP_STR.install.removeAria('claude', 'local'),
      MCP_STR.install.removeAria('codex', 'project'),
    ]);
    await act(async () => byName(MCP_STR.install.removeAria('claude', 'local'))?.click());
    expect(onAct).toHaveBeenCalledWith({
      cli: 'claude',
      scope: 'project',
      action: 'remove',
      projectPath: ROOT,
      entryScope: 'local',
    });
  });

  it('Codex row carries the trusted-project note', async () => {
    await mount(allNone());
    const codex = [...host.querySelectorAll('.mcp-project__cli')].find((el) =>
      el.textContent?.includes('Codex'),
    );
    expect(codex?.textContent).toContain(MCP_STR.install.codexTrustNote);
    expect(host.textContent?.split(MCP_STR.install.codexTrustNote)).toHaveLength(2);
  });

  it('failed action shows actionFailed for that file', async () => {
    const onAct = vi.fn<Act>(async (req) => ({
      ok: false,
      status: cliStatus(req.cli, none(req.cli)),
      errorCode: 'EACCES',
    }));
    await mount(allNone(), onAct);
    await act(async () => byName(MCP_STR.install.installProjectAria('opencode'))?.click());
    expect(host.textContent).toContain(
      MCP_STR.install.actionFailed(`${ROOT}/opencode.cfg`, 'EACCES'),
    );
  });

  it('renders nothing while checking or without a project answer', async () => {
    await mount(null);
    expect(host.textContent).toBe('');
    await act(async () => root?.unmount());
    root = null;
    await mount({ clis: allNone().clis.map((c) => ({ ...c, project: null })) });
    expect(host.textContent).toBe('');
  });
});
