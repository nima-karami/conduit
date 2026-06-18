import { useState } from 'react';
import type { FileContentDTO } from '../../src/protocol';
import { ImageStage } from './image-stage';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImageViewer({ doc }: { doc: FileContentDTO }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  if (!doc.image) {
    return <div className="viewer__notice">{doc.error ?? 'Image could not be loaded.'}</div>;
  }

  const { dataUrl, bytes } = doc.image;
  const name = doc.path.replace(/\\/g, '/').split('/').pop() ?? doc.path;
  const caption = dims ? `${dims.w} × ${dims.h} px · ${formatBytes(bytes)}` : formatBytes(bytes);

  return (
    <ImageStage
      src={dataUrl}
      label={name}
      caption={caption}
      className="image-viewer"
      onNatural={setDims}
    />
  );
}
