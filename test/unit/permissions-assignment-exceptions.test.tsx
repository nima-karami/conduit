// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Assignment } from '../../src/conduit-mcp/policy-types';
import { PermissionsAssignmentExceptions } from '../../webview/components/permissions-assignment-exceptions';

it('edits only supported fields and scopes while preserving the rest of the assignment', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const initial: Assignment = {
    profileId: 'worker',
    onScreenOnly: true,
    applyNative: true,
    pinned: ['focus_session.reach'],
    exceptions: [{ tool: 'focus_session', scope: { kind: 'anywhere' }, rule: { decision: 'ask' } }],
  };
  const changed = vi.fn();
  function Wrapper() {
    const [draft, setDraft] = useState(initial);
    return (
      <PermissionsAssignmentExceptions
        assignment={draft}
        disabled={false}
        onChange={(next) => {
          changed(next);
          setDraft(next);
        }}
      />
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Wrapper />));
  const field = (text: string) => {
    const label = [...host.querySelectorAll('label')].find((item) =>
      item.textContent?.trim().startsWith(text),
    );
    const select =
      label?.querySelector('select') ??
      (label?.htmlFor ? host.querySelector(`#${label.htmlFor}`) : null);
    if (!(select instanceof HTMLSelectElement)) throw new Error(`Missing ${text}`);
    return select;
  };
  const choose = async (select: HTMLSelectElement, value: string) =>
    act(async () => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  await choose(field('reach'), 'opened');
  await choose(field('when'), 'always');
  await choose(field('move'), 'no');
  expect(changed.mock.lastCall?.[0]).toMatchObject({
    ...initial,
    exceptions: [
      {
        tool: 'focus_session',
        rule: { decision: 'ask', reach: 'opened', when: 'always', move: 'no' },
      },
    ],
  });
  await choose(field('Scope'), 'path');
  const path = [...host.querySelectorAll('label')]
    .find((item) => item.textContent?.includes('Absolute path'))
    ?.querySelector('input');
  if (!path) throw new Error('Missing path');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(path, '/work/a');
    path.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find((item) => item.textContent === text);
  await act(async () => button('Apply target')?.click());
  expect(changed.mock.lastCall?.[0].exceptions[0].scope).toEqual({ kind: 'path', path: '/work/a' });
  await choose(field('Action'), 'list_agents');
  const addFields = [...host.querySelectorAll('fieldset')].find(
    (item) => item.querySelector('legend')?.textContent === 'Add exception',
  );
  const decision = [...(addFields?.querySelectorAll('label') ?? [])]
    .find((item) => item.textContent?.startsWith('Decision'))
    ?.querySelector('select');
  expect([...(decision?.options ?? [])].map((option) => option.value)).not.toContain('ask');
  await act(async () => button('Add exception')?.click());
  expect(changed.mock.lastCall?.[0].exceptions).toHaveLength(2);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label^="Remove exception 1"]')?.click(),
  );
  expect(changed.mock.lastCall?.[0].exceptions).toHaveLength(1);
  await act(async () => root.unmount());
  host.remove();
});
