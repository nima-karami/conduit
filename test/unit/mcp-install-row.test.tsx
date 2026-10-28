// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AgentCli,
  CliInstallStatus,
  McpInstallRequest,
  McpInstallResult,
  UserInstallState,
} from '../../src/conduit-mcp/install-types';
import { McpInstallRow } from '../../webview/components/mcp-install-row';
import { MCP_STR } from '../../webview/conduit-mcp-strings';
import { STATUS_UNREADABLE } from '../../webview/mcp-install-codes';

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
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const PATH = '/home/ada/.codex/config.toml';
const status = (
  state: UserInstallState,
  extra: Partial<CliInstallStatus['user']> = {},
  cli: AgentCli = 'codex',
): CliInstallStatus => ({
  cli,
  found: state !== 'not-found',
  user: { state, path: PATH, ...extra },
  project: null,
});

type Act = (req: McpInstallRequest) => Promise<McpInstallResult | null>;

/** Plays useMcpInstall's part: an action's re-read status replaces the row's status. */
function Harness(p: {
  initial: CliInstallStatus | null;
  onAct: Act;
  onRecheck: () => void;
  focusOnMount: boolean;
  checking?: boolean;
}) {
  const [s, setS] = useState(p.initial);
  return (
    <McpInstallRow
      cli={p.initial?.cli ?? 'codex'}
      status={s}
      checking={p.checking}
      onAct={async (req) => {
        const r = await p.onAct(req);
        if (r) setS(r.status);
        return r;
      }}
      onRecheck={p.onRecheck}
      focusOnMount={p.focusOnMount}
    />
  );
}

async function mount(
  s: CliInstallStatus | null,
  onAct: Act = vi.fn<Act>(async () => null),
  onRecheck: () => void = vi.fn(),
  focusOnMount = false,
  checking = false,
) {
  host = document.createElement('div');
  document.body.append(host);
  const outside = document.createElement('button');
  outside.textContent = 'outside';
  document.body.append(outside);
  outside.focus();
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <Harness
        initial={s}
        onAct={onAct}
        onRecheck={onRecheck}
        focusOnMount={focusOnMount}
        checking={checking}
      />,
    ),
  );
}

const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('button')];
const labels = () => buttons().map((b) => b.textContent);
const live = () => host.querySelector('[aria-live="polite"]');
const visibleStatus = () => host.querySelector('.mcp-install-row__status');
const byName = (name: string) =>
  buttons().find((b) => (b.getAttribute('aria-label') ?? b.textContent) === name);

