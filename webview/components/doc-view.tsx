import type { FileContentDTO, FileDiffDTO } from '../../src/protocol';
import type { Session } from '../../src/types';
import type { OpenDoc } from '../docs';
import { BreadcrumbBar } from './breadcrumb-bar';
import { CodeViewer } from './code-viewer';
import { DiffViewer } from './diff-viewer';
import { MarkdownViewer } from './markdown-viewer';
import { PdfViewer } from './pdf-viewer';

export function DocView({
  doc,
  file,
  diff,
  activeSession,
  onOpenFile,
  onReviewCommit,
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
}) {
  return (
    <div className="docpanel">
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
          onOpenFile={onOpenFile}
          onReviewCommit={onReviewCommit}
        />
      </div>
    </div>
  );
}

function DocBody({
  doc,
  file,
  diff,
  onOpenFile,
  onReviewCommit,
}: {
  doc: OpenDoc;
  file?: FileContentDTO;
  diff?: FileDiffDTO;
  onOpenFile?: ((path: string) => void) | undefined;
  onReviewCommit?: (sha: string, subject: string, repoRoot?: string, sessionId?: string) => void;
}) {
  if (doc.kind === 'diff') {
    if (!diff) return <div className="viewer__notice">Loading diff…</div>;
    return <DiffViewer doc={diff} viewStateId={doc.id} />;
  }
  if (!file) return <div className="viewer__notice">Loading…</div>;
  if (file.error) return <div className="viewer__notice">{file.error}</div>;
  // Order: diff → image (handled inside CodeViewer) → pdf → markdown → code.
  if (file.pdf) return <PdfViewer doc={file} />;
  if (file.language === 'markdown') return <MarkdownViewer doc={file} onOpenFile={onOpenFile} />;
  return <CodeViewer doc={file} sessionId={doc.sessionId} onReviewCommit={onReviewCommit} />;
}
