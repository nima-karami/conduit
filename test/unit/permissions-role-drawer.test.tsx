// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { BUILT_IN_PROFILES } from '../../src/conduit-mcp/policy-profiles';
import type { Profile } from '../../src/conduit-mcp/policy-types';
import { TOOL_GROUPS } from '../../src/conduit-mcp/tool-policy';
import {
  PermissionsRoleDrawer,
  type PermissionsRoleDrawerProps,
} from '../../webview/components/permissions-role-drawer';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  document.body.innerHTML = '';
});

const custom: Profile = {
  ...structuredClone(BUILT_IN_PROFILES[1]),
  id: 'p-custom',
  name: 'Custom',
  builtIn: false,
};

async function mount(profile: Profile, over: Partial<PermissionsRoleDrawerProps> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const props: PermissionsRoleDrawerProps = {
    profile,
    used: 2,
    readOnly: false,
    onClose: vi.fn(),
    onDuplicate: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
  await act(async () => root.render(<PermissionsRoleDrawer {...props} />));
  return { host, props };
}
const labels = (host: HTMLElement) =>
  [...host.querySelectorAll('button')].map((b) => b.textContent);

it('shows a built-in read-only with only Duplicate role', async () => {
  const { host, props } = await mount(BUILT_IN_PROFILES[0]);
  expect(host.textContent).toContain(
    "Built-in roles can't be edited. Duplicate it to make your own.",
  );
  expect(host.textContent).toContain('Built-in');
  expect(host.textContent).toContain('Used by 2 agents');
  expect(labels(host)).toContain('Duplicate role');
  for (const absent of ['Edit', 'Delete', 'Duplicate']) expect(labels(host)).not.toContain(absent);
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Duplicate role',
  );
  await act(async () => button?.click());
  expect(props.onDuplicate).toHaveBeenCalledWith(BUILT_IN_PROFILES[0]);
});

it('shows a custom role with Edit, Duplicate and Delete', async () => {
  const { host, props } = await mount(custom);
  expect(host.textContent).toContain('Custom role.');
  expect(host.textContent).not.toContain("can't be edited");
  expect(labels(host)).toEqual(expect.arrayContaining(['Edit', 'Duplicate', 'Delete']));
  expect(labels(host)).not.toContain('Duplicate role');
  for (const [name, fn] of [
    ['Edit', props.onEdit],
    ['Duplicate', props.onDuplicate],
    ['Delete', props.onDelete],
  ] as const) {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === name);
    await act(async () => button?.click());
    expect(fn).toHaveBeenCalledWith(custom);
  }
});

it('lists every tool under its group with the decision as a word', async () => {
  const observer = BUILT_IN_PROFILES[0];
  const { host } = await mount(observer);
  const groups = [...host.querySelectorAll('details')];
  expect(groups).toHaveLength(TOOL_GROUPS.length);
  const word = { allow: 'Allow', ask: 'Ask', deny: 'Deny' };
  TOOL_GROUPS.forEach(({ tools }, index) => {
    const items = [...groups[index].querySelectorAll('li')];
    expect(items).toHaveLength(tools.length);
    tools.forEach((tool, i) => {
      expect(items[i].querySelector('code')?.textContent).toBe(tool);
      expect(items[i].querySelector('[data-decision]')?.textContent).toBe(
        word[observer.rules[tool].decision],
      );
    });
  });
  const decisions = new Set(
    TOOL_GROUPS.flatMap(({ tools }) => tools.map((tool) => observer.rules[tool].decision)),
  );
  expect(decisions.size).toBeGreaterThan(1);
});

it('disables Delete while read-only', async () => {
  const { host } = await mount(custom, { readOnly: true });
  const del = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Delete');
  expect(del?.disabled).toBe(true);
});

it('moves focus to its heading on mount and closes from the close button', async () => {
  const { host, props } = await mount(custom);
  expect(document.activeElement).toBe(host.querySelector('h4'));
  const close = host.querySelector<HTMLButtonElement>('[aria-label="Close"]');
  await act(async () => close?.click());
  expect(props.onClose).toHaveBeenCalledOnce();
});

it('registers nothing on the overlay stack', () => {
  const source = readFileSync('webview/components/permissions-role-drawer.tsx', 'utf8');
  expect(source).not.toContain('useOverlayEntry');
});
