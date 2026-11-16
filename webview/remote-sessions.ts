// Remote sessions as the sidebar shows them: rows read from each ssh link's monitor snapshot,
// never local Sessions (plan CON-41 decisions 6–7).

import type { MonitorSession } from '../src/contracts/link-protocol';
import type { MachineState } from '../src/contracts/machines';
import type { NetworkState } from '../src/contracts/network-state';
import { folderKey } from '../src/folder-key';
import type { Session } from '../src/types';

export interface RemoteKey {
  machineId: string;
  sessionId: string;
}

export const remoteKeyId = (k: RemoteKey): string => `remote:${k.machineId}:${k.sessionId}`;

export interface RemoteSessionRow {
  key: RemoteKey;
  /** remoteKeyId(key): the tree navId and React key. */
  id: string;
  machineName: string;
  machineState: MachineState;
  session: MonitorSession;
  /** The local lead that opened it, or null: then it shows only under its machine. */
  parentSessionId: string | null;
}

/** The session's home and roots as folders to browse or ask about. A root equal to another by folder key shows once. */
export function remoteFolders(row: RemoteSessionRow): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [row.session.home, ...row.session.roots]) {
    if (p === '') continue;
    const key = folderKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function remoteSessionRows(
  state: NetworkState,
  localSessions: readonly Pick<Session, 'id' | 'mcpHandle'>[],
): RemoteSessionRow[] {
  const machines = new Map(state.machines.map((m) => [m.machine_id, m]));
  // A handle is the lead's address on this machine; two local sessions never share one.
  const localByHandle = new Map<string, string>();
  for (const s of localSessions) if (s.mcpHandle) localByHandle.set(s.mcpHandle, s.id);

  const rows: RemoteSessionRow[] = [];
  for (const link of state.links) {
    if (link.transport !== 'ssh' || link.snapshot === null) continue;
    const machine = machines.get(link.machineId);
    const machineName = machine?.machine ?? link.name;
    const machineState: MachineState = machine?.state ?? link.state;
    for (const session of link.snapshot.sessions) {
      const opener = session.openedBy ?? null;
      // Handles are per machine: a remote opener's handle only names a lead on the machine that opened it.
      const parentSessionId =
        opener && opener.machineId === state.machineId
          ? (localByHandle.get(opener.handle) ?? null)
          : null;
      const key: RemoteKey = { machineId: link.machineId, sessionId: session.sessionId };
      rows.push({
        key,
        id: remoteKeyId(key),
        machineName,
        machineState,
        session,
        parentSessionId,
      });
    }
  }
  return rows.sort(
    (a, b) =>
      a.machineName.localeCompare(b.machineName) || a.session.label.localeCompare(b.session.label),
  );
}
