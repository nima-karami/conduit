// Remote sessions as the sidebar shows them: rows read from each ssh link's monitor snapshot,
// never local Sessions (plan CON-41 decisions 6–7).

import type { MonitorSession } from '../src/contracts/link-protocol';
import type { MachineState } from '../src/contracts/machines';
import type { NetworkState } from '../src/contracts/network-state';
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

export function remoteSessionRows(
  state: NetworkState,
  localSessions: readonly Pick<Session, 'id' | 'mcpHandle'>[],
): RemoteSessionRow[] {
  throw new Error(
    `remoteSessionRows: built in plan CON-41 Task 3 (${state.machineId}, ${localSessions.length})`,
  );
}
