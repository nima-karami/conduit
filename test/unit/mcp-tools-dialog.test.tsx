// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type CliPolicyLayers,
  coerceGlobalPolicy,
  type PolicyLayer,
  TOOL_NAMES,
} from '../../src/conduit-mcp/tool-policy';
import type { Session } from '../../src/types';
import {
  McpToolsDialog,
  type McpToolsDialogProps,
} from '../../webview/components/mcp-tools-dialog';
import { MCP_STR } from '../../webview/conduit-mcp-strings';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const session = (p: { policy?: PolicyLayer; handle?: string } = {}): Session => ({
  id: 's1',
  name: 'api',
  agentId: 'cli:claude',
  home: '/p',
  roots: [],
  status: 'running',
  createdAt: 1,
  lastActiveAt: 1,
  ...(p.policy ? { mcpToolPolicy: p.policy } : {}),
  ...(p.handle ? { mcpHandle: p.handle } : {}),
});

let root: Root | null = null;
let host: HTMLDivElement;
afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  host?.remove();
  document.body.innerHTML = '';
});

function props(p: Partial<McpToolsDialogProps> = {}): McpToolsDialogProps {
  return {
    session: session(),
    global: coerceGlobalPolicy(undefined),
    byCli: {},
    masterOn: true,
    connected: false,
    onChange: vi.fn(async () => true),
    onRelaunch: vi.fn(),
    announce: vi.fn(),
    onClose: vi.fn(),
    ...p,
  };
}

async function mount(p: McpToolsDialogProps) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<McpToolsDialog {...p} />));
}

const group = (tool: string) =>
  document.body.querySelector<HTMLElement>(
    `[role="radiogroup"][aria-label="${MCP_STR.tools.accessLabel(tool)}"]`,
  );
const radio = (tool: string, label: string) =>
  group(tool)?.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${label}"]`) ?? null;
const key = (k: string) =>
  act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
const checked = (tool: string) =>
  group(tool)?.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute('aria-label');
const errorOf = (tool: string) =>
  document.body.querySelector(`.policyrow[data-tool="${tool}"] .policyrow__error`);

const ALL = MCP_STR.tools.layerName.global;

