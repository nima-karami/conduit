// Node-free. The one place a machine error becomes the agent-facing tool error; hints follow spec
// 5.2 (the spec gives text only for ssh_needs_person and the retry column, so the rest are ours).
import type { MachineError } from '../contracts/machines';
import { type ToolError, toolError } from './types';

export function machineToolError(e: MachineError, machine: string): ToolError {
  switch (e.code) {
    case 'machine_unknown': {
      // An ambiguous name lists its candidate ids: the retry is one of them (plan decision 5).
      if (e.candidates !== undefined) {
        return toolError(
          'machine_unknown',
          `more than one machine is named ${machine}`,
          undefined,
          {
            hint: `several machines share that name; retry with one of these ids: ${e.candidates.join(', ')}`,
            valid: e.candidates,
          },
        );
      }
      return toolError('machine_unknown', `no machine is called ${machine}`, undefined, {
        hint: 'name a machine from list_machines, or an ssh Host from your ssh config',
      });
    }
    case 'ssh_needs_person':
      return toolError(
        'ssh_needs_person',
        `ssh needs a person to answer (${e.detail.reason ?? 'unknown'}) before it can reach ${machine}`,
        undefined,
        { hint: `ask the human to connect ${machine} once from Machines` },
      );
    case 'ssh_unreachable':
      return toolError('ssh_unreachable', `${machine} can't be reached over ssh`, undefined, {
        hint: 'the machine may be asleep or offline; try again shortly',
      });
    case 'ssh_auth_failed':
      return toolError('ssh_auth_failed', `ssh refused the keys for ${machine}`, undefined, {
        hint: `the keys for ${machine} were refused; the human must fix ssh access and connect it once from Machines`,
      });
    case 'remote_unsupported':
      return toolError(
        'remote_unsupported',
        `Conduit has no build for ${e.detail.os ?? 'this OS'} ${e.detail.arch ?? 'this CPU'}`,
        undefined,
        {
          hint: 'Conduit has no build for that platform yet; it runs on linux x64 and windows x64',
        },
      );
    case 'install_failed':
      return toolError(
        'install_failed',
        `installing Conduit on ${machine} failed at its ${e.detail.step ?? 'unknown'} step`,
        undefined,
        {
          hint: `the install did not finish at its ${e.detail.step ?? 'unknown'} step; try again shortly`,
        },
      );
    case 'identity_changed':
      return toolError(
        'identity_changed',
        `${machine}'s identity changed since it was added`,
        undefined,
        {
          hint: `${machine}'s identity changed since it was added; the human must confirm it from Machines`,
        },
      );
    case 'identity_conflict': {
      // The producer names the record this target collides with (link-manager pinSshPeer).
      const existing = e.detail.machine ?? 'another machine';
      return toolError(
        'identity_conflict',
        `${machine} is a machine already added as ${existing}`,
        undefined,
        {
          hint: `this target reaches a machine already added as "${existing}"; connect it by that name`,
        },
      );
    }
    case 'peer_incompatible':
      return toolError(
        'peer_incompatible',
        `${machine} runs an incompatible Conduit version`,
        undefined,
        {
          hint: 'the machine runs a Conduit version that cannot talk to this one; update the older side',
        },
      );
  }
}
