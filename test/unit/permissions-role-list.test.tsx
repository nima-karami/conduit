// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { BUILT_IN_PROFILES } from '../../src/conduit-mcp/policy-profiles';
import type { Profile } from '../../src/conduit-mcp/policy-types';
import { TOOL_GROUPS } from '../../src/conduit-mcp/tool-policy';
import {
  PermissionsRoleList,
  type PermissionsRoleListProps,
} from '../../webview/components/permissions-role-list';

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

async function mount(over: Partial<PermissionsRoleListProps> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const props: PermissionsRoleListProps = {
    profiles: [...BUILT_IN_PROFILES, custom],
    selectedId: null,
    usage: new Map([
      ['worker', 3],
      ['p-custom', 1],
    ]),
    newAgentRole: 'worker',
    readOnly: false,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    ...over,
  };
  await act(async () => root.render(<PermissionsRoleList {...props} />));
  return { host, props };
}

const rows = (host: HTMLElement) => [...host.querySelectorAll('tbody tr')];

it('draws one row per role with the new-agents tag on the right one', async () => {
  const { host } = await mount();
  expect(rows(host)).toHaveLength(BUILT_IN_PROFILES.length + 1);
  const tagged = rows(host).filter((r) => r.textContent?.includes('New agents start here'));
  expect(tagged).toHaveLength(1);
  expect(tagged[0].textContent).toContain('Worker');
});

it('moves the tag when the new-agents role changes', async () => {
  const { host } = await mount({ newAgentRole: 'p-custom' });
  const tagged = rows(host).filter((r) => r.textContent?.includes('New agents start here'));
  expect(tagged).toHaveLength(1);
  expect(tagged[0].textContent).toContain('Custom');
});

it('shows one text pill per tool group in every row', async () => {
  const { host } = await mount();
  for (const row of rows(host)) {
    const pills = [...row.querySelectorAll('.permissions-pill')];
    expect(pills).toHaveLength(TOOL_GROUPS.length);
    for (const pill of pills) {
      expect(['Allowed', 'Mixed', 'Denied']).toContain(pill.textContent);
      expect(pill.getAttribute('data-state')).toBe(pill.textContent?.toLowerCase());
    }
  }
});

it('says how many agents use each role and which type it is', async () => {
  const { host } = await mount();
  expect(rows(host)[1].textContent).toContain('Used by 3 agents');
  expect(rows(host)[3].textContent).toContain('Used by 1 agent');
  expect(rows(host)[3].textContent).not.toContain('Used by 1 agents');
  expect(rows(host)[0].textContent).toContain('Built-in');
  expect(rows(host)[3].textContent).toContain('Custom');
});

it('marks the selected row and reports a click', async () => {
  const { host, props } = await mount({ selectedId: 'p-custom' });
  expect(rows(host).map((r) => r.getAttribute('aria-current'))).toEqual([null, null, null, 'true']);
  await act(async () => (rows(host)[2] as HTMLElement).click());
  expect(props.onSelect).toHaveBeenCalledWith(BUILT_IN_PROFILES[2]);
});

it('selects a row from the keyboard', async () => {
  const { host, props } = await mount();
  await act(async () =>
    rows(host)[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  expect(props.onSelect).toHaveBeenCalledWith(BUILT_IN_PROFILES[0]);
});

it('offers New role unless read-only', async () => {
  const { host, props } = await mount();
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'New role');
  await act(async () => button?.click());
  expect(props.onNew).toHaveBeenCalledOnce();
  const ro = await mount({ readOnly: true });
  const disabled = [...ro.host.querySelectorAll('button')].find(
    (b) => b.textContent === 'New role',
  );
  expect(disabled?.disabled).toBe(true);
});

const css = readFileSync('webview/styles.css', 'utf8');
const mediaBlock = (query: string) => {
  const start = css.indexOf(`@media (${query}) {`);
  expect(start).toBeGreaterThan(-1);
  const end = css.indexOf('\n}\n', start);
  return css.slice(start, end);
};

it('keeps the editor group counts out of the list media rules', () => {
  const editor = readFileSync('webview/components/permissions-profile-editor.tsx', 'utf8');
  expect(editor).not.toContain('permissions-role-list__');
  expect(editor).toContain('permissions-editor__counts');
  expect(mediaBlock('max-width: 1099px')).not.toContain('permissions-editor__counts');
  expect(mediaBlock('min-width: 1100px')).not.toContain('permissions-editor__counts');
});

it('drops the group summary columns below 1100px so the list needs no horizontal scroll', async () => {
  const { host } = await mount();
  const groupCells = host.querySelectorAll('.permissions-role-list__group');
  expect(groupCells).toHaveLength((BUILT_IN_PROFILES.length + 2) * TOOL_GROUPS.length);
  expect(mediaBlock('max-width: 1099px')).toMatch(
    /\.permissions-role-list__group\s*\{\s*display: none;/,
  );
});

it('is a plain table whose rows are focusable and select on Space', async () => {
  const { host, props } = await mount();
  expect(host.querySelector('[role="grid"]')).toBeNull();
  expect(host.querySelector('table')?.getAttribute('role')).toBeNull();
  expect(rows(host).every((r) => r.getAttribute('tabindex') === '0')).toBe(true);
  await act(async () =>
    rows(host)[1].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })),
  );
  expect(props.onSelect).toHaveBeenCalledWith(BUILT_IN_PROFILES[1]);
});
