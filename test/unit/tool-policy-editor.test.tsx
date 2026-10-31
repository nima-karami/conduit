// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  coerceGlobalPolicy,
  type PolicyLayers,
  type PolicySource,
  TOOL_NAMES,
} from '../../src/conduit-mcp/tool-policy';
import {
  ToolPolicyEditor,
  type ToolPolicyEditorProps,
} from '../../webview/components/tool-policy-editor';
import { MCP_STR } from '../../webview/conduit-mcp-strings';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The conditions dropdowns open a Popover, which measures itself; jsdom has no ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
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

const NAMES: Record<PolicySource, string> = {
  global: MCP_STR.tools.layerName.global,
  cli: MCP_STR.tools.cliName.codex,
  session: MCP_STR.tools.layerName.session,
};

function props(p: Partial<ToolPolicyEditorProps> = {}): ToolPolicyEditorProps {
  return {
    layer: 'global',
    layers: { global: coerceGlobalPolicy(undefined) },
    sourceName: (s) => NAMES[s],
    disabled: false,
    onChange: vi.fn(),
    ...p,
  };
}

async function mount(p: ToolPolicyEditorProps) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<ToolPolicyEditor {...p} />));
}

const click = (el: Element | null | undefined) =>
  act(async () => {
    if (!(el instanceof HTMLElement)) throw new Error('nothing to click');
    el.click();
  });
const group = (tool: string) =>
  document.body.querySelector<HTMLElement>(
    `[role="radiogroup"][aria-label="${MCP_STR.tools.accessLabel(tool)}"]`,
  );
const radios = (tool: string) =>
  [...(group(tool)?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])].map((b) =>
    b.getAttribute('aria-label'),
  );
const checked = (tool: string) =>
  group(tool)?.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute('aria-label');
const row = (tool: string) =>
  document.body.querySelector<HTMLElement>(`.policyrow[data-tool="${tool}"]`);
const conditions = (tool: string) =>
  row(tool)?.querySelector<HTMLButtonElement>('button.policyrow__cond') ?? null;
const field = (tool: string, f: string) =>
  document.body.querySelector<HTMLButtonElement>(
    `[aria-label="${MCP_STR.tools.fieldAria(tool, f)}"]`,
  );
