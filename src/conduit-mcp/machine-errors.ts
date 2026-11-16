// Node-free. The one place a machine error becomes the agent-facing tool error; hints follow spec
// 5.2 (the spec gives text only for ssh_needs_person and the retry column, so the rest are ours).
import type { MachineError } from '../contracts/machines';
import { type ToolError, toolError } from './types';

/** A detail value as a string, or undefined when the producer left it null. */
const text = (v: string | null | undefined): string | undefined => v ?? undefined;

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
      // A revoked machine was added and then removed: that is not the same as never added.
      if (e.detail.reason === 'revoked') {
        return toolError(
          'machine_unknown',
          `${machine} was removed from this machine's links`,
          undefined,
          {
            hint: 'connect it again from Machines to add it back',
          },
        );
      }
      return toolError('machine_unknown', `no machine is called ${machine}`, undefined, {
        hint: 'name a machine from list_machines, or an ssh Host from your ssh config',
      });
    }
    case 'ssh_needs_person': {
      const reason = text(e.detail.reason) ?? 'unknown';
      return toolError(
        'ssh_needs_person',
        `ssh needs a person to answer (${reason}) before it can reach ${machine}`,
        undefined,
        { hint: `ask the human to connect ${machine} once from Machines`, reason },
      );
    }
    case 'ssh_unreachable':
      return toolError('ssh_unreachable', `${machine} can't be reached over ssh`, undefined, {
        hint: 'the machine may be asleep or offline; try again shortly',
      });
    case 'ssh_auth_failed':
      return toolError('ssh_auth_failed', `ssh refused the keys for ${machine}`, undefined, {
        hint: `the keys for ${machine} were refused; the human must fix ssh access and connect it once from Machines`,
      });
    case 'remote_unsupported': {
      const os = text(e.detail.os) ?? 'this OS';
      const arch = text(e.detail.arch) ?? 'this CPU';
      return toolError('remote_unsupported', `Conduit has no build for ${os} ${arch}`, undefined, {
        hint: 'Conduit has no build for that platform yet; it runs on linux x64 and windows x64',
        os,
        arch,
      });
    }
    case 'install_failed': {
      const step = text(e.detail.step) ?? 'unknown';
      return toolError(
        'install_failed',
        `installing Conduit on ${machine} failed at its ${step} step`,
        undefined,
        { hint: `the install did not finish at its ${step} step; try again shortly`, step },
      );
    }
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
      const existing = text(e.detail.machine) ?? 'another machine';
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
