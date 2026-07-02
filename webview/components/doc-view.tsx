import type { FileContentDTO, FileDiffDTO } from '../../src/protocol';
import type { OpenDoc } from '../docs';
import { CodeViewer } from './code-viewer';
import { DiffViewer } from './diff-viewer';
import { MarkdownViewer } from './markdown-viewer';
import { PdfViewer } from './pdf-viewer';

export function DocView({
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
  /** git-blame: open the clicked line's commit in the Review tab (from the blame lens). */
  onReviewCommit?: (sha: string, subject: string) => void;
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
