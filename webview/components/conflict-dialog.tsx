import { useEffect, useRef, useState } from 'react';

/**
 * Drag-and-drop / paste name-collision prompt (spec 2026-06-29-explorer-dnd-rename-polish §D).
 * Three-way: Replace (overwrite, danger) / Keep both (auto-suffix) / Cancel (skip). For a batch
 * with more conflicts queued, an "Apply to all remaining" checkbox resolves the rest in one
 * choice. Focus lands on the safe "Keep both" button; Esc cancels.
 */

export interface ConflictPrompt {
  /** The colliding basename. */
  name: string;
  /** Display name of the destination folder. */
  targetName: string;
  /** The EXISTING destination is a folder (replace warns it will be overwritten). */
  destIsDir: boolean;
  /** Item count of the existing destination folder when known (loaded in the tree). */
  destChildCount?: number;
  /** Conflicts still queued after this one (drives the "apply to all" affordance). */
  remaining: number;
}

export interface ConflictResolution {
  action: 'replace' | 'keep-both' | 'cancel';
  applyToAll: boolean;
}

export function ConflictDialog({
  prompt,
  onResolve,
}: {
  prompt: ConflictPrompt;
  onResolve: (r: ConflictResolution) => void;
}) {
  const [applyToAll, setApplyToAll] = useState(false);
  const keepBothRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    keepBothRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onResolve({ action: 'cancel', applyToAll });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onResolve, applyToAll]);

  const folderWarn = prompt.destIsDir
    ? prompt.destChildCount && prompt.destChildCount > 0
      ? ` Replacing the folder overwrites its ${prompt.destChildCount} item${prompt.destChildCount === 1 ? '' : 's'}.`
      : ' Replacing the folder overwrites its contents.'
    : '';

  return (
    <div className="modal__backdrop" onClick={() => onResolve({ action: 'cancel', applyToAll })}>
      <div className="confirm" role="alertdialog" aria-modal onClick={(e) => e.stopPropagation()}>
        <span className="confirm__title">“{prompt.name}” already exists</span>
        <p className="confirm__msg">
          An item named “{prompt.name}” already exists in “{prompt.targetName}”.{folderWarn}
        </p>
        {prompt.remaining > 0 && (
          <label className="confirm__check">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
            />
            Apply to all remaining conflicts ({prompt.remaining})
          </label>
        )}
        <div className="confirm__actions">
          <button
            className="btn"
            type="button"
            onClick={() => onResolve({ action: 'cancel', applyToAll })}
          >
            Cancel
          </button>
          <button
            ref={keepBothRef}
            className="btn"
            type="button"
            onClick={() => onResolve({ action: 'keep-both', applyToAll })}
          >
            Keep both
          </button>
          <button
            className="btn btn--danger"
            type="button"
            onClick={() => onResolve({ action: 'replace', applyToAll })}
          >
            Replace
          </button>
        </div>
      </div>
    </div>
  );
}
