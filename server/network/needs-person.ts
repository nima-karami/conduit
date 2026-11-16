import path from 'node:path';
import type { AgentCli } from '../../src/conduit-mcp/install-types';
import type { AgentSetupStep, MachineMode } from '../../src/contracts/machines';
import type { SshFailure } from '../../src/contracts/ssh-link';
import { setupCommand } from '../../src/network/agent-setup-commands';
import { isSshTarget, personSshArgv, setupSshArgv } from '../../src/network/ssh-argv';
import type { SessionCommand } from '../../src/types';
import { RpcFault } from '../transport/pipe';

// The owner's visible ssh panes (plan Technical decision 3): a terminal running ssh, so a prompt the
// batch dial cannot answer is answered by the person, or a fixed setup command runs on the machine.
// Their master lands on the dialer's control dir, which is why every pane shares the dialer's own
// check on that dir.

export interface PaneOptions {
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

export type NeedsPersonOptions = PaneOptions;

/** The machine a setup pane runs on: its ssh target, and what its block says of OS and mode. */
export interface SetupMachine {
  target: string;
  os: 'linux' | 'windows' | null;
  mode: MachineMode | null;
}

export interface SetupPaneOptions extends PaneOptions {
  /** The ssh machine a pane id names, or null when there is none. */
  machineOf(machineId: string): SetupMachine | null;
}

/**
 * The control path a pane's master uses. Refusals come before anything is created, and the dir is
 * the dialer's own check, so a pane never opens a master the batch dial would refuse.
 */
function paneControlPath(o: PaneOptions): string {
  if (o.controlDir === null) throw new RpcFault('unavailable', 'control_dir_too_long');
  const failure = o.prepareControlDir(o.controlDir);
  if (failure !== null) {
    throw new RpcFault('unavailable', 'detail' in failure ? failure.detail : failure.code);
  }
  return path.join(o.controlDir, '%C');
}

function openPane(o: PaneOptions, argv: string[]): Promise<string> {
  return o.openCommand({ command: o.sshPath, args: [...(o.sshArgsPrefix ?? []), ...argv] }, o.home);
}

/** The C2 `machines.openNeedsPerson` action; the target is checked here, not only at C2. */
export function createNeedsPerson(o: NeedsPersonOptions): (target: string) => Promise<string> {
  return async (target) => {
    // Checked before the dir is touched: a refused target must not create anything.
    if (!isSshTarget(target)) throw new RpcFault('invalid', 'Expected an ssh target');
    const controlPath = paneControlPath(o);
    const argv = personSshArgv({ target, controlPath });
    if ('error' in argv) throw new RpcFault('invalid', 'Expected an ssh target');
    return openPane(o, argv);
  };
}

/**
 * The C2 `machines.openSetupPane` action (plan decision 1): a visible terminal on the machine that
 * runs one fixed setup command. A light machine has no agent setup, so it is refused.
 */
export function createSetupPane(
  o: SetupPaneOptions,
): (machineId: string, cli: AgentCli, step: AgentSetupStep) => Promise<string> {
  return async (machineId, cli, step) => {
    const machine = o.machineOf(machineId);
    if (machine === null) throw new RpcFault('not_found', `No machine ${machineId}`);
    if (machine.os === null) {
      throw new RpcFault('invalid', 'The machine has no os recorded; connect it first');
    }
    if (machine.mode === 'light')
      throw new RpcFault('invalid', 'A light machine has no agent setup');
    // Checked before the dir is touched, as the needs-person pane does.
    if (!isSshTarget(machine.target)) throw new RpcFault('invalid', 'Expected an ssh target');
    const controlPath = paneControlPath(o);
    const argv = setupSshArgv({
      target: machine.target,
      controlPath,
      command: setupCommand(cli, machine.os, step),
    });
    if ('error' in argv) throw new RpcFault('invalid', 'Expected an ssh target');
    return openPane(o, argv);
  };
}
