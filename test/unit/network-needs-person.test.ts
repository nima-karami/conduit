import { describe, expect, it, vi } from 'vitest';
import { createNeedsPerson, createSetupPane } from '../../server/network/needs-person';
import { RpcFault } from '../../server/transport/pipe';
import type { SshFailure } from '../../src/contracts/ssh-link';
import { setupCommand } from '../../src/network/agent-setup-commands';
import { personSshArgv, setupSshArgv } from '../../src/network/ssh-argv';
import type { SessionCommand } from '../../src/types';

const HOME = '/home/owner';
const DIR = '/run/user/1000/conduit-ssh';

function opener(over: Partial<Parameters<typeof createNeedsPerson>[0]> = {}) {
  const openCommand = vi.fn(async (_command: SessionCommand, _folder: string) => 'sess-1');
  const prepareControlDir = vi.fn((_dir: string): SshFailure | null => null);
  const make = createNeedsPerson({
    sshPath: 'ssh',
    controlDir: DIR,
    prepareControlDir,
    openCommand,
    home: HOME,
    ...over,
  });
  return { make, openCommand, prepareControlDir };
}

describe('createNeedsPerson', () => {
  it('opens a command session running ssh with the pane argv on the shared control dir', async () => {
    const { make, openCommand, prepareControlDir } = opener();
    await expect(make('vm')).resolves.toBe('sess-1');

    expect(prepareControlDir).toHaveBeenCalledWith(DIR);
    const argv = personSshArgv({ target: 'vm', controlPath: `${DIR}/%C` });
    if (!Array.isArray(argv)) throw new Error('expected an argv');
    expect(openCommand).toHaveBeenCalledWith({ command: 'ssh', args: argv }, HOME);
  });

  it('puts the e2e stand-in prefix before the ssh arguments, as the dialer does', async () => {
    const { make, openCommand } = opener({
      sshPath: '/usr/bin/node',
      sshArgsPrefix: ['/fake.cjs'],
    });
    await make('vm');
    const session = openCommand.mock.calls[0]?.[0];
    if (!session) throw new Error('no session opened');
    expect(session.command).toBe('/usr/bin/node');
    expect(session.args.slice(0, 1)).toEqual(['/fake.cjs']);
    expect(session.args.slice(1)).toEqual(
      personSshArgv({ target: 'vm', controlPath: `${DIR}/%C` }) as string[],
    );
  });

  it('refuses with control_dir_too_long when no candidate dir fits, and opens nothing', async () => {
    const { make, openCommand, prepareControlDir } = opener({ controlDir: null });
    const err = await make('vm').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcFault);
    expect(err).toMatchObject({ kind: 'unavailable', message: 'control_dir_too_long' });
    expect(prepareControlDir).not.toHaveBeenCalled();
    expect(openCommand).not.toHaveBeenCalled();
  });

  it('refuses a control dir the dialer would refuse, and opens nothing', async () => {
    const { make, openCommand } = opener({
      prepareControlDir: () => ({ code: 'ssh_failed', detail: 'control_dir_unsafe' }),
    });
    const err = await make('vm').catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'unavailable', message: 'control_dir_unsafe' });
    expect(openCommand).not.toHaveBeenCalled();
  });

  it('refuses a target ssh would read as an option, and opens nothing', async () => {
    const { make, openCommand, prepareControlDir } = opener();
    const err = await make('-oProxyCommand=x').catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'invalid' });
    // The target is checked before the control dir is created, so a refusal leaves nothing behind.
    expect(prepareControlDir).not.toHaveBeenCalled();
    expect(openCommand).not.toHaveBeenCalled();
  });
});

describe('createSetupPane', () => {
  const VM = { target: 'vm', os: 'linux' as const, mode: 'full' as const };

  function setup(over: Partial<Parameters<typeof createSetupPane>[0]> = {}) {
    const openCommand = vi.fn(async (_command: SessionCommand, _folder: string) => 'sess-setup');
    const prepareControlDir = vi.fn((_dir: string): SshFailure | null => null);
    const make = createSetupPane({
      sshPath: 'ssh',
      controlDir: DIR,
      prepareControlDir,
      openCommand,
      home: HOME,
      machineOf: (id) => (id === 'm-vm' ? VM : null),
      ...over,
    });
    return { make, openCommand, prepareControlDir };
  }

  it('opens a visible ssh pane whose argv ends with -t, --, the target and the table command', async () => {
    const { make, openCommand } = setup();
    await expect(make('m-vm', 'claude', 'install')).resolves.toBe('sess-setup');

    const command = setupCommand('claude', 'linux', 'install');
    const argv = setupSshArgv({ target: 'vm', controlPath: `${DIR}/%C`, command });
    if (!Array.isArray(argv)) throw new Error('expected an argv');
    expect(openCommand).toHaveBeenCalledWith({ command: 'ssh', args: argv }, HOME);
    const [{ args }] = openCommand.mock.calls[0] ?? [{ args: [] }];
    expect(args.slice(-4)).toEqual(['-t', '--', 'vm', command]);
  });

  it('shares the control dir the dialer prepares, and uses the step to pick the command', async () => {
    const { make, openCommand, prepareControlDir } = setup();
    await make('m-vm', 'codex', 'login');
    expect(prepareControlDir).toHaveBeenCalledWith(DIR);
    const [{ args }] = openCommand.mock.calls[0] ?? [{ args: [] }];
    expect(args.slice(-1)).toEqual([setupCommand('codex', 'linux', 'login')]);
  });

  it('is not_found for a machine it does not know, and opens nothing', async () => {
    const { make, openCommand, prepareControlDir } = setup();
    const err = await make('m-other', 'claude', 'install').catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'not_found' });
    expect(prepareControlDir).not.toHaveBeenCalled();
    expect(openCommand).not.toHaveBeenCalled();
  });

  it('is invalid for a machine with no os recorded, and opens nothing', async () => {
    const { make, openCommand } = setup({
      machineOf: () => ({ target: 'vm', os: null, mode: null }),
    });
    const err = await make('m-vm', 'claude', 'install').catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'invalid' });
    expect(openCommand).not.toHaveBeenCalled();
  });

  it('is invalid on a light machine, which has no agent setup, and opens nothing', async () => {
    const { make, openCommand, prepareControlDir } = setup({
      machineOf: () => ({ target: 'vm', os: 'linux', mode: 'light' }),
    });
    const err = await make('m-vm', 'claude', 'install').catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'invalid' });
    expect(prepareControlDir).not.toHaveBeenCalled();
    expect(openCommand).not.toHaveBeenCalled();
  });

  it('refuses a control dir the dialer would refuse, and opens nothing', async () => {
    const { make, openCommand } = setup({
      prepareControlDir: () => ({ code: 'ssh_failed', detail: 'control_dir_unsafe' }),
    });
    const err = await make('m-vm', 'claude', 'install').catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'unavailable', message: 'control_dir_unsafe' });
    expect(openCommand).not.toHaveBeenCalled();
  });
});
