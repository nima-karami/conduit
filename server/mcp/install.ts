import type { ConduitMcpHostDeps } from '../../src/conduit-mcp/host';
import {
  createMcpInstall,
  type GateRow,
  type McpInstallDeps,
  migrateGateOnce,
} from '../../src/conduit-mcp/install';
import {
  AGENT_CLIS,
  coerceInstallRequest,
  type McpInstallResult,
} from '../../src/conduit-mcp/install-types';
import { RpcFault } from '../transport/pipe';

/** An exe + shim pair a previous build wrote into CLI entries. */
export interface PreviousShim {
  execPath: string;
  shimPath: string;
}

/**
 * W0b's install module on the server, pointed at the write-once runtime shim (D2b). The migration
 * moves only entries that are exactly what this install wrote for a previous shim path: an entry of
 * another Conduit build keeps pointing at its own.
 */
export function createServerInstall(
  deps: McpInstallDeps & { log: Pick<ConduitMcpHostDeps['log'], 'info' | 'warn'> },
) {
  const current = createMcpInstall(deps);

  const migrate = (previous: readonly PreviousShim[]): GateRow[] => {
    const rows: GateRow[] = [];
    for (const prev of previous) {
      const old = createMcpInstall({ ...deps, ...prev });
      for (const cli of AGENT_CLIS) {
        if (old.userState(cli) !== 'installed') continue;
        const r = current.act({ cli, scope: 'user', action: 'install' });
        rows.push({
          cli,
          path: r.status.user.path,
          ...(r.ok ? {} : { errorCode: r.errorCode }),
        });
      }
    }
    return rows;
  };

  const logRows = (what: string, rows: readonly GateRow[]) => {
    for (const r of rows) {
      if (r.errorCode) deps.log.warn('mcp-install', `${what} failed`, r);
      else deps.log.info('mcp-install', what, r);
    }
  };

  return {
    status: current.status,
    userState: current.userState,
    act(request: unknown): McpInstallResult {
      const req = coerceInstallRequest(request);
      if (!req) throw new RpcFault('invalid', 'invalid mcp install request');
      return current.act(req);
    },
    /** The packaged startup pass, as main.ts runs it today, after the migration. */
    startup(opts: { previous: readonly PreviousShim[]; gateMigrated: boolean }) {
      const migrated = migrate(opts.previous);
      logRows('migrated', migrated);
      const repaired = current.repair();
      logRows('repaired', repaired);
      const gate = migrateGateOnce(opts.gateMigrated, current);
      logRows('permission rule added', gate.rows);
      return { gateMigrated: gate.done, rows: [...migrated, ...repaired, ...gate.rows] };
    },
  };
}
