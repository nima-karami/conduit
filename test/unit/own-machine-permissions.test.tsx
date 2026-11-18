// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { RemotePolicyUi } from '../../src/conduit-mcp/ui-types';
import type { NetworkLinkView } from '../../src/contracts/network-state';
import { OwnMachinePermissions } from '../../webview/components/own-machine-permissions';
import type { ConduitMcpApi } from '../../webview/use-conduit-mcp';

it('edits the receiver assignment with its token and preserves its exceptions', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const assignment = { profileId: 'worker', exceptions: [], onScreenOnly: false };
  const remote = {
    machineId: 'm-1',
    name: 'Studio',
    rev: 2,
    status: 'applied',
    grants: [],
    policy: {
      editToken: 'token-2',
      assignments: [{ point: { kind: 'default' }, assignment }],
      profiles: [
        { id: 'worker', name: 'Worker' },
        { id: 'lead', name: 'Lead' },
      ],
    },
  } as unknown as RemotePolicyUi;
  const link = {
    machineId: 'm-1',
    name: 'Studio',
    state: 'up',
    capabilities: { messaging: true, monitor: false, drive: false },
  } as NetworkLinkView;
  const remoteEdit = vi.fn(async () => ({ ok: true as const }));
  const mcp = { remoteEdit } as unknown as ConduitMcpApi;
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <OwnMachinePermissions link={link} remote={remote} mcp={mcp} sshController={false} />,
    ),
  );
  expect(host.textContent).toContain('MessagingOn');
  expect(host.textContent).toContain('MonitorOff');
  const select = host.querySelector('select');
  if (!select) throw new Error('missing profile selector');
  await act(async () => {
    select.value = 'lead';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(remoteEdit).toHaveBeenCalledWith('m-1', 'token-2', {
    kind: 'assignment',
    point: { kind: 'default' },
    assignment: { ...assignment, profileId: 'lead' },
  });
  await act(async () => root.unmount());
});
