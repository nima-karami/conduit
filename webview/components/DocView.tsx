import type { FileContentDTO, FileDiffDTO } from '../../src/protocol';
import type { OpenDoc } from '../docs';
import { CodeViewer } from './CodeViewer';
import { MarkdownViewer } from './MarkdownViewer';
import { DiffViewer } from './DiffViewer';

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
  if (file.language === 'markdown') return <MarkdownViewer doc={file} />;
  return <CodeViewer doc={file} />;
}
