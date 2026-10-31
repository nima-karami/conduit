import { useEffect, useRef } from 'react';
import { canonicalPath } from '../src/canonical-path';
import {
  type CloseFilesOutcome,
  MAX_CLOSE_RESULTS,
  MAX_UNSAVED_PATHS,
  type McpReviewSource,
  type McpUiAction,
  type McpUiResult,
} from '../src/conduit-mcp/ui-types';
import type { CommitNode } from '../src/protocol';
import { post, subscribe } from './bridge';
import type { OpenDoc } from './docs';

// The renderer half of mcp:ui (spec 2026-10-30-conduit-mcp-app-control §2.3). The host has
// already applied policy, reach and routing; this only does what the matching UI action does,
// for the session it was told, and reports what happened.

export interface McpUiHandlers {
  hasSession(sessionId: string): boolean;
  dirtyPathsOf(sessionId: string): string[];
  kill(sessionId: string): void;
  closeFiles(sessionId: string, target: readonly string[] | 'all'): Promise<CloseFilesOutcome>;
  openReview(sessionId: string, source: McpReviewSource): void;
  openGitHistory(sessionId: string, repoRoot: string, commit: CommitNode | null): void;
  openUrl(sessionId: string, url: string, focus: boolean): void;
}

function answer(requestId: string, result: McpUiResult): void {
  post({ type: 'mcp:uiResult', requestId, result });
}

function handle(h: McpUiHandlers, requestId: string, sessionId: string, action: McpUiAction) {
  if (!h.hasSession(action.kind === 'closeSession' ? action.target : sessionId)) {
    answer(requestId, { kind: 'unknownSession' });
    return;
  }
  switch (action.kind) {
    case 'closeSession': {
      const dirty = h.dirtyPathsOf(action.target);
      if (dirty.length > 0) {
        answer(requestId, {
          kind: 'closeSession',
          ok: false,
          unsaved: dirty.slice(0, MAX_UNSAVED_PATHS),
        });
        return;
      }
      // The answer goes first: a session closing itself loses its MCP connection with the kill,
      // and the host only writes a reply it already holds (plan "SELF CLOSE").
      answer(requestId, { kind: 'closeSession', ok: true });
      h.kill(action.target);
      return;
    }
    case 'closeFiles':
      void h
        .closeFiles(sessionId, action.paths)
        .then((outcome) => answer(requestId, { kind: 'closeFiles', ...outcome }));
      return;
    case 'openReview':
      h.openReview(sessionId, action.source);
      break;
    case 'openGitHistory':
      h.openGitHistory(sessionId, action.repoRoot, action.commit);
      break;
    case 'openUrl':
      h.openUrl(sessionId, action.url, action.focus);
      break;
  }
  answer(requestId, { kind: 'opened' });
}

export function useMcpUi(h: McpUiHandlers): void {
  const ref = useRef(h);
  ref.current = h;
  useEffect(
    () =>
      subscribe((m) => {
        if (m.type === 'mcp:ui') handle(ref.current, m.requestId, m.sessionId, m.action);
      }),
    [],
  );
}

export interface CloseFilesPlan {
  groups: { path: string; ids: string[] }[];
  notOpen: string[];
}

/** By requested path: the session's file and diff tabs of it. 'all': every tab of the session,
 *  grouped by its doc path (review, history and web tabs included). */
export function planCloseFiles(
  docs: readonly Pick<OpenDoc, 'id' | 'kind' | 'path' | 'sessionId'>[],
  sessionId: string,
  target: readonly string[] | 'all',
): CloseFilesPlan {
  const own = docs.filter((d) => d.sessionId === sessionId);
  if (target === 'all') {
    const byPath = new Map<string, string[]>();
    for (const d of own) byPath.set(d.path, [...(byPath.get(d.path) ?? []), d.id]);
    return { groups: [...byPath].map(([path, ids]) => ({ path, ids })), notOpen: [] };
  }
  const plan: CloseFilesPlan = { groups: [], notOpen: [] };
  const seen = new Set<string>();
  for (const path of target) {
    const key = canonicalPath(path);
    if (seen.has(key)) continue;
    seen.add(key);
    const ids = own
      .filter((d) => (d.kind === 'file' || d.kind === 'diff') && canonicalPath(d.path) === key)
      .map((d) => d.id);
    if (ids.length === 0) plan.notOpen.push(path);
    else plan.groups.push({ path, ids });
  }
  return plan;
}

export interface CloseFilesOps {
  kindOf(id: string): OpenDoc['kind'] | undefined;
  pathOf(id: string): string | undefined;
  isDirty(path: string): boolean;
  /** forceCloseDoc: closes everywhere, pushes the reopen stack. */
  forceClose(id: string): void;
  /** closeDoc's auto-save path without its confirm. */
  closeDirtyUnprompted(id: string): Promise<'closed' | 'needsPrompt'>;
}

/** Never prompts: a dirty file the auto-save policy won't save stays open and is reported. */
export async function runCloseFiles(
  plan: CloseFilesPlan,
  ops: CloseFilesOps,
): Promise<CloseFilesOutcome> {
  const closed: string[] = [];
  const skipped: CloseFilesOutcome['skipped'] = [];
  let truncated = false;
  const record = (into: () => void) => {
    if (closed.length + skipped.length < MAX_CLOSE_RESULTS) into();
    else truncated = true;
  };
  for (const group of plan.groups) {
    let kept = false;
    for (const id of group.ids) {
      const path = ops.kindOf(id) === 'file' ? ops.pathOf(id) : undefined;
      if (path !== undefined && ops.isDirty(path)) {
        if ((await ops.closeDirtyUnprompted(id)) === 'needsPrompt') kept = true;
      } else {
        ops.forceClose(id);
      }
    }
    if (kept) record(() => skipped.push({ path: group.path, reason: 'unsaved' }));
    else record(() => closed.push(group.path));
  }
  for (const path of plan.notOpen) record(() => skipped.push({ path, reason: 'not_open' }));
  return truncated ? { closed, skipped, truncated: true } : { closed, skipped };
}
