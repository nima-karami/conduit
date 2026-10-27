// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MCP_TOOLS,
  type McpToolOverrides,
  TOOL_NAMES,
} from '../../src/conduit-mcp/tool-switches';
import type { Session } from '../../src/types';
import {
  McpToolsDialog,
  type McpToolsDialogProps,
} from '../../webview/components/mcp-tools-dialog';
import { MCP_STR } from '../../webview/conduit-mcp-strings';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const session = (overrides?: McpToolOverrides): Session => ({
  id: 's1',
  name: 'api',
  agentId: 'cli:claude',
  home: '/p',
  roots: [],
  status: 'running',
  createdAt: 1,
  lastActiveAt: 1,
  ...(overrides ? { mcpToolOverrides: overrides } : {}),
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
    global: { ...DEFAULT_MCP_TOOLS },
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
  document.body.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${tool}"]`);
const radio = (tool: string, label: string) =>
  group(tool)?.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${label}"]`) ?? null;
const key = (k: string) =>
  act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
const checked = (tool: string) =>
  group(tool)?.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute('aria-label');

describe('McpToolsDialog', () => {
  it('renders a radiogroup per tool, labelled by the tool name', async () => {
    await mount(props());
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe(MCP_STR.tools.dialogTitle('api'));
    for (const t of TOOL_NAMES) expect(group(t)).not.toBeNull();
    expect(document.body.querySelectorAll('[role="radiogroup"]')).toHaveLength(TOOL_NAMES.length);
    // Initial focus is the first radiogroup's selected option.
    expect(document.activeElement).toBe(radio('list_sessions', 'Inherit (On)'));
  });

  it('Inherit label shows the global value', async () => {
    await mount(props({ session: session({ open_file: true }) }));
    expect(radio('list_sessions', 'Inherit (On)')).not.toBeNull();
    expect(radio('open_session', 'Inherit (Off)')).not.toBeNull();
    expect(checked('open_session')).toBe('Inherit (Off)');
    expect(checked('open_file')).toBe('On');
  });

  it('picking Off calls onChange(tool, false) and announces', async () => {
    const p = props();
    await mount(p);
    await act(async () => radio('send_message', 'Off')?.click());
    expect(p.onChange).toHaveBeenCalledWith('send_message', false);
    expect(checked('send_message')).toBe('Off');
    expect(p.announce).toHaveBeenCalledWith(MCP_STR.tools.announce('send_message', 'Off', 'api'));
  });

  it('onChange false reverts the selection and shows the save error', async () => {
    const p = props({ session: session({ open_file: true }), onChange: vi.fn(async () => false) });
    await mount(p);
    await act(async () => radio('open_file', 'Off')?.click());
    expect(p.onChange).toHaveBeenCalledWith('open_file', false);
    expect(checked('open_file')).toBe('On');
    expect(document.body.textContent).toContain(MCP_STR.tools.saveFailed);
    expect(p.announce).not.toHaveBeenCalled();
  });

  it('master off disables all groups and shows the hint', async () => {
    await mount(props({ masterOn: false }));
    for (const t of TOOL_NAMES) {
      expect(group(t)?.getAttribute('aria-disabled')).toBe('true');
      for (const b of group(t)?.querySelectorAll('button') ?? []) expect(b.disabled).toBe(true);
    }
    expect(document.body.textContent).toContain(MCP_STR.tools.masterOffHint);
  });

  // Spec §9: arrows move, Space selects. Arrow-select would persist every value walked through
  // (Inherit → On → Off), briefly opening open_terminal.
  it('arrows move focus without selecting; Space and Enter select the focused option', async () => {
    const p = props();
    await mount(p);
    radio('open_terminal', 'Inherit (Off)')?.focus();
    await key('ArrowRight');
    expect(document.activeElement).toBe(radio('open_terminal', 'On'));
    expect(p.onChange).not.toHaveBeenCalled();
    expect(checked('open_terminal')).toBe('Inherit (Off)');
    expect(radio('open_terminal', 'On')?.tabIndex).toBe(0);
    expect(radio('open_terminal', 'Inherit (Off)')?.tabIndex).toBe(-1);
    await key('ArrowRight');
    await key('End');
    expect(document.activeElement).toBe(radio('open_terminal', 'Off'));
    expect(p.onChange).not.toHaveBeenCalled();
    await key(' ');
    expect(p.onChange).toHaveBeenCalledTimes(1);
    expect(p.onChange).toHaveBeenCalledWith('open_terminal', false);
    expect(checked('open_terminal')).toBe('Off');
    await key('Home');
    await key('Enter');
    expect(p.onChange).toHaveBeenCalledTimes(2);
    expect(p.onChange).toHaveBeenLastCalledWith('open_terminal', 'inherit');
  });

  it('focus leaving a group puts its tab stop back on the selected option', async () => {
    await mount(props());
    radio('open_terminal', 'Inherit (Off)')?.focus();
    await key('ArrowRight');
    await act(async () => radio('open_file', 'Inherit (Off)')?.focus());
    expect(radio('open_terminal', 'Inherit (Off)')?.tabIndex).toBe(0);
    expect(radio('open_terminal', 'On')?.tabIndex).toBe(-1);
  });

  it('only the newest pick per tool can revert', async () => {
    const pending: ((ok: boolean) => void)[] = [];
    const p = props({ onChange: vi.fn(() => new Promise<boolean>((r) => pending.push(r))) });
    await mount(p);
    await act(async () => radio('open_file', 'On')?.click());
    await act(async () => radio('open_file', 'Off')?.click());
    await act(async () => pending[0](false));
    expect(checked('open_file')).toBe('Off');
    expect(document.body.textContent).not.toContain(MCP_STR.tools.saveFailed);
    await act(async () => pending[1](true));
    expect(checked('open_file')).toBe('Off');
  });

  it('success then failure on the same tool reverts to the confirmed value, not props', async () => {
    const pending: ((ok: boolean) => void)[] = [];
    const p = props({ onChange: vi.fn(() => new Promise<boolean>((r) => pending.push(r))) });
    await mount(p);
    await act(async () => radio('open_file', 'On')?.click());
    await act(async () => pending[0](true));
    await act(async () => radio('open_file', 'Off')?.click());
    await act(async () => pending[1](false));
    // Props still say Inherit: the state broadcast carrying On hasn't re-rendered the dialog.
    expect(checked('open_file')).toBe('On');
    expect(document.body.textContent).toContain(MCP_STR.tools.saveFailed);
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

    const offline = props({ connected: false });
    await mount(offline);
    await act(async () => radio('open_file', 'On')?.click());
    expect(document.body.textContent).not.toContain(MCP_STR.tools.relaunchHint);
    await act(async () => root?.unmount());
    root = null;

    const p = props({ connected: true });
    await mount(p);
    expect(document.body.textContent).not.toContain(MCP_STR.tools.relaunchHint);
    expect(relaunchButton()).toBeUndefined();
    await act(async () => radio('open_file', 'On')?.click());
    expect(document.body.textContent).toContain(MCP_STR.tools.relaunchHint);
    await act(async () => relaunchButton()?.click());
    expect(p.onRelaunch).toHaveBeenCalledTimes(1);
  });
});
