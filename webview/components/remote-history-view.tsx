// A remote history tab (plan CON-45 G5): B's commits for one repository, read-only. A commit shows
// what it changed; a file of it shows its diff. Only B reads git; this view shows B's answers.

import { useEffect, useRef, useState } from 'react';
import type { CommitNode, FileDiffDTO } from '../../src/protocol';
import type { Machine, OpenDoc } from '../docs';
import { MACHINES_STR } from '../machines-strings';
import { relativeTime } from '../relative-time';
import { type RemoteGitResult, remoteGit } from '../remote-git-store';
import { DiffViewer } from './diff-viewer';

/** Commits per page: the first page and each Load more. */
const PAGE = 100;
/** The code a log answers with when B could not read the history (its state is 'error'). */
const HISTORY_FAILED = 'history_failed';

type LogState =
  | { kind: 'loading' }
  | { kind: 'error'; code: string }
  | {
      kind: 'ready';
      commits: CommitNode[];
      hasMore: boolean;
      /** A Load more is in flight. */
      busy: boolean;
      /** The last Load more failed: the code B or the host reported. */
      moreError?: string;
    };

/** The commit the user picked and what B answered for it; `path` is the file shown in the diff. */
type Detail =
  | { sha: string; kind: 'loading' }
  | { sha: string; kind: 'error'; code: string }
  | { sha: string; kind: 'ready'; files: FileDiffDTO[]; truncated: boolean; path?: string };

export function RemoteHistoryView({ doc, machineName }: { doc: OpenDoc; machineName: string }) {
  const machine = doc.machine;
  if (!machine) return <div className="viewer__notice">{MACHINES_STR.gitNoTarget}</div>;
  return <RemoteHistoryRepo machine={machine} root={doc.path} machineName={machineName} />;
}

