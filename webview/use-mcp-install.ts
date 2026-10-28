import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AGENT_CLIS,
  type AgentCli,
  type McpInstallRequest,
  type McpInstallResult,
  type McpInstallStatus,
} from '../src/conduit-mcp/install-types';
import { mcpInstallAct, mcpInstallStatus } from './bridge';
import { log } from './log';
import { STATUS_UNREADABLE } from './mcp-install-codes';

export interface McpInstallApi {
  /** null only while the first read for this project is in flight. */
  status: McpInstallStatus | null;
  /** The CLIs whose Check again is in flight; their last status stays in `status` meanwhile. */
  checking: ReadonlySet<AgentCli>;
  /** Re-reads all four (Check again). */
  refresh(): void;
  /** Replaces that CLI's slot with result.status; resolves null when the invoke rejected. */
  act(req: McpInstallRequest): Promise<McpInstallResult | null>;
}

// A rejected read has no per-CLI answer; each row shows it as its own error with Check again,
// because the tab has no page-level error state (spec 2026-10-27-conduit-mcp-install §8).
const NONE: ReadonlySet<AgentCli> = new Set();
const ALL: ReadonlySet<AgentCli> = new Set(AGENT_CLIS);

const unreadable = (): McpInstallStatus => ({
  clis: AGENT_CLIS.map((cli) => ({
    cli,
    found: true,
    user: { state: 'error', path: '', errorCode: STATUS_UNREADABLE },
    project: null,
  })),
});

export function useMcpInstall(projectPath: string | null): McpInstallApi {
  const [status, setStatus] = useState<McpInstallStatus | null>(null);
  const [checking, setChecking] = useState<ReadonlySet<AgentCli>>(NONE);
  // Only the newest read may land: a slow read for an old project must not overwrite a new one.
  const generation = useRef(0);
  const mounted = useRef(true);

  // A refresh keeps the last status so the rows (and the focused Check again) stay mounted; a new
  // project drops it, because the old project's entries would be wrong for the new one.
  const read = useCallback((path: string | null, keepStatus: boolean) => {
    const gen = ++generation.current;
    if (keepStatus) setChecking(ALL);
    else {
      setStatus(null);
      setChecking(NONE);
    }
    const land = (next: McpInstallStatus) => {
      if (!mounted.current || gen !== generation.current) return;
      setStatus(next);
      setChecking(NONE);
    };
    void mcpInstallStatus(path).then(land, (error: unknown) => {
      log.warn('mcp-install', 'status read failed', { error: String(error) });
      land(unreadable());
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    read(projectPath, false);
    return () => {
      mounted.current = false;
    };
  }, [projectPath, read]);

  const refresh = useCallback(() => read(projectPath, true), [projectPath, read]);

  const act = useCallback(
    async (req: McpInstallRequest): Promise<McpInstallResult | null> => {
      // The host re-reads the CLI against req.projectPath and the result replaces the whole slot,
      // so a user-scope action without it would drop that CLI's project section.
      const full =
        projectPath !== null && req.projectPath === undefined ? { ...req, projectPath } : req;
      let result: McpInstallResult;
      try {
        result = await mcpInstallAct(full);
      } catch (error) {
        log.warn('mcp-install', 'action failed', { error: String(error), cli: req.cli });
        return null;
      }
      if (mounted.current) {
        setStatus((prev) =>
          prev
            ? { clis: prev.clis.map((c) => (c.cli === result.status.cli ? result.status : c)) }
            : prev,
        );
      }
      return result;
    },
    [projectPath],
  );

  return { status, checking, refresh, act };
}
