import { useCallback, useSyncExternalStore } from 'react';
import { isHtmlDocPath } from '../../src/media-kind';
import type { FileContentDTO, FileDiffDTO } from '../../src/protocol';
import type { Session } from '../../src/types';
import { post } from '../bridge';
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

export function DocView({
  doc,
  file,
  diff,
  activeSession,
  onOpenFile,
  onReviewCommit,
  onClearSideBySide,
}: {
  doc: OpenDoc;
  file?: FileContentDTO;
  diff?: FileDiffDTO;
  /** The active session — the breadcrumb derives its root cwd from it. */
  activeSession?: Session | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
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
        />
      </div>
    </div>
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
}: {
  doc: OpenDoc;
  file?: FileContentDTO;
  diff?: FileDiffDTO;
  htmlDefaultView: HtmlView;
  dirty: boolean;
  onOpenFile?: ((path: string) => void) | undefined;
  onReviewCommit?: (sha: string, subject: string, repoRoot?: string, sessionId?: string) => void;
  onClearSideBySide?: (id: string) => void;
}) {
  if (doc.kind === 'diff') {
    if (!diff) return <div className="viewer__notice">Loading diff…</div>;
    return (
      <DiffViewer
        doc={diff}
        viewStateId={doc.id}
        onOpenFile={onOpenFile}
        initialSideBySide={doc.sideBySide}
        onSideBySideToggled={() => onClearSideBySide?.(doc.id)}
      />
    );
  }
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