function RemoteHistoryRepo({
  machine,
  root,
  machineName,
}: {
  machine: Machine;
  root: string;
  machineName: string;
}) {
  const { machineId, sessionId } = machine;
  const [log, setLog] = useState<LogState>({ kind: 'loading' });
  const [detail, setDetail] = useState<Detail | null>(null);
  // Each request takes a number; only the newest answer of its kind is kept.
  const logSeq = useRef(0);
  const showSeq = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const mine = ++logSeq.current;
    void remoteGit(machineId, sessionId, root, 'log', { limit: PAGE }).then((r) => {
      if (!alive.current || mine !== logSeq.current) return;
      setLog(firstPage(r));
    });
  }, [machineId, sessionId, root]);

  const loadMore = (ready: Extract<LogState, { kind: 'ready' }>) => {
    const last = ready.commits.at(-1);
    if (!last) return;
    const mine = ++logSeq.current;
    setLog({ ...ready, busy: true, moreError: undefined });
    void remoteGit(machineId, sessionId, root, 'log', { limit: PAGE, before: last.sha }).then(
      (r) => {
        if (!alive.current || mine !== logSeq.current) return;
        setLog((cur) => (cur.kind === 'ready' ? appendPage(cur, r) : cur));
      },
    );
  };

  const selectFile = (path: string) => {
    setDetail((cur) => (cur?.kind === 'ready' ? { ...cur, path } : cur));
  };

  const pick = (sha: string) => {
    const mine = ++showSeq.current;
    setDetail({ sha, kind: 'loading' });
    void remoteGit(machineId, sessionId, root, 'show', { sha }).then((r) => {
      if (!alive.current || mine !== showSeq.current) return;
      setDetail(showDetail(sha, r));
    });
  };

  if (log.kind === 'loading') {
    return <div className="viewer__notice">{MACHINES_STR.historyLoading}</div>;
  }
  if (log.kind === 'error') {
    return <div className="viewer__notice">{MACHINES_STR.gitError(log.code, machineName)}</div>;
  }
  if (log.commits.length === 0) {
    return <div className="viewer__notice">{MACHINES_STR.historyEmpty}</div>;
  }

  return (
    <div className="remote-history">
      <div
        role="list"
        className="remote-history__commits"
        aria-label={MACHINES_STR.historyList(machineName)}
      >
        {log.commits.map((commit) => (
          <div key={commit.sha} role="listitem" className="remote-history__item">
            <button
              type="button"
              className="remote-history__commit"
              aria-current={detail?.sha === commit.sha ? 'true' : undefined}
              onClick={() => pick(commit.sha)}
            >
              <span className="remote-history__sha">{commit.sha.slice(0, 7)}</span>
              <bdi dir="auto" className="remote-history__subject">
                {commit.subject}
              </bdi>
              {commit.refs.map((ref) => (
                <span key={`${ref.kind}:${ref.name}`} className="remote-history__ref">
                  {ref.name}
                </span>
              ))}
              <span className="remote-history__meta">
                <bdi dir="auto">{commit.author}</bdi>
                {' · '}
                <time dateTime={new Date(commit.date * 1000).toISOString()}>
                  {relativeTime(commit.date * 1000)}
                </time>
              </span>
            </button>
          </div>
        ))}
        {log.hasMore ? (
          <div role="listitem" className="remote-history__more">
            <button
              type="button"
              className="btn btn--sm"
              disabled={log.busy}
              onClick={() => loadMore(log)}
            >
              {log.busy ? MACHINES_STR.historyLoadingMore : MACHINES_STR.historyLoadMore}
            </button>
            {log.moreError !== undefined ? (
              <span className="remote-history__note">
                {MACHINES_STR.gitError(log.moreError, machineName)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <RemoteCommitDetail detail={detail} machineName={machineName} onSelectFile={selectFile} />
    </div>
  );
}

function RemoteCommitDetail({
  detail,
  machineName,
  onSelectFile,
}: {
  detail: Detail | null;
  machineName: string;
  onSelectFile: (path: string) => void;
}) {
  if (detail === null) {
    return <div className="viewer__notice">{MACHINES_STR.historyPick}</div>;
  }
  if (detail.kind === 'loading') {
    return <div className="viewer__notice">{MACHINES_STR.historyLoadingCommit}</div>;
  }
  if (detail.kind === 'error') {
    return <div className="viewer__notice">{MACHINES_STR.gitError(detail.code, machineName)}</div>;
  }
  if (detail.files.length === 0) {
    return <div className="viewer__notice">{MACHINES_STR.historyNoFiles}</div>;
  }
  const file = detail.files.find((f) => f.path === detail.path) ?? detail.files[0];
  return (
    <div className="remote-history__detail">
      {detail.truncated ? (
        <p className="remote-history__note" role="note">
          {MACHINES_STR.historyTruncated}
        </p>
      ) : null}
      <div role="list" className="remote-history__files" aria-label={MACHINES_STR.historyFiles}>
        {detail.files.map((f) => (
          <div key={f.path} role="listitem" className="remote-history__file">
            <button
              type="button"
              className="remote-history__file-row"
              aria-current={f.path === file?.path ? 'true' : undefined}
              onClick={() => onSelectFile(f.path)}
            >
              <bdi dir="ltr" className="remote-history__path">
                {f.path}
              </bdi>
              {f.counts ? (
                <span className="remote-changes__stat">
                  <span className="remote-changes__add">+{f.counts.added}</span>{' '}
                  <span className="remote-changes__del">−{f.counts.removed}</span>
                </span>
              ) : null}
            </button>
          </div>
        ))}
      </div>
      {file ? (
        <div className="remote-history__diff">
          <DiffViewer key={`${detail.sha}:${file.path}`} doc={file} />
        </div>
      ) : null}
    </div>
  );
}

function firstPage(r: RemoteGitResult): LogState {
  if (!r.ok) return { kind: 'error', code: r.error };
  if (r.value.op !== 'log') return { kind: 'error', code: 'unexpected_reply' };
  if (r.value.state === 'error') return { kind: 'error', code: HISTORY_FAILED };
  return {
    kind: 'ready',
    commits: r.value.commits,
    hasMore: r.value.hasMore,
    busy: false,
  };
}

function appendPage(cur: Extract<LogState, { kind: 'ready' }>, r: RemoteGitResult): LogState {
  if (!r.ok) return { ...cur, busy: false, moreError: r.error };
  if (r.value.op !== 'log') return { ...cur, busy: false, moreError: 'unexpected_reply' };
  if (r.value.state === 'error') return { ...cur, busy: false, moreError: HISTORY_FAILED };
  return {
    ...cur,
    commits: [...cur.commits, ...r.value.commits],
    hasMore: r.value.hasMore,
    busy: false,
  };
}

function showDetail(sha: string, r: RemoteGitResult): Detail {
  if (!r.ok) return { sha, kind: 'error', code: r.error };
  if (r.value.op !== 'show') return { sha, kind: 'error', code: 'unexpected_reply' };
  return {
    sha,
    kind: 'ready',
    files: r.value.files,
    truncated: r.value.truncated,
    path: r.value.files[0]?.path,
  };
}
