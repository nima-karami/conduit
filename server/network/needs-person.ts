import path from 'node:path';
import type { SshFailure } from '../../src/contracts/ssh-link';
import { isSshTarget, personSshArgv } from '../../src/network/ssh-argv';
import type { SessionCommand } from '../../src/types';
import { RpcFault } from '../transport/pipe';

// The owner's needs-person pane (plan Technical decision 3): a visible terminal running ssh, so a
// prompt the batch dial cannot answer is answered by the person. Its master lands on the dialer's
// control dir, which is why the dir is prepared by the dialer's own check.

export interface NeedsPersonOptions {
  sshPath: string;
  /** e2e only: the stand-in's leading argv, as the dialer runs it. */
  sshArgsPrefix?: string[];
  /** The dialer's controlDir(); null when no candidate fits. */
  controlDir: string | null;
  /** The dialer's prepareControlDir: creates the dir and refuses one that is not ours. */
  prepareControlDir(dir: string): SshFailure | null;
  /** Opens a visible command session in `folder`; resolves with its session id. */
  openCommand(command: SessionCommand, folder: string): Promise<string>;
  /** Where the pane's program starts. */
  home: string;
}

/** The C2 `machines.openNeedsPerson` action; the target is checked here, not only at C2. */
export function createNeedsPerson(o: NeedsPersonOptions): (target: string) => Promise<string> {
  return async (target) => {
    // Checked before the dir is touched: a refused target must not create anything.
    if (!isSshTarget(target)) throw new RpcFault('invalid', 'Expected an ssh target');
    if (o.controlDir === null) throw new RpcFault('unavailable', 'control_dir_too_long');
    const failure = o.prepareControlDir(o.controlDir);
    if (failure !== null) {
      throw new RpcFault('unavailable', 'detail' in failure ? failure.detail : failure.code);
    }
    const argv = personSshArgv({ target, controlPath: path.join(o.controlDir, '%C') });
    if ('error' in argv) throw new RpcFault('invalid', 'Expected an ssh target');
    return o.openCommand(
      { command: o.sshPath, args: [...(o.sshArgsPrefix ?? []), ...argv] },
      o.home,
    );
  };
}
