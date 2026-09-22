import { type ReactNode, useCallback, useRef, useSyncExternalStore } from 'react';
import { isHtmlDocPath } from '../../src/media-kind';
import { planRootFromPath } from '../../src/plan-path';
import type { FileContentDTO, FileDiffDTO } from '../../src/protocol';
import type { Session } from '../../src/types';
import { post } from '../bridge';
import {
  CONFLICTED_NOTICE,
  DIFF_READ_ERROR_NOTICE,
  diffTabState,
  emptySideNotice,
} from '../diff-tab-scope';
import { getDirtySnapshot, subscribeDirty } from '../dirty-store';
import type { OpenDoc } from '../docs';
import { getHtmlView, type HtmlView, subscribeHtmlView } from '../html-view-store';
import { saveDocByPath } from '../save-registry';
import { useSettings } from '../settings';
import { BreadcrumbBar } from './breadcrumb-bar';
import { CodeViewer } from './code-viewer';
import { DiffViewer } from './diff-viewer';
import { HtmlViewer } from './html-viewer';
import { MarkdownViewer } from './markdown-viewer';
import { PdfViewer } from './pdf-viewer';
import { PlanView } from './plan-view';

export function DocView({
  doc,
  file,
  diff,
  activeSession,
  onOpenFile,
  onReviewCommit,
  onClearSideBySide,
  onCloseDoc,
  onRetryDiff,
  onOpenFullDiff,
}: {
  doc: OpenDoc;
  file?: FileContentDTO;
  diff?: FileDiffDTO;
  /** diff docs only: re-read after a failed read (the Error state's Retry). */
  onRetryDiff?: (doc: OpenDoc) => void;
  /** diff docs only: open the unscoped diff from a scoped tab that turned out conflicted. */
  onOpenFullDiff?: (doc: OpenDoc) => void;
  /** The active session — the breadcrumb derives its root cwd from it. */
  activeSession?: Session | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
  /** A deleted plan offers Close, the only view that closes its own tab (spec §8). */
  onCloseDoc?: ((id: string) => void) | undefined;
  /** git-blame: open the clicked line's commit in the Review tab (from the blame lens);
   * `repoRoot`/`sessionId` scope it to the blamed file's own repo (see CodeViewer). */
  onReviewCommit?: (sha: string, subject: string, repoRoot?: string, sessionId?: string) => void;
  /** diff docs only: consume the one-time `sideBySide` override once the tab's own toggle fires. */
  onClearSideBySide?: (id: string) => void;
}) {
  const { settings } = useSettings();
  const htmlView = useSyncExternalStore(
    subscribeHtmlView,
    useCallback(
      () => getHtmlView(doc.id, settings.htmlDefaultView),
      [doc.id, settings.htmlDefaultView],
    ),
  );
  const dirtySet = useSyncExternalStore(subscribeDirty, getDirtySnapshot, getDirtySnapshot);
  // A rendered markdown file is a DOCUMENT, so under Aero the whole panel — breadcrumb included —
  // goes to the light page tiers, and only its code stays ink (blockers.md Q2). Decided here
  // rather than inside MarkdownViewer because the breadcrumb is the PANEL's edge, not the
  // viewer's; the viewer re-inks itself when you switch it to source. A rendered HTML page is
  // the same kind of thing, and re-inks the same way.
  const docPage =
    doc.kind === 'file' &&
    (file?.language === 'markdown' || (isHtmlDocPath(doc.path) && htmlView === 'preview'));
  return (
    <div className={`docpanel${docPage ? ' docpage' : ''}`}>
      {/* Frame 8b / §7.7: the breadcrumb is the doc panel's own top edge, not a fifth stacked
          chrome band. Sitting inside .termwrap is also what makes it legible under Aero — the
          on-ink text tiers are scoped there. */}
      {doc.kind === 'file' && onOpenFile && (
        <BreadcrumbBar
          filePath={doc.path}
          language={file?.language ?? ''}
          activeSession={activeSession}
          onOpenFile={onOpenFile}
        />
      )}
      <div className="docpanel__body">
        <DocBody
          doc={doc}
          file={file}
          diff={diff}
          htmlDefaultView={settings.htmlDefaultView}
          dirty={dirtySet.has(doc.path)}
          onOpenFile={onOpenFile}
          onReviewCommit={onReviewCommit}
          onClearSideBySide={onClearSideBySide}
          onCloseDoc={onCloseDoc}
          onRetryDiff={onRetryDiff}
          onOpenFullDiff={onOpenFullDiff}
        />
      </div>
    </div>
  );
}

