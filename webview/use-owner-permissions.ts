import { useCallback, useEffect, useState } from 'react';
import type { OwnerPermissionCursor, OwnerPermissionView } from '../src/conduit-mcp/request-types';
import type { ConduitMcpApi } from './use-conduit-mcp';

export function useOwnerPermissions(api: ConduitMcpApi, revision: unknown) {
  const [rows, setRows] = useState<OwnerPermissionView[]>([]);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    void revision;
    void attempt;
    let active = true;
    const load = async () => {
      try {
        const all: OwnerPermissionView[] = [];
        for (const state of ['open', 'closed'] as const) {
          let cursor: OwnerPermissionCursor | undefined;
          do {
            const page = await api.getOwnerPermissions(state, cursor);
            if (!page) throw new Error('Permission list unavailable');
            all.push(...page.permissions);
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
        }
        if (active) {
          setRows(all);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      }
    };
    setError(false);
    void load();
    return () => {
      active = false;
    };
  }, [api.getOwnerPermissions, revision, attempt]);
  return { rows, error, retry };
}
