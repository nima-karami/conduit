import { useReducer } from 'react';
import { isMerge } from '../../src/git-graph-render';
import type { CommitNode, GitRef } from '../../src/protocol';
import { parseCommitDiffPath } from '../docs';
import { IconBranch, IconCopy, IconExternal, IconReview } from '../icons';
import { relativeTime } from '../relative-time';
import { useCommitFiles } from '../use-commit-files';
import { DiffViewer } from './diff-viewer';
import { EmptyState } from './empty-state';

const REF_KIND_LABEL: Record<GitRef['kind'], string> = {
  head: 'HEAD',
  branch: 'branch',
  remote: 'remote',
  tag: 'tag',
};

const STR = {
  unavailable: 'Commit unavailable',
  unavailableHint: 'Open History and reselect this commit to load it.',
  changedFiles: 'Changed files',
  noChangedFiles: 'No file changes in this commit.',
  loadingFiles: 'Loading changed files…',
  loadingDiff: 'Loading diff…',
  notInCommit: 'File not in this commit',
  mergeNote: 'Diff shown against the first parent.',
  copySha: 'Copy full SHA',
  copied: 'Copied',
  viewDiff: 'Open diff (double-click to pin)',
  review: 'Review changes',
  reviewHint: "Review this commit's changes in the Review tab",
} as const;

/**
 * Commit detail: a commit's full message + metadata + changed-file list, rendered INLINE in
 * the git-history view's bottom (detail) pane. Commit metadata comes from the history-loaded
 * `CommitNode` (passed in); the file list comes from the shared {@link useCommitFiles}
 * loader. Single-click a file → preview diff tab, double-click → pinned (the caller's
 * `onOpenFile(file, pin)` distinguishes them). Uses the git-history `gh__*` styles.
 */
export function CommitView({
  sessionId,
  commit,
  onOpenFile,
  onReviewCommit,
}: {
  sessionId: string | undefined;
  commit: CommitNode | undefined;
  onOpenFile: (file: string, pin: boolean) => void;
  /** Open the whole commit in the Review tab (commit source). Always enabled once a commit
   *  is selected — a no-change commit just opens the Review empty state (spec D8). */
  onReviewCommit?: (sha: string, subject: string) => void;
}) {
  const [copied, setCopied] = useReducer((_: boolean, v: boolean) => v, false);
  const { status, files } = useCommitFiles(sessionId, commit?.sha ?? '');

  if (!commit) {
    return (
      <div className="commitview commitview--empty">
        <EmptyState
          variant="pane"
          icon={<IconBranch size={24} />}
          title={STR.unavailable}
          hint={STR.unavailableHint}
        />
      </div>
    );
  }

  const merge = isMerge(commit.parents);
  const date = new Date(commit.date * 1000);
  const copy = () => {
    void navigator.clipboard?.writeText(commit.sha);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="commitview">
      <div className="gh__detail-head">
        <div className="gh__detail-sha">
          <span className="gh__detail-sha-text">{commit.sha}</span>
          <button
            type="button"
            className="gh__copy"
            onClick={copy}
            title={STR.copySha}
            aria-label={STR.copySha}
          >
            <IconCopy size={13} />
            {copied && <span className="gh__copied">{STR.copied}</span>}
          </button>
          {onReviewCommit && (
            <button
              type="button"
              className="gh__copy gh__review-commit"
              onClick={() => onReviewCommit(commit.sha, commit.subject)}
              title={STR.reviewHint}
              aria-label={STR.review}
            >
              <IconReview size={13} />
              {STR.review}
            </button>
          )}
        </div>
        <div className="gh__detail-meta">
          <span className="gh__detail-author">{commit.author}</span>
          {commit.email && <span className="gh__detail-email">{commit.email}</span>}
          <span className="gh__detail-date" title={date.toLocaleString()}>
            {relativeTime(commit.date * 1000)}
          </span>
        </div>
        {commit.refs.length > 0 && (
          <div className="gh__detail-refs">
            {commit.refs.map((ref) => (
              <span
                key={`${ref.kind}:${ref.name}`}
                className={`gh__badge gh__badge--${ref.kind}`}
                title={REF_KIND_LABEL[ref.kind]}
              >
                {ref.name}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="gh__message">
        <p className="gh__message-subject">{commit.subject}</p>
        {commit.body && <pre className="gh__message-body">{commit.body}</pre>}
      </div>

      <div className="gh__files">
        <div className="gh__files-head">
          <span>
            {STR.changedFiles}
            {files.length > 0 ? ` (${files.length})` : ''}
          </span>
          {merge && <span className="gh__merge-note">{STR.mergeNote}</span>}
        </div>
        {status === 'loading' ? (
          <div className="gh__files-notice">{STR.loadingFiles}</div>
        ) : files.length === 0 ? (
          <div className="gh__files-notice">{STR.noChangedFiles}</div>
        ) : (
          <ul className="gh__file-list">
            {files.map((d) => (
              <li key={d.path}>
                <button
                  type="button"
                  className="gh__file"
                  title={STR.viewDiff}
                  onClick={() => onOpenFile(d.path, false)}
                  onDoubleClick={() => onOpenFile(d.path, true)}
                >
                  <IconExternal size={12} className="gh__file-icon" />
                  <span className="gh__file-path">{d.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The `commit-diff` editor tab: one file's diff for a commit, via the shared loader + the
 *  existing DiffViewer. `path` encodes `<sha> <file>`. Read-only (immutable sha) — no
 *  freshness/save handling applies. */
export function CommitDiffView({
  sessionId,
  path,
}: {
  sessionId: string | undefined;
  path: string;
}) {
  const { sha, file } = parseCommitDiffPath(path);
  const { status, files } = useCommitFiles(sessionId, sha);
  const doc = files.find((d) => d.path === file);

  if (doc) {
    return (
      <div className="commit-diffhost">
        <DiffViewer doc={doc} />
      </div>
    );
  }
  if (status === 'loading') {
    return <div className="commitview__notice">{STR.loadingDiff}</div>;
  }
  return (
    <div className="commitview commitview--empty">
      <EmptyState variant="pane" icon={<IconBranch size={24} />} title={STR.notInCommit} />
    </div>
  );
}
