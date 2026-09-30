import { useEffect, useId, useRef } from 'react';
import type { DirtyCloseCopy } from '../../src/quit-guard';
import { useFocusTrap } from '../use-focus-trap';
import { ModalLayer } from './modal-layer';

export interface DirtyCloseDialogProps {
  copy: DirtyCloseCopy;
  phase: 'ready' | 'saving';
  status: string | null;
  onSaveAll(): void;
  onDiscard(): void;
  onCancel(): void;
  onShown?: () => void;
}

export function DirtyCloseDialog({
  copy,
  phase,
  status,
  onSaveAll,
  onDiscard,
  onCancel,
  onShown,
}: DirtyCloseDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const { restoreFocus } = useFocusTrap(dialogRef);
  const titleId = useId();
  const summaryId = useId();
  const onShownRef = useRef(onShown);
  const saving = phase === 'saving';

  useEffect(() => {
    onShownRef.current?.();
  }, []);

  const cancel = () => {
    onCancel();
    restoreFocus();
  };

  return (
    <ModalLayer onDismiss={cancel}>
      <div
        ref={dialogRef}
        className="confirm confirm--files chamfer"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal
        aria-labelledby={titleId}
        aria-describedby={summaryId}
      >
        <span id={titleId} className="confirm__title">
          {copy.title}
        </span>
        <p id={summaryId} className="confirm__msg">
          {copy.summary}
        </p>
        {copy.lines.map((line) => (
          <p key={line} className="confirm__msg">
            {line}
          </p>
        ))}
        <ul className="confirm__files" aria-label="Unsaved files">
          {copy.rows.flatMap((row, i) => {
            const item = (
              <li key={row.path} className="confirm__file" title={row.title}>
                <span className="confirm__file-name">{row.name}</span>
                {row.dir && <span className="confirm__file-dir">{row.dir}</span>}
                {row.tag !== null && (
                  <span
                    className={`confirm__file-tag${row.danger ? ' confirm__file-tag--danger' : ''}`}
                  >
                    {row.tag}
                  </span>
                )}
              </li>
            );
            const opensGroup = row.group !== undefined && row.group !== copy.rows[i - 1]?.group;
            if (!opensGroup) return [item];
            return [
              <li key={`group:${row.path}`} className="confirm__file-group">
                {row.group}
              </li>,
              item,
            ];
          })}
        </ul>
        {copy.overflow > 0 && <p className="confirm__msg">and {copy.overflow} more</p>}
        <div className="confirm__status" aria-live="polite">
          {status}
        </div>
        <div className="confirm__actions">
          <button className="btn" onClick={cancel}>
            {copy.labels.cancel}
          </button>
          <button className="btn" disabled={saving} onClick={onDiscard}>
            {copy.labels.discard}
          </button>
          <button
            className="btn btn--primary"
            autoFocus
            data-modal-default
            disabled={saving}
            onClick={onSaveAll}
          >
            {saving ? copy.labels.saving : copy.labels.save}
          </button>
        </div>
      </div>
    </ModalLayer>
  );
}
