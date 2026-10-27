import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AGENT_CLIS,
  type McpInstallRequest,
  type McpInstallResult,
  type McpInstallStatus,
} from '../src/conduit-mcp/install-types';
import { mcpInstallAct, mcpInstallStatus } from './bridge';
import { log } from './log';

export interface McpInstallApi {
  /** null while the first read is in flight. */
  status: McpInstallStatus | null;
  /** Re-reads all four (Check again). */
  refresh(): void;
  /** Replaces that CLI's slot with result.status; resolves null when the invoke rejected. */
  act(req: McpInstallRequest): Promise<McpInstallResult | null>;
}

// A rejected read has no per-CLI answer; each row shows it as its own error with Check again,
// because the tab has no page-level error state (spec 2026-10-27-conduit-mcp-install §8).
const unreadable = (): McpInstallStatus => ({
  clis: AGENT_CLIS.map((cli) => ({
    cli,
    found: true,
    user: { state: 'error', path: '', errorCode: 'EINVAL' },
    project: null,
  })),
});

export function useMcpInstall(projectPath: string | null): McpInstallApi {
  const [status, setStatus] = useState<McpInstallStatus | null>(null);
  // Only the newest read may land: a slow read for an old project must not overwrite a new one.
  const generation = useRef(0);
  const mounted = useRef(true);

  const read = useCallback((path: string | null) => {
    const gen = ++generation.current;
    setStatus(null);
    void mcpInstallStatus(path).then(
      (s) => {
        if (mounted.current && gen === generation.current) setStatus(s);
      },
      (error: unknown) => {
        log.warn('mcp-install', 'status read failed', { error: String(error) });
        if (mounted.current && gen === generation.current) setStatus(unreadable());
      },
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    read(projectPath);
    return () => {
      mounted.current = false;
    };
  }, [projectPath, read]);

  const refresh = useCallback(() => read(projectPath), [projectPath, read]);

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

  return { status, refresh, act };
}
