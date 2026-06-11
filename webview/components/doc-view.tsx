import type { FileContentDTO, FileDiffDTO } from '../../src/protocol';
import type { OpenDoc } from '../docs';
import { CodeViewer } from './code-viewer';
import { DiffViewer } from './diff-viewer';
import { MarkdownViewer } from './markdown-viewer';

export function DocView({
  doc,
  file,
  diff,
}: {
  doc: OpenDoc;
  file?: FileContentDTO;
  diff?: FileDiffDTO;
}) {
  if (doc.kind === 'diff') {
    if (!diff) return <div className="viewer__notice">Loading diff…</div>;
    return <DiffViewer doc={diff} />;
  }
  if (!file) return <div className="viewer__notice">Loading…</div>;
  if (file.error) return <div className="viewer__notice">{file.error}</div>;
  if (file.language === 'markdown') return <MarkdownViewer doc={file} />;
  return <CodeViewer doc={file} />;
}