describe('McpInstallRow', () => {
  it('checking: no buttons, Checking…', async () => {
    await mount(null);
    expect(buttons()).toHaveLength(0);
    expect(visibleStatus()?.textContent).toContain(MCP_STR.install.state.checking);
    expect(live()?.textContent).toBe('');
  });

  it.each([
    ['not-found', [MCP_STR.install.checkAgain]],
    ['not-installed', [MCP_STR.install.install]],
    ['installed', [MCP_STR.install.uninstall]],
    ['other-conduit', [MCP_STR.install.useThis, MCP_STR.install.uninstall]],
    ['conflict', [MCP_STR.install.replace]],
    ['error', [MCP_STR.install.checkAgain]],
  ] as const)('%s shows exactly its §2.3 buttons', async (state, expected) => {
    await mount(status(state, state === 'error' ? { errorCode: 'ETOML' } : {}));
    expect(labels()).toEqual(expected);
    expect(visibleStatus()?.textContent).toContain(MCP_STR.install.state[state]);
    expect(live()?.textContent).toBe('');
  });

  it('error shows the path and the code text', async () => {
    await mount(status('error', { errorCode: 'EUNEDITABLE' }));
    expect(host.textContent).toContain(PATH);
    expect(host.textContent).toContain(MCP_STR.install.errorDetail('EUNEDITABLE'));
  });

  it('Check again on not-found and error calls onRecheck', async () => {
    const onRecheck = vi.fn();
    await mount(status('not-found'), undefined, onRecheck);
    await act(async () => buttons()[0].click());
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it('pending disables buttons and sets aria-busy', async () => {
    let resolve!: (r: McpInstallResult) => void;
    const onAct = vi.fn<Act>(() => new Promise((r) => (resolve = r)));
    await mount(status('not-installed'), onAct);
    await act(async () => buttons()[0].click());
    expect(onAct).toHaveBeenCalledWith({ cli: 'codex', scope: 'user', action: 'install' });
    expect(host.querySelector('.mcp-install-row')?.getAttribute('aria-busy')).toBe('true');
    expect(buttons().length).toBeGreaterThan(0);
    expect(buttons().every((b) => b.disabled)).toBe(true);
    expect(live()?.textContent).toContain(MCP_STR.install.state.pending);
    await act(async () => resolve({ ok: true, status: status('installed') }));
    expect(host.querySelector('.mcp-install-row')?.getAttribute('aria-busy')).toBeNull();
  });

  it('failure shows actionFailed with the path and the code text, plus Try again', async () => {
    const onAct = vi.fn<Act>(async () => ({
      ok: false,
      status: status('not-installed'),
      errorCode: 'EACCES',
    }));
    await mount(status('not-installed'), onAct);
    await act(async () => buttons()[0].click());
    expect(live()?.textContent).toContain(MCP_STR.install.actionFailed(PATH, 'EACCES'));
    expect(labels()[0]).toBe(MCP_STR.install.tryAgain);
    await act(async () => buttons()[0].click());
    expect(onAct).toHaveBeenCalledTimes(2);
    expect(onAct.mock.calls[1][0]).toEqual({ cli: 'codex', scope: 'user', action: 'install' });
  });

  it('a rejected invoke reads as a failed action', async () => {
    await mount(status('installed'));
    await act(async () => buttons()[0].click());
    expect(live()?.textContent).toContain(MCP_STR.install.actionFailed(PATH, 'EINVAL'));
    expect(host.textContent).not.toContain('EINVAL');
    expect(host.querySelector('[title="EINVAL"]')).not.toBeNull();
  });

  it('a failed action no longer valid for the re-read state offers only that state’s buttons', async () => {
    const onAct = vi.fn<Act>(async () => ({
      ok: false,
      status: status('installed'),
      errorCode: 'ESTATE',
    }));
    await mount(status('not-installed'), onAct);
    await act(async () => buttons()[0].click());
    expect(labels()).toEqual([MCP_STR.install.uninstall]);
  });

  it('Replace… opens a dialog naming the file and backup; focus starts on Cancel; Esc cancels and returns focus to the row; Replace calls act', async () => {
    const onAct = vi.fn<Act>(async () => ({ ok: true, status: status('installed') }));
    await mount(status('conflict'), onAct);
    const replace = buttons()[0];
    replace.focus();
    await act(async () => replace.click());
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain(PATH);
    expect(dialog?.textContent).toContain(`${PATH}.conduit-backup`);
    expect(document.activeElement?.textContent).toBe('Cancel');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onAct).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(replace);

    await act(async () => replace.click());
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ].find((b) => b.textContent === MCP_STR.install.replaceConfirm);
    await act(async () => confirm?.click());
    expect(onAct).toHaveBeenCalledWith({ cli: 'codex', scope: 'user', action: 'replace' });
  });

  it('after an action focus moves to the row’s first enabled button', async () => {
    const onAct = vi.fn<Act>(async () => ({ ok: true, status: status('installed') }));
    await mount(status('not-installed'), onAct);
    await act(async () => buttons()[0].click());
    expect(document.activeElement).toBe(byName(MCP_STR.install.uninstallAria('codex')));
  });

  it('focusOnMount focuses the first button once the status arrives', async () => {
    await mount(status('not-installed'), undefined, undefined, true);
    expect(document.activeElement).toBe(buttons()[0]);
  });

  it('state text is a polite live region per row', async () => {
    await mount(status('installed'));
    const region = live();
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.getAttribute('aria-atomic')).toBe('true');
  });

  it('buttons are named with the CLI', async () => {
    await mount(status('other-conduit'));
    expect(byName('Uninstall Conduit from Codex')).toBeDefined();
    expect(byName('Use this Conduit for Codex')).toBeDefined();
  });

  it('shadowed user entry carries the override note; Cursor carries its tool-approval note', async () => {
    await mount(status('installed', { shadowedBy: 'local' }));
    expect(host.textContent).toContain(MCP_STR.install.shadowed('local'));
    expect(host.textContent).toContain(MCP_STR.install.projectScope.local);
    await act(async () => root?.unmount());
    root = null;
    await mount(status('installed', {}, 'cursor'));
    expect(host.textContent).toContain(MCP_STR.install.cursorNote);
    expect(host.textContent).toContain('Cursor');
  });
});