describe('McpToolsDialog', () => {
  it('renders an access radiogroup per tool and focuses the first', async () => {
    await mount(props());
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe(MCP_STR.tools.dialogTitle('api'));
    for (const t of TOOL_NAMES) expect(group(t)).not.toBeNull();
    expect(document.body.querySelectorAll('[role="radiogroup"]')).toHaveLength(TOOL_NAMES.length);
    expect(document.activeElement).toBe(radio('list_sessions', `Inherit (On · from ${ALL})`));
  });

  it('inherit labels name the CLI from the handle', async () => {
    const byCli: CliPolicyLayers = { codex: { open_session: { access: 'off' } } };
    await mount(props({ session: session({ handle: 'codex-2' }), byCli }));
    expect(checked('open_session')).toBe('Inherit (Off · from Codex)');
    // A field the Codex layer leaves unset still comes from All CLIs.
    expect(checked('open_file')).toBe(`Inherit (On · from ${ALL})`);
    await act(async () => root?.unmount());
    // No handle: no CLI layer applies, so even a Codex layer is not consulted.
    await mount(props({ byCli }));
    expect(checked('open_session')).toBe(`Inherit (Ask · from ${ALL})`);
  });

  it('shows the session layer as set', async () => {
    await mount(props({ session: session({ policy: { open_file: { access: 'off' } } }) }));
    expect(checked('open_file')).toBe('Off');
    expect(checked('open_session')).toBe(`Inherit (Ask · from ${ALL})`);
  });

  it('picking Ask posts a one-field patch and announces', async () => {
    const p = props();
    await mount(p);
    await act(async () => radio('open_session', 'Ask')?.click());
    expect(p.onChange).toHaveBeenCalledTimes(1);
    expect(p.onChange).toHaveBeenCalledWith('open_session', { access: 'ask' });
    expect(checked('open_session')).toBe('Ask');
    expect(p.announce).toHaveBeenCalledWith(
      MCP_STR.tools.announce(MCP_STR.tools.accessLabel('open_session'), 'Ask', 'api'),
    );
    await act(async () => radio('open_session', `Inherit (Ask · from ${ALL})`)?.click());
    expect(p.onChange).toHaveBeenLastCalledWith('open_session', { access: 'inherit' });
    expect(checked('open_session')).toBe(`Inherit (Ask · from ${ALL})`);
  });

  it('a refused change reverts that tool only and shows saveFailed', async () => {
    const onChange = vi.fn(async (tool: string) => tool !== 'open_file');
    const p = props({
      session: session({ policy: { open_file: { access: 'on', when: 'always' } } }),
      onChange,
    });
    await mount(p);
    await act(async () => radio('send_message', 'Off')?.click());
    await act(async () => radio('open_file', 'Off')?.click());
    expect(onChange).toHaveBeenLastCalledWith('open_file', { access: 'off' });
    expect(checked('open_file')).toBe('On');
    expect(errorOf('open_file')?.textContent).toBe(MCP_STR.tools.saveFailed);
    expect(checked('send_message')).toBe('Off');
    expect(errorOf('send_message')).toBeNull();
    expect(p.announce).toHaveBeenCalledTimes(1);
    // A later pick on that tool clears the error while it is in flight.
    onChange.mockImplementation(async () => true);
    await act(async () => radio('open_file', 'Ask')?.click());
    expect(errorOf('open_file')).toBeNull();
    expect(checked('open_file')).toBe('Ask');
  });

  it('a late older pick cannot undo a newer one', async () => {
    const pending: ((ok: boolean) => void)[] = [];
    const p = props({ onChange: vi.fn(() => new Promise<boolean>((r) => pending.push(r))) });
    await mount(p);
    await act(async () => radio('open_file', 'Ask')?.click());
    await act(async () => radio('open_file', 'Off')?.click());
    await act(async () => pending[0](false));
    expect(checked('open_file')).toBe('Off');
    expect(errorOf('open_file')).toBeNull();
    await act(async () => pending[1](true));
    expect(checked('open_file')).toBe('Off');
  });

  it('success then failure on the same tool reverts to the confirmed value, not props', async () => {
    const pending: ((ok: boolean) => void)[] = [];
    const p = props({ onChange: vi.fn(() => new Promise<boolean>((r) => pending.push(r))) });
    await mount(p);
    await act(async () => radio('open_file', 'Ask')?.click());
    await act(async () => pending[0](true));
    await act(async () => radio('open_file', 'Off')?.click());
    await act(async () => pending[1](false));
    // Props still say Inherit: the state broadcast carrying Ask hasn't re-rendered the dialog.
    expect(checked('open_file')).toBe('Ask');
    expect(errorOf('open_file')?.textContent).toBe(MCP_STR.tools.saveFailed);
  });

  it('master off disables every control and shows the hint', async () => {
    await mount(props({ masterOn: false }));
    for (const t of TOOL_NAMES) {
      expect(group(t)?.getAttribute('aria-disabled')).toBe('true');
      for (const b of group(t)?.querySelectorAll('button') ?? []) expect(b.disabled).toBe(true);
    }
    expect(document.body.textContent).toContain(MCP_STR.tools.masterOffHint);
  });

  // Arrow-select would persist every value walked through, briefly opening open_terminal.
  it('arrows move focus without selecting; Space selects the focused option', async () => {
    const p = props();
    await mount(p);
    const inherit = `Inherit (Off · from ${ALL})`;
    radio('open_terminal', inherit)?.focus();
    await key('ArrowRight');
    expect(document.activeElement).toBe(radio('open_terminal', 'Off'));
    await key('End');
    expect(document.activeElement).toBe(radio('open_terminal', 'On'));
    expect(p.onChange).not.toHaveBeenCalled();
    expect(checked('open_terminal')).toBe(inherit);
    await key(' ');
    expect(p.onChange).toHaveBeenCalledTimes(1);
    expect(p.onChange).toHaveBeenCalledWith('open_terminal', { access: 'on' });
  });

  it('Esc calls onClose', async () => {
    const p = props();
    await mount(p);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('relaunch hint only after a change while connected', async () => {
    const relaunchButton = () =>
      [...document.body.querySelectorAll('button')].find(
        (b) => b.textContent === MCP_STR.tools.relaunch,
      );

    await mount(props({ connected: false }));
    await act(async () => radio('open_file', 'Ask')?.click());
    expect(document.body.textContent).not.toContain(MCP_STR.tools.relaunchHint);
    await act(async () => root?.unmount());
    root = null;

    const p = props({ connected: true });
    await mount(p);
    expect(relaunchButton()).toBeUndefined();
    await act(async () => radio('open_file', 'Ask')?.click());
    expect(document.body.textContent).toContain(MCP_STR.tools.relaunchHint);
    await act(async () => relaunchButton()?.click());
    expect(p.onRelaunch).toHaveBeenCalledTimes(1);
  });
});
