import { useState, useSyncExternalStore } from 'react';
import type { FileDiffDTO } from '../../src/protocol';
import { IconCheck, IconClose } from '../icons';
import { ImageStage } from './image-stage';

type DiffMode = 'side-by-side' | 'swipe' | 'onion';

// Diff mode is sticky per SESSION (spec A3) — shared across files but not persisted to
// disk. A module-level store keeps every open diff card in sync without a settings
// migration; it resets to the default on app reload.
let stickyMode: DiffMode = 'side-by-side';
const listeners = new Set<() => void>();
function setStickyMode(m: DiffMode) {
  stickyMode = m;
  for (const l of listeners) l();
}
function useDiffMode(): [DiffMode, (m: DiffMode) => void] {
  const mode = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => stickyMode,
    () => stickyMode,
  );
  return [mode, setStickyMode];
}

const MODE_LABELS: Record<DiffMode, string> = {
  'side-by-side': 'Side by side',
  swipe: 'Swipe',
  onion: 'Onion',
};

function StatusBadge({ status }: { status: 'modified' | 'added' | 'deleted' }) {
  // text + icon + color (never color alone) per spec §7.
  const map = {
    added: { label: 'Added', cls: 'imgdiff__badge--added', icon: <IconCheck size={12} /> },
    deleted: { label: 'Deleted', cls: 'imgdiff__badge--deleted', icon: <IconClose size={12} /> },
    modified: { label: 'Modified', cls: 'imgdiff__badge--modified', icon: null },
  } as const;
  const b = map[status];
  return (
    <span className={`imgdiff__badge ${b.cls}`}>
      {b.icon}
      {b.label}
    </span>
  );
}

/**
 * Old-vs-new preview for a changed image. Replaces the "Binary file — no diff preview"
 * notice for image paths. Modes (side-by-side / swipe / onion) are user-switchable and
 * sticky per session. Each side reuses ImageStage so zoom/pan/rotate apply in-place.
 */
export function ImageDiff({ doc }: { doc: FileDiffDTO }) {
  const [mode, setMode] = useDiffMode();
  const image = doc.image;
  if (!image || image.overCap) {
    return <div className="viewer__notice">Binary file — no diff preview.</div>;
  }

  const name = doc.path.replace(/\\/g, '/').split('/').pop() ?? doc.path;
  const { head, work, status } = image;
  // Single-sided (added/deleted) always shows the one available image — mode toggle is
  // hidden because there is nothing to compare.
  const oneSided = !head || !work;

  return (
    <div className="imgdiff">
      <div className="imgdiff__bar">
        <StatusBadge status={status} />
        {!oneSided && (
          <div className="imgdiff__modes" role="group" aria-label="Image diff mode">
            {(Object.keys(MODE_LABELS) as DiffMode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={`imgdiff__mode${mode === m ? ' imgdiff__mode--active' : ''}`}
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
              >
                {MODE_LABELS[m]}
              </button>
            ))}
          </div>
        )}
        <div className="sr-only" aria-live="polite">
          {oneSided ? '' : `Diff mode: ${MODE_LABELS[mode]}`}
        </div>
      </div>

      {oneSided ? (
        <SingleSide
          src={(head ?? work)?.dataUrl ?? ''}
          bytes={(head ?? work)?.bytes ?? 0}
          label={status === 'added' ? `${name} (added)` : `${name} (deleted)`}
          sideLabel={status === 'added' ? 'Added' : 'Deleted'}
        />
      ) : mode === 'side-by-side' ? (
        <div className="imgdiff__cols">
          <Side src={head?.dataUrl ?? ''} bytes={head?.bytes ?? 0} label="Original" name={name} />
          <Side src={work?.dataUrl ?? ''} bytes={work?.bytes ?? 0} label="Changed" name={name} />
        </div>
      ) : mode === 'swipe' ? (
        <SwipeDiff oldSrc={head?.dataUrl ?? ''} newSrc={work?.dataUrl ?? ''} name={name} />
      ) : (
        <OnionDiff oldSrc={head?.dataUrl ?? ''} newSrc={work?.dataUrl ?? ''} name={name} />
      )}
    </div>
  );
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Swipe: old and new stacked; a range slider (keyboard-operable, WCAG 2.5.7) clips the
 * new image from the right so dragging it wipes between old and new.
 */
function SwipeDiff({ oldSrc, newSrc, name }: { oldSrc: string; newSrc: string; name: string }) {
  const [pos, setPos] = useState(50);
  return (
    <div className="imgdiff__swipe">
      <div className="imgdiff__swipestage" aria-label={`Swipe diff: ${name}`}>
        <img className="imgdiff__layer" src={oldSrc} alt={`Original: ${name}`} draggable={false} />
        <img
          className="imgdiff__layer imgdiff__layer--top"
          src={newSrc}
          alt={`Changed: ${name}`}
          draggable={false}
          style={{ clipPath: `inset(0 0 0 ${pos}%)` }}
        />
        <div className="imgdiff__divider" style={{ left: `${pos}%` }} aria-hidden="true" />
      </div>
      <label className="imgdiff__rangerow">
        <span className="imgdiff__rangelabel">Original</span>
        <input
          type="range"
          min={0}
          max={100}
          value={pos}
          aria-label="Swipe between original and changed"
          onChange={(e) => setPos(Number(e.target.value))}
        />
        <span className="imgdiff__rangelabel">Changed</span>
      </label>
    </div>
  );
}

/** Onion: the new image fades over the old via an opacity range slider. */
function OnionDiff({ oldSrc, newSrc, name }: { oldSrc: string; newSrc: string; name: string }) {
  const [opacity, setOpacity] = useState(50);
  return (
    <div className="imgdiff__onion">
      <div className="imgdiff__swipestage" aria-label={`Onion diff: ${name}`}>
        <img className="imgdiff__layer" src={oldSrc} alt={`Original: ${name}`} draggable={false} />
        <img
          className="imgdiff__layer imgdiff__layer--top"
          src={newSrc}
          alt={`Changed: ${name}`}
          draggable={false}
          style={{ opacity: opacity / 100 }}
        />
      </div>
      <label className="imgdiff__rangerow">
        <span className="imgdiff__rangelabel">Original</span>
        <input
          type="range"
          min={0}
          max={100}
          value={opacity}
          aria-label="Blend opacity of the changed image over the original"
          onChange={(e) => setOpacity(Number(e.target.value))}
        />
        <span className="imgdiff__rangelabel">Changed</span>
      </label>
    </div>
  );
}

function Side({
  src,
  bytes,
  label,
  name,
}: {
  src: string;
  bytes: number;
  label: string;
  name: string;
}) {
  return (
    <div className="imgdiff__side">
      <div className="imgdiff__sidehead">{label}</div>
      <ImageStage src={src} label={`${label}: ${name}`} caption={fmtBytes(bytes)} />
    </div>
  );
}

function SingleSide({
  src,
  bytes,
  label,
  sideLabel,
}: {
  src: string;
  bytes: number;
  label: string;
  sideLabel: string;
}) {
  return (
    <div className="imgdiff__single">
      <div className="imgdiff__sidehead">{sideLabel}</div>
      <ImageStage src={src} label={label} caption={fmtBytes(bytes)} />
    </div>
  );
}
