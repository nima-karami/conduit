import { useEffect, useId, useRef } from 'react';
import type { DirtyCloseCopy, DirtyCloseRow } from '../../src/quit-guard';
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

function FileRow({ row }: { row: DirtyCloseRow }) {
  return (
    <li className="confirm__file" title={row.title}>
      <span className="confirm__file-name">{row.name}</span>
      {row.dir && <span className="confirm__file-dir">{row.dir}</span>}
      {row.tag !== null && (
        <span className={`confirm__file-tag${row.danger ? ' confirm__file-tag--danger' : ''}`}>
          {row.tag}
        </span>
      )}
    </li>
  );
}

function FileGroup({ name, rows }: { name: string; rows: DirtyCloseRow[] }) {
  const labelId = useId();
  return (
    <li className="confirm__group">
      <div id={labelId} className="confirm__file-group">
        {name}
      </div>
      <ul className="confirm__group-files" aria-labelledby={labelId}>
        {rows.map((row) => (
          <FileRow key={row.path} row={row} />
        ))}
      </ul>
    </li>
  );
}

type Run = { group: string | undefined; rows: DirtyCloseRow[] };

function runsOf(rows: DirtyCloseRow[]): Run[] {
  const runs: Run[] = [];
  for (const row of rows) {
    const last = runs[runs.length - 1];
    if (last && last.group === row.group) last.rows.push(row);
    else runs.push({ group: row.group, rows: [row] });
  }
  return runs;
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

  const guard = (action: () => void) => () => {
    if (!saving) action();
  };

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
          {runsOf(copy.rows).flatMap((run) =>
            run.group === undefined
              ? run.rows.map((row) => <FileRow key={row.path} row={row} />)
              : [<FileGroup key={`group:${run.rows[0].path}`} name={run.group} rows={run.rows} />],
          )}
        </ul>
        {copy.overflow > 0 && <p className="confirm__msg">and {copy.overflow} more</p>}
        <div className="confirm__status" aria-live="polite">
          {status}
        </div>
        <div className="confirm__actions">
          <button className="btn" onClick={cancel}>
            {copy.labels.cancel}
          </button>
          {/* aria-disabled, not disabled: disabling the focused button drops focus out of the trap (spec §10) */}
          <button className="btn" aria-disabled={saving || undefined} onClick={guard(onDiscard)}>
            {copy.labels.discard}
          </button>
          <button
            className="btn btn--primary"
            autoFocus
            data-modal-default
            aria-disabled={saving || undefined}
            onClick={guard(onSaveAll)}
          >
            {saving ? copy.labels.saving : copy.labels.save}
          </button>
        </div>
      </div>
    </ModalLayer>
  );
}