describe('McpInstallRow announcements (review SF6, nit 6)', () => {
  it('the live region is empty on open and after nothing but a read', async () => {
    await mount(status('installed'));
    expect(live()?.textContent).toBe('');
  });

  it('a successful action announces the state and the file path', async () => {
    const onAct = vi.fn<Act>(async () => ({ ok: true, status: status('installed') }));
    await mount(status('not-installed'), onAct);
    await act(async () => buttons()[0].click());
    expect(live()?.textContent).toBe(
      MCP_STR.install.actionDone(MCP_STR.install.state.installed, PATH),
    );
    expect(live()?.textContent).toContain(PATH);
  });

  it('an explicit Check again announces Checking…, a plain read does not', async () => {
    let opts: { checking: boolean } = { checking: false };
    const draw = () =>
      root?.render(
        <McpInstallRow
          cli="codex"
          status={status('not-found')}
          checking={opts.checking}
          onAct={async () => null}
          onRecheck={() => {
            opts = { checking: true };
          }}
        />,
      );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => draw());
    expect(live()?.textContent).toBe('');
    await act(async () => buttons()[0].click());
    await act(async () => draw());
    expect(live()?.textContent).toBe(MCP_STR.install.state.checking);
  });
});

describe('McpInstallRow while checking (review SF2)', () => {
  function drawRow(s: CliInstallStatus | null, checking: boolean, onRecheck = vi.fn()) {
    return root?.render(
      <McpInstallRow
        cli="codex"
        status={s}
        checking={checking}
        onAct={async () => null}
        onRecheck={onRecheck}
      />,
    );
  }

  it('keeps its buttons mounted, focus on Check again, and reads Checking…', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => drawRow(status('not-found'), false));
    const check = buttons()[0];
    check.focus();
    await act(async () => drawRow(status('not-found'), true));
    expect(buttons()[0]).toBe(check);
    expect(document.activeElement).toBe(check);
    expect(visibleStatus()?.textContent).toContain(MCP_STR.install.state.checking);
    await act(async () => drawRow(status('not-installed'), false));
    expect(visibleStatus()?.textContent).toContain(MCP_STR.install.state['not-installed']);
  });

  it('a press while checking does not start a second read', async () => {
    const onRecheck = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => drawRow(status('error', { errorCode: 'ETOML' }), true, onRecheck));
    await act(async () => buttons()[0].click());
    expect(onRecheck).not.toHaveBeenCalled();
  });

  it('a stale failure does not survive a new check', async () => {
    const onAct = vi.fn<Act>(async () => ({
      ok: false,
      status: status('not-installed'),
      errorCode: 'EACCES',
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const draw = (checking: boolean) =>
      root?.render(
        <McpInstallRow
          cli="codex"
          status={status('not-installed')}
          checking={checking}
          onAct={onAct}
          onRecheck={() => {}}
        />,
      );
    await act(async () => draw(false));
    await act(async () => buttons()[0].click());
    expect(host.textContent).toContain(MCP_STR.install.actionFailed(PATH, 'EACCES'));
    await act(async () => draw(true));
    await act(async () => draw(false));
    expect(host.textContent).not.toContain(MCP_STR.install.actionFailed(PATH, 'EACCES'));
  });
});

describe('McpInstallRow focusOnMount via the Settings path (nit)', () => {
  it('mounts with status null, then the status arrives: the first button takes focus', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const draw = (s: CliInstallStatus | null) =>
      root?.render(
        <McpInstallRow
          cli="codex"
          status={s}
          onAct={async () => null}
          onRecheck={() => {}}
          focusOnMount
        />,
      );
    await act(async () => draw(null));
    expect(buttons()).toHaveLength(0);
    await act(async () => draw(status('not-installed')));
    expect(document.activeElement).toBe(buttons()[0]);
  });
});

describe('McpInstallRow unreadable status (nit 10)', () => {
  it('shows plain copy, the code only in a title', async () => {
    await mount(status('error', { errorCode: STATUS_UNREADABLE, path: '' }));
    expect(host.textContent).toContain(MCP_STR.install.unreadable);
    expect(host.textContent).not.toContain(STATUS_UNREADABLE);
    expect(host.querySelector(`[title="${STATUS_UNREADABLE}"]`)).not.toBeNull();
    expect(labels()).toEqual([MCP_STR.install.checkAgain]);
  });
});
