// Remote git state over the host (plan CON-45 G4). B alone reads its repositories: this store asks
// for a status per session folder and shows B's answer, or B's error string, or 'timeout' when B
// never answered. Nothing here guesses what a repository holds.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitOp, GitReqArgs, GitResult } from '../src/contracts/link-protocol';
import { folderKey } from '../src/folder-key';
import type { RepoSnapshot } from '../src/protocol';
import { joinPath } from './file-tree';
import { requestHost } from './host-request';
import { REMOTE_TIMEOUT, watchRemote } from './remote-files-store';
import { type RemoteSessionRow, remoteFolders, remoteKeyId } from './remote-sessions';

// A status walks every changed file of a repo on B, so it gets more room than a directory listing.
const GIT_TIMEOUT_MS = 40_000;
/** A repo's status is asked again this often while the Changes tab is shown. */
const POLL_MS = 5_000;
/** A burst of changes to a repo's `.git` asks for one status once it has been quiet this long. */
const REFRESH_DEBOUNCE_MS = 300;

export type RemoteGitResult = { ok: true; value: GitResult } | { ok: false; error: string };

/** One git request to B for `root` in the remote session. A missing reply is 'timeout'. */
export async function remoteGit(
  machineId: string,
  sessionId: string,
  root: string,
  op: GitOp,
  args: GitReqArgs,
): Promise<RemoteGitResult> {
  const reply = await requestHost(
    (requestId) => ({ type: 'remoteGit:request', requestId, machineId, sessionId, root, op, args }),
    ['remoteGit:result'],
    GIT_TIMEOUT_MS,
  );
  return reply ? reply.result : { ok: false, error: REMOTE_TIMEOUT };
}

/**
 * A repo-relative change path (git's `/` form) as B's absolute path, in B's own separator: a
 * Windows B reports `C:\\repo`, so its file is `C:\\repo\\src\\a.ts`, never a mix.
 */
export function remoteRepoPath(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`;
}

/** A repository a session folder sits in, keyed by the root B returned for it. */
export interface RemoteRepo {
  /** The session folder that reported this repo first. */
  folder: string;
  root: string;
  snapshot: RepoSnapshot;
}

/** One block of the view, in folder order: a repo, or a folder whose status request failed. */
export type RemoteSection =
  | { kind: 'repo'; repo: RemoteRepo }
  | { kind: 'error'; folder: string; error: string };

export interface RemoteStatus {
  /** The machine is down: nothing is asked and nothing watched. */
  offline: boolean;
  /** Online, and some folder has not answered yet while none has produced a section. */
  loading: boolean;
  sections: RemoteSection[];
  /** Ask B for `folder`'s status again. */
  retry: (folder: string) => void;
}

/** A folder's answer. `snapshot: null` is B saying the folder is in no repo: an answer, not an error. */
type FolderAnswer =
  | { ok: true; root: string; snapshot: RepoSnapshot | null }
  | { ok: false; error: string };

/**
 * The git status of every folder of a remote session row. Each folder is asked when the row
 * appears, every POLL_MS while it is shown, and again when the machine comes back online. A change
 * to a repo's `.git` (CON-43 watch) asks for that repo's folder once it has been quiet for 300 ms.
 */
export function useRemoteStatus(row: RemoteSessionRow): RemoteStatus {
  const { machineId, sessionId } = row.key;
  const rowKey = remoteKeyId(row.key);
  const offline = row.machineState !== 'up' && row.machineState !== 'degraded';
  const folderSig = remoteFolders(row).join('\n');
  const folders = useMemo(() => (folderSig === '' ? [] : folderSig.split('\n')), [folderSig]);

  const [answers, setAnswers] = useState<Record<string, FolderAnswer | undefined>>({});
  // Only the newest request for a folder may answer it: an older reply lands after a newer ask.
  const newest = useRef(new Map<string, number>());
  const requests = useRef(0);
  const alive = useRef(true);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const ask = useCallback(
    (folder: string) => {
      const mine = ++requests.current;
      newest.current.set(folder, mine);
      void remoteGit(machineId, sessionId, folder, 'status', {}).then((r) => {
        if (!alive.current || newest.current.get(folder) !== mine) return;
        const answer: FolderAnswer = !r.ok
          ? { ok: false, error: r.error }
          : r.value.op === 'status'
            ? { ok: true, root: r.value.root, snapshot: r.value.snapshot }
            : { ok: false, error: 'unexpected_reply' };
        setAnswers((cur) => ({ ...cur, [folder]: answer }));
      });
    },
    [machineId, sessionId],
  );

  // Online: every folder is asked now and every POLL_MS while the view is shown.
  useEffect(() => {
    if (offline) return;
    const askAll = () => {
      for (const folder of folders) ask(folder);
    };
    askAll();
    const id = setInterval(askAll, POLL_MS);
    return () => clearInterval(id);
  }, [offline, folders, ask]);

  const sections: RemoteSection[] = [];
  const seen = new Set<string>();
  let pending = false;
  for (const folder of folders) {
    const a = answers[folder];
    if (a === undefined) {
      pending = true;
      continue;
    }
    if (!a.ok) {
      sections.push({ kind: 'error', folder, error: a.error });
      continue;
    }
    if (a.snapshot === null) continue;
    const key = folderKey(a.root);
    if (seen.has(key)) continue;
    seen.add(key);
    sections.push({ kind: 'repo', repo: { folder, root: a.root, snapshot: a.snapshot } });
  }

  // Online: a change to a repo's `.git` asks for its folder once the burst has been quiet.
  const repoSig = sections
    .flatMap((s) => (s.kind === 'repo' ? [`${s.repo.folder}\n${s.repo.root}`] : []))
    .join('\u0000');
  useEffect(() => {
    if (offline) return;
    const pendingTimers = timers.current;
    const releases = repoTargets(repoSig).map(({ folder, root }) => {
      const gitDir = joinPath(root, '.git');
      return watchRemote(`${rowKey}|git|${gitDir}`, machineId, sessionId, gitDir, () => {
        const old = pendingTimers.get(folder);
        if (old !== undefined) clearTimeout(old);
        pendingTimers.set(
          folder,
          setTimeout(() => {
            pendingTimers.delete(folder);
            ask(folder);
          }, REFRESH_DEBOUNCE_MS),
        );
      });
    });
    return () => {
      for (const release of releases) release();
      for (const t of pendingTimers.values()) clearTimeout(t);
      pendingTimers.clear();
    };
  }, [offline, repoSig, rowKey, machineId, sessionId, ask]);

  return {
    offline,
    loading: !offline && pending && sections.length === 0,
    sections,
    retry: ask,
  };
}

/** The repos a `repoSig` names, back as folder and root pairs. */
function repoTargets(sig: string): { folder: string; root: string }[] {
  if (sig === '') return [];
  return sig.split('\u0000').map((entry) => {
    const [folder = '', root = ''] = entry.split('\n');
    return { folder, root };
  });
}
