// Remote git state over the host (plan CON-45 G4). B alone reads its repositories: this store asks
// for a status per session folder and shows B's answer, or B's error string, or 'timeout' when B
// never answered. Nothing here guesses what a repository holds.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitOp, GitReqArgs, GitResult } from '../src/contracts/link-protocol';
import { folderKey } from '../src/folder-key';
import type { RepoSnapshot } from '../src/protocol';
import { requestHost } from './host-request';
import { REMOTE_TIMEOUT, watchRemote } from './remote-files-store';
import { type RemoteSessionRow, remoteKeyId } from './remote-sessions';

// A status walks every changed file of a repo on B, so it gets more room than a directory listing.
const GIT_TIMEOUT_MS = 40_000;
/** A burst of changes under a folder asks for one status once it has been quiet this long. */
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

/** A repository the session's folders sit in, as B reported it. */
export interface RemoteRepo {
  root: string;
  snapshot: RepoSnapshot;
}

export interface RemoteStatus {
  /** The machine is down: nothing is asked and nothing watched. */
  offline: boolean;
  /** Online and no folder has answered yet. */
  loading: boolean;
  /** One entry per distinct repo root, in folder order. */
  repos: RemoteRepo[];
  /** B's error for each folder whose status failed, in folder order. */
  errors: string[];
  /** Ask again for every folder whose status failed. */
  retry: () => void;
}

type FolderAnswer = { ok: true; repo: RemoteRepo } | { ok: false; error: string };

/** The session's home and roots, one per folder key: a root equal to another shows once. */
function foldersOf(row: RemoteSessionRow): string[] {
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

/**
 * The git status of every folder of a remote session row. Each folder asks B for its status; a
 * change under a folder (CON-43 watch) asks again once it has been quiet for 300 ms; a machine
 * coming back online asks every folder again. A row's hook lives as long as its view.
 */
export function useRemoteStatus(row: RemoteSessionRow): RemoteStatus {
  const { machineId, sessionId } = row.key;
  const rowKey = remoteKeyId(row.key);
  const offline = row.machineState !== 'up' && row.machineState !== 'degraded';
  const folderSig = foldersOf(row).join('\n');
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
            ? { ok: true, repo: { root: r.value.root, snapshot: r.value.snapshot } }
            : { ok: false, error: 'unexpected_reply' };
        setAnswers((cur) => ({ ...cur, [folder]: answer }));
      });
    },
    [machineId, sessionId],
  );

  // Online: every folder is asked when the row appears, and again when the machine comes back.
  useEffect(() => {
    if (offline) return;
    for (const folder of folders) ask(folder);
  }, [offline, folders, ask]);

  // Online: a change under a folder asks for that folder's status once it has been quiet.
  useEffect(() => {
    if (offline) return;
    const pending = timers.current;
    const releases = folders.map((folder) =>
      watchRemote(`${rowKey}|git|${folder}`, machineId, sessionId, folder, () => {
        const old = pending.get(folder);
        if (old !== undefined) clearTimeout(old);
        pending.set(
          folder,
          setTimeout(() => {
            pending.delete(folder);
            ask(folder);
          }, REFRESH_DEBOUNCE_MS),
        );
      }),
    );
    return () => {
      for (const release of releases) release();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, [offline, folders, rowKey, machineId, sessionId, ask]);

  const loading =
    !offline && folders.length > 0 && folders.every((folder) => answers[folder] === undefined);
  const repos: RemoteRepo[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const folder of folders) {
    const a = answers[folder];
    if (!a) continue;
    if (!a.ok) {
      errors.push(a.error);
      continue;
    }
    const key = folderKey(a.repo.root);
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push(a.repo);
  }
  const retry = () => {
    for (const folder of folders) if (answers[folder]?.ok === false) ask(folder);
  };
  return { offline, loading, repos, errors, retry };
}