const menuItems = () =>
  [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((b) =>
    b.textContent?.trim(),
  );

describe('ToolPolicyEditor', () => {
  it('renders one labelled group per tool group, each tool once', async () => {
    await mount(props());
    const groups = [...document.body.querySelectorAll('[role="group"]')];
    expect(
      groups.map(
        (g) => document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent,
      ),
    ).toEqual([
      MCP_STR.tools.group.messaging,
      MCP_STR.tools.group.sessions,
      MCP_STR.tools.group.editor,
    ]);
    for (const t of TOOL_NAMES) {
      expect(row(t)?.querySelector('code')?.textContent).toBe(t);
      expect(row(t)?.textContent).toContain(MCP_STR.tools.description[t]);
      expect(group(t)).not.toBeNull();
    }
  });

  it('global layer has no Inherit', async () => {
    await mount(props());
    expect(radios('open_session')).toEqual(['Off', 'Ask', 'On']);
    // Messaging tools are never asked about (spec §3.2).
    expect(radios('send_message')).toEqual(['Off', 'On']);
    expect(checked('open_session')).toBe('Ask');
    expect(checked('open_file')).toBe('On');
    await click(conditions('open_session'));
    expect(field('open_session', 'when')?.textContent).toBe(MCP_STR.tools.when.viewing);
    await click(field('open_session', 'when'));
    expect(menuItems()).toEqual([MCP_STR.tools.when.viewing, MCP_STR.tools.when.always]);
  });

  it('session layer shows inherited value and source', async () => {
    const global = coerceGlobalPolicy(undefined);
    const layers: PolicyLayers = {
      global,
      cli: { open_terminal: { access: 'off' }, open_session: { when: 'always' } },
      session: { open_file: { access: 'ask' } },
    };
    await mount(props({ layer: 'session', layers }));
    expect(radios('open_terminal')).toEqual(['Inherit (Off · from Codex)', 'Off', 'Ask', 'On']);
    expect(checked('open_terminal')).toBe('Inherit (Off · from Codex)');
    expect(radios('send_message')[0]).toBe('Inherit (On · from All CLIs)');
    // The session's own value is shown as set; its Inherit still names the layer below.
    expect(checked('open_file')).toBe('Ask');
    expect(radios('open_file')[0]).toBe('Inherit (On · from All CLIs)');
    await click(conditions('open_session'));
    expect(field('open_session', 'when')?.textContent).toBe('Inherit (Always · from Codex)');
    await click(field('open_session', 'when'));
    expect(menuItems()).toEqual([
      'Inherit (Always · from Codex)',
      MCP_STR.tools.when.viewing,
      MCP_STR.tools.when.always,
    ]);
  });

  it('conditions render only applicable fields', async () => {
    await mount(props({ layer: 'cli', layers: { global: coerceGlobalPolicy(undefined) } }));
    // Messaging has only access: no disclosure at all.
    expect(conditions('send_message')).toBeNull();
    const cond = conditions('open_file');
    expect(cond?.textContent).toBe(MCP_STR.tools.conditions);
    expect(cond?.getAttribute('aria-expanded')).toBe('false');
    expect(field('open_file', 'when')).toBeNull();
    await click(cond);
    expect(cond?.getAttribute('aria-expanded')).toBe('true');
    const panel = document.getElementById(cond?.getAttribute('aria-controls') ?? '');
    expect(
      [...(panel?.querySelectorAll('[data-field]') ?? [])].map((e) => e.getAttribute('data-field')),
    ).toEqual(['when']);
    expect(field('open_file', 'when')).not.toBeNull();
    expect(field('open_file', 'move')).toBeNull();
    expect(field('open_file', 'reach')).toBeNull();
    await click(conditions('open_session'));
    const sessionPanel = document.getElementById(
      conditions('open_session')?.getAttribute('aria-controls') ?? '',
    );
    expect(
      [...(sessionPanel?.querySelectorAll('[data-field]') ?? [])].map((e) =>
        e.getAttribute('data-field'),
      ),
    ).toEqual(['when', 'move']);
    // The CLI layer's Inherit names the global layer.
    expect(field('open_session', 'move')?.textContent).toBe(
      `Inherit (${MCP_STR.tools.move.yes} · from All CLIs)`,
    );
    await click(cond);
    expect(cond?.getAttribute('aria-expanded')).toBe('false');
    expect(field('open_file', 'when')).toBeNull();
  });

  it('onChange reports tool, field, value', async () => {
    const p = props({ layer: 'session', layers: { global: coerceGlobalPolicy(undefined) } });
    await mount(p);
    await click(group('open_terminal')?.querySelector('[aria-label="Ask"]'));
    expect(p.onChange).toHaveBeenLastCalledWith('open_terminal', 'access', 'ask');
    await click(conditions('open_session'));
    await click(field('open_session', 'when'));
    const always = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (b) => b.textContent?.trim() === MCP_STR.tools.when.always,
    );
    await click(always);
    expect(p.onChange).toHaveBeenLastCalledWith('open_session', 'when', 'always');
    await click(field('open_session', 'move'));
    const inherit = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (b) => b.textContent?.trim().startsWith('Inherit'),
    );
    await click(inherit);
    expect(p.onChange).toHaveBeenLastCalledWith('open_session', 'move', 'inherit');
    await click(group('read_inbox')?.querySelector('[aria-label="Inherit (On · from All CLIs)"]'));
    expect(p.onChange).toHaveBeenLastCalledWith('read_inbox', 'access', 'inherit');
  });

  it('open_terminal warning only when resolved on', async () => {
    const warn = MCP_STR.tools.onWarning.open_terminal ?? '';
    expect(warn).not.toBe('');
    const global = coerceGlobalPolicy(undefined);
    await mount(props({ layer: 'session', layers: { global } }));
    expect(row('open_terminal')?.querySelector('.policyrow__warn')).toBeNull();
    await act(async () => root?.unmount());
    // Resolved on through a lower layer still warns: the warning is about what will run.
    await mount(
      props({
        layer: 'session',
        layers: { global, cli: { open_terminal: { access: 'on' } } },
      }),
    );
    expect(row('open_terminal')?.querySelector('.policyrow__warn')?.textContent).toBe(warn);
    expect(document.body.querySelectorAll('.policyrow__warn')).toHaveLength(1);
  });

  it('close_session warns about what it destroys, not with open_terminal’s line', () => {
    expect(MCP_STR.tools.onWarning.close_session).toBe(
      'Runs without asking: closes sessions and deletes their scrollback.',
    );
  });

  it('disabled disables every control; failed tools show the save error', async () => {
    await mount(props({ disabled: true, failed: new Set(['open_file'] as const) }));
    for (const t of TOOL_NAMES) {
      expect(group(t)?.getAttribute('aria-disabled')).toBe('true');
      for (const b of group(t)?.querySelectorAll('button') ?? []) expect(b.disabled).toBe(true);
    }
    await click(conditions('open_session'));
    expect(field('open_session', 'when')?.disabled).toBe(true);
    expect(row('open_file')?.querySelector('.policyrow__error')?.textContent).toBe(
      MCP_STR.tools.saveFailed,
    );
    expect(document.body.querySelectorAll('.policyrow__error')).toHaveLength(1);
  });
});