/** A diff tab's body: one of spec 2026-09-22-scoped-diff-tabs §2's states. */
function DiffTabBody({
  doc,
  diff,
  onOpenFile,
  onClearSideBySide,
  onRetryDiff,
  onOpenFullDiff,
}: {
  doc: OpenDoc;
  diff?: FileDiffDTO;
  onOpenFile?: ((path: string) => void) | undefined;
  onClearSideBySide?: (id: string) => void;
  onRetryDiff?: (doc: OpenDoc) => void;
  onOpenFullDiff?: (doc: OpenDoc) => void;
}) {
  const noticeRef = useRef<HTMLDivElement>(null);
  const state = diffTabState(diff, doc.diffScope);
  const name = doc.path.split(/[\\/]/).filter(Boolean).pop() ?? doc.path;
  const noticeText =
    state === 'error'
      ? DIFF_READ_ERROR_NOTICE
      : state === 'conflicted'
        ? CONFLICTED_NOTICE
        : state === 'empty' && doc.diffScope
          ? emptySideNotice(doc.diffScope, name)
          : '';

  let body: ReactNode;
  if (!diff) body = <div className="viewer__notice">Loading diff…</div>;
  else if (state === 'error' || state === 'conflicted' || state === 'empty')
    body = (
      <div className="viewer__notice" ref={noticeRef} tabIndex={-1}>
        <div>{noticeText}</div>
        {state === 'error' && onRetryDiff && (
          <button
            type="button"
            className="viewer__notice-action"
            onClick={() => {
              // The button unmounts once the read lands; parking focus on the notice keeps it
              // from falling to <body>.
              noticeRef.current?.focus();
              onRetryDiff(doc);
            }}
          >
            Retry
          </button>
        )}
        {state === 'conflicted' && onOpenFullDiff && (
          <button
            type="button"
            className="viewer__notice-action"
            onClick={() => onOpenFullDiff(doc)}
          >
            Open full diff
          </button>
        )}
      </div>
    );
  else
    body = (
      <DiffViewer
        doc={diff}
        viewStateId={doc.id}
        onOpenFile={onOpenFile}
        initialSideBySide={doc.sideBySide}
        onSideBySideToggled={() => onClearSideBySide?.(doc.id)}
        showWhitespace={doc.diffScope !== undefined}
      />
    );
  return (
    <>
      {body}
      {/* Mounted with the tab, so a change of text is announced (a live region that mounts
          already holding its text often is not). */}
      <div className="sr-only" aria-live="polite">
        {noticeText}
      </div>
    </>
  );
}

function DocBody({
  doc,
  file,
  diff,
  htmlDefaultView,
  dirty,
  onOpenFile,
  onReviewCommit,
  onClearSideBySide,
  onCloseDoc,
  onRetryDiff,
  onOpenFullDiff,
}: {
  doc: OpenDoc;
  file?: FileContentDTO;
  diff?: FileDiffDTO;
  htmlDefaultView: HtmlView;
  dirty: boolean;
  onOpenFile?: ((path: string) => void) | undefined;
  onReviewCommit?: (sha: string, subject: string, repoRoot?: string, sessionId?: string) => void;
  onClearSideBySide?: (id: string) => void;
  onCloseDoc?: ((id: string) => void) | undefined;
  onRetryDiff?: (doc: OpenDoc) => void;
  onOpenFullDiff?: (doc: OpenDoc) => void;
}) {
  if (doc.kind === 'diff') {
    return (
      <DiffTabBody
        doc={doc}
        diff={diff}
        onOpenFile={onOpenFile}
        onClearSideBySide={onClearSideBySide}
        onRetryDiff={onRetryDiff}
        onOpenFullDiff={onOpenFullDiff}
      />
    );
  }
  // A plan IS a .md file and only its path distinguishes it (no DocKind) — and it routes BEFORE
  // the doc store's generic loading/error branches, not after, because the plan store is what
  // reads it. Behind the generic branch, deleting an open plan left the pane stuck on "File could
  // not be read." and the not-found state's Recreate empty / Close (spec §8) unreachable.
  // `file` rides along only so a plan the plan store refused to read can still show its bytes.
  const planRoot = planRootFromPath(doc.path);
  if (planRoot !== null)
    return (
      <PlanView
        doc={doc}
        root={planRoot}
        sessionId={doc.sessionId}
        file={file}
        onClose={onCloseDoc}
      />
    );
  if (!file) return <div className="viewer__notice">Loading…</div>;
  if (file.error) return <div className="viewer__notice">{file.error}</div>;
  // Order: diff → image (handled inside CodeViewer) → pdf → html → markdown → code.
  if (file.pdf) return <PdfViewer doc={file} />;
  // The EXTENSION, never `file.language`: src/lang.ts assigns 'html' to .vue and .svelte too.
  if (isHtmlDocPath(doc.path))
    return (
      <HtmlViewer
        doc={file}
        docId={doc.id}
        fallbackView={htmlDefaultView}
        dirty={dirty}
        onOpenExternally={(path) => post({ type: 'openExternalPath', path })}
        onSave={() => saveDocByPath(doc.path)}
      />
    );
  if (file.language === 'markdown') return <MarkdownViewer doc={file} onOpenFile={onOpenFile} />;
  return <CodeViewer doc={file} sessionId={doc.sessionId} onReviewCommit={onReviewCommit} />;
}
