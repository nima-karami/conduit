import { useState } from 'react';
import type { FileContentDTO } from '../../src/protocol';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImageViewer({ doc }: { doc: FileContentDTO }) {
  const [naturalW, setNaturalW] = useState<number | null>(null);
  const [naturalH, setNaturalH] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);
  // Toggles between fit-to-pane (false) and 1:1 natural size (true).
  const [oneToOne, setOneToOne] = useState(false);

  if (!doc.image) {
    return <div className="viewer__notice">{doc.error ?? 'Image could not be loaded.'}</div>;
  }

  const { dataUrl, bytes } = doc.image;

  return (
    <div className="image-viewer">
      <div className="image-viewer__stage">
        {loadError ? (
          <div className="viewer__notice">Could not render image.</div>
        ) : (
          <img
            src={dataUrl}
            alt=""
            className={oneToOne ? 'image-viewer__img--natural' : 'image-viewer__img--fit'}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalW(img.naturalWidth);
              setNaturalH(img.naturalHeight);
            }}
            onError={() => setLoadError(true)}
          />
        )}
      </div>
      {!loadError && (
        <div className="image-viewer__footer">
          <span className="image-viewer__caption">
            {naturalW != null && naturalH != null
              ? `${naturalW} × ${naturalH} px · ${formatBytes(bytes)}`
              : formatBytes(bytes)}
          </span>
          <button
            type="button"
            className={`image-viewer__toggle${oneToOne ? ' image-viewer__toggle--active' : ''}`}
            onClick={() => setOneToOne((v) => !v)}
            title={oneToOne ? 'Switch to fit view' : 'Switch to 1:1 view'}
          >
            1:1
          </button>
        </div>
      )}
    </div>
  );
}
