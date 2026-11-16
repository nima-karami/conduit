// A remote diff tab (plan CON-45 G5): one file's change in B's repository, read-only. B reads the
// file; this view shows its answer, re-asks when B reports the file changed, and never keeps an
// answer that a newer request has overtaken.

import { useEffect, useState } from 'react';
import type { FileDiffDTO } from '../../src/protocol';
import type { Machine, OpenDoc } from '../docs';
import { MACHINES_STR } from '../machines-strings';
import { watchRemote } from '../remote-files-store';
import { type RemoteGitResult, remoteGit } from '../remote-git-store';
import { DiffViewer } from './diff-viewer';

type DiffState =
  | { kind: 'loading' }
  /** The code B or the host reported; its copy names the machine at render. */
  | { kind: 'error'; code: string }
  | { kind: 'ready'; file: FileDiffDTO };

export function RemoteDiffView({ doc, machineName }: { doc: OpenDoc; machineName: string }) {
  const machine = doc.machine;
  const root = doc.repoRoot;
  if (!machine || root === undefined) {
    return <div className="viewer__notice">{MACHINES_STR.gitNoTarget}</div>;
  }
  return (
    <RemoteDiffFile
      docId={doc.id}
      machine={machine}
      root={root}
      path={doc.path}
      machineName={machineName}
    />
  );
}

function RemoteDiffFile({
  docId,
  machine,
  root,
  path,
  machineName,
}: {
  docId: string;
  machine: Machine;
  root: string;
  path: string;
  machineName: string;
}) {
  const { machineId, sessionId } = machine;
  const [state, setState] = useState<DiffState>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    // Only the newest request may answer: an older reply that lands late must not replace it.
    let newest = 0;
    const load = () => {
      const mine = ++newest;
      void remoteGit(machineId, sessionId, root, 'diff', { path }).then((r) => {
        if (!alive || mine !== newest) return;
        setState(diffState(r));
      });
    };
    load();
    // B reports the file changed: the diff is asked again, the last answer kept until it lands.
    const release = watchRemote(`diff|${docId}`, machineId, sessionId, path, () => load());
    return () => {
      alive = false;
      release();
    };
  }, [docId, machineId, sessionId, root, path]);

  if (state.kind === 'loading') {
    return <div className="viewer__notice">{MACHINES_STR.diffLoading}</div>;
  }
  if (state.kind === 'error') {
    return <div className="viewer__notice">{MACHINES_STR.gitError(state.code, machineName)}</div>;
  }
  return <DiffViewer doc={state.file} />;
}

function diffState(r: RemoteGitResult): DiffState {
  if (!r.ok) return { kind: 'error', code: r.error };
  if (r.value.op !== 'diff') return { kind: 'error', code: 'unexpected_reply' };
  return { kind: 'ready', file: r.value.file };
}
