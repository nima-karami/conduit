import { useEffect, useId, useRef, useState } from 'react';
import { normalizeProjectName } from '../../src/project-name';
import {
  groupKeyOf,
  type PickerRow,
  projectPickerRows,
  STANDALONE_KEY,
} from '../../src/session-groups';
import type { Project, Session } from '../../src/types';
import { requestHost } from '../host-request';
import { IconCheck } from '../icons';
import { projectAnnouncer } from '../project-announcer';
import { Popover } from './popover';

const NAME_HINT = '1–80 characters';

/** Move to project… (mf-sidebar spec §2.7): pick a project, Standalone, or create one. */
export function ProjectPicker({
  session,
  projects,
  at,
  onClose,
}: {
  session: Session | undefined;
  projects: Project[];
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const baseId = useId();
  const [filter, setFilter] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The disabled attribute lands a render late; a second Enter must not post a second create.
  const busyRef = useRef(false);
  const alive = useRef(true);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Closed, or moved to another window: nothing to file (spec §2.7 lifecycle).
  useEffect(() => {
    if (!session) onClose();
  }, [session, onClose]);

  if (!session) return null;

  const { rows, noMatch } = projectPickerRows(projects, filter, groupKeyOf(session, projects));
  const newIndex = rows.length;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const pick = (row: PickerRow) => {
    if (!row.current) {
      projectAnnouncer.moveSession(session.id, row.key === STANDALONE_KEY ? null : row.key, {
        session: session.name,
        target: row.label,
      });
    }
    onClose();
  };

  const startCreating = () => {
    setDraft(filter);
    setHint(null);
    setCreating(true);
  };

  const backToList = () => {
    setCreating(false);
    setHint(null);
    filterRef.current?.focus();
  };

  const create = async (raw: string) => {
    if (busyRef.current) return;
    const name = normalizeProjectName(raw);
    if (name === null) {
      setHint(NAME_HINT);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setHint(null);
    const reply = await requestHost(
      (requestId) => ({ type: 'project:create', name, requestId }),
      ['project:created', 'project:opResult'],
      5000,
    );
    if (!alive.current) return;
    busyRef.current = false;
    setBusy(false);
    if (reply?.type === 'project:created') {
      projectAnnouncer.moveSession(session.id, reply.id, { session: session.name, target: name });
      onClose();
    } else if (reply?.type === 'project:opResult') {
      setHint(reply.reason === 'invalid-name' ? NAME_HINT : "Couldn't create project");
    }
  };

  const onListKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = newIndex + 1;
      setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const i = Math.min(highlight, newIndex);
      if (i === newIndex) startCreating();
      else pick(rows[i]);
    }
  };

  // Rows are clicked without taking focus from the input that drives the keyboard.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <Popover
      at={at}
      onClose={onClose}
      onEscape={creating ? backToList : onClose}
      className="ctxmenu projpicker"
      style={{ width: 200 }}
      role="listbox"
      aria-label={`Move ${session.name} to project`}
      aria-activedescendant={creating ? undefined : optionId(Math.min(highlight, newIndex))}
    >
      <input
        ref={filterRef}
        className="projpicker__filter"
        placeholder="Filter projects…"
        aria-label="Filter projects"
        autoFocus
        value={filter}
        readOnly={creating}
        onChange={(e) => {
          setFilter(e.target.value);
          setHighlight(0);
        }}
        onKeyDown={creating ? undefined : onListKey}
      />
      {noMatch && (
        <div className="projpicker__none" aria-disabled="true">
          No projects match
        </div>
      )}
      {rows.map((row, i) => (
        <div
          key={row.key}
          id={optionId(i)}
          role="option"
          aria-selected={row.current}
          title={row.label}
          className={`projpicker__row${!creating && i === highlight ? ' projpicker__row--active' : ''}`}
          onMouseDown={keepFocus}
          onMouseEnter={() => setHighlight(i)}
          onClick={() => pick(row)}
        >
          <span className="projpicker__label">{row.label}</span>
          {row.current && <IconCheck size={13} className="projpicker__check" />}
        </div>
      ))}
      <div className="ctxmenu__sep" />
      {creating ? (
        <div className="projpicker__create">
          <input
            className="projpicker__name"
            aria-label="New project name"
            placeholder="Project name"
            autoFocus
            value={draft}
            disabled={busy}
            onChange={(e) => {
              setDraft(e.target.value);
              setHint(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void create(e.currentTarget.value);
              }
            }}
          />
          {hint && <span className="projpicker__hint">{hint}</span>}
        </div>
      ) : (
        <div
          id={optionId(newIndex)}
          role="option"
          aria-selected={false}
          className={`projpicker__row projpicker__new${highlight >= newIndex ? ' projpicker__row--active' : ''}`}
          onMouseDown={keepFocus}
          onMouseEnter={() => setHighlight(newIndex)}
          onClick={startCreating}
        >
          + New project…
        </div>
      )}
    </Popover>
  );
}
