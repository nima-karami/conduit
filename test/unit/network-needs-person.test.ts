import { describe, expect, it, vi } from 'vitest';
import { createNeedsPerson } from '../../server/network/needs-person';
import { RpcFault } from '../../server/transport/pipe';
import type { SshFailure } from '../../src/contracts/ssh-link';
import { personSshArgv } from '../../src/network/ssh-argv';
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
    const { make, openCommand } = opener();
    const err = await make('-oProxyCommand=x').catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'invalid' });
    expect(openCommand).not.toHaveBeenCalled();
  });
});
