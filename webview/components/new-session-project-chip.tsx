import { useEffect, useRef, useState } from 'react';
import type { Rect } from '../../src/menu-position';
import type { Project } from '../../src/types';
import { IconChevronDown } from '../icons';
import { moveMenuFocus } from './new-session-launch-row';
import { Popover } from './popover';

export interface NewSessionProjectChipProps {
  projects: Project[];
  projectId: string | null;
  pendingName?: string;
  error?: boolean;
  onSet: (id: string | null) => void;
  onNew: (name: string) => void;
}

export function NewSessionProjectChip({
  projects,
  projectId,
  pendingName,
  error,
  onSet,
  onNew,
}: NewSessionProjectChipProps) {
  const [menu, setMenu] = useState<Rect | null>(null);
  const bodyRef = useRef<HTMLButtonElement>(null);
  const name = pendingName ?? projects.find((p) => p.id === projectId)?.name;
  const toggle = () => {
    if (menu) {
      setMenu(null);
      return;
    }
    const el = bodyRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenu({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  };
  const close = () => {
    setMenu(null);
    bodyRef.current?.focus();
  };

  return (
    <div className="ns-chiprow">
      {name === undefined ? (
        <button
          ref={bodyRef}
          type="button"
          className="ns-chip ns-chip--none"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={toggle}
        >
          No project
          <IconChevronDown size={10} className="ns-chip__caret" aria-hidden />
        </button>
      ) : (
        <div className={`ns-chip${pendingName ? ' ns-chip--pending' : ''}`}>
          <button
            ref={bodyRef}
            type="button"
            className="ns-chip__body"
            aria-label={`Project: ${name}`}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={toggle}
            onKeyDown={(e) => {
              if (e.key === 'Delete') {
                e.preventDefault();
                onSet(null);
              }
            }}
          >
            in {name}
            <IconChevronDown size={10} className="ns-chip__caret" aria-hidden />
          </button>
          <button
            type="button"
            className="ns-chip__remove"
            aria-label="Remove from project"
            title="Remove from project"
            onClick={() => onSet(null)}
          >
            ×
          </button>
        </div>
      )}
      {error && <span className="ns-chip__error">Couldn't create project</span>}
      {menu && (
        <ProjectMenu
          anchor={menu}
          triggerRef={bodyRef}
          projects={projects}
          current={pendingName ? undefined : (projectId ?? null)}
          onClose={close}
          onSet={(id) => {
            close();
            onSet(id);
          }}
          onNew={(n) => {
            close();
            onNew(n);
          }}
        />
      )}
    </div>
  );
}

function ProjectMenu({
  anchor,
  triggerRef,
  projects,
  current,
  onClose,
  onSet,
  onNew,
}: {
  anchor: Rect;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  projects: Project[];
  /** undefined while a pending name is shown: nothing in the list is the pick yet. */
  current: string | null | undefined;
  onClose: () => void;
  onSet: (id: string | null) => void;
  onNew: (name: string) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"], [role^="menuitem"]')?.focus();
  }, []);
  useEffect(() => {
    if (naming) inputRef.current?.focus();
  }, [naming]);
  const ordered = [...projects].sort((a, b) => a.order - b.order);

  return (
    <Popover
      ref={ref}
      anchor={anchor}
      align="start"
      role="menu"
      aria-label="Project"
      className="ctxmenu ns-projects"
      triggerRef={triggerRef}
      onClose={onClose}
      onKeyDown={naming ? undefined : moveMenuFocus}
    >
      <button
        type="button"
        role="menuitemradio"
        aria-checked={current === null}
        className="ctxmenu__item"
        onClick={() => onSet(null)}
      >
        No project
      </button>
      {ordered.map((p) => (
        <button
          key={p.id}
          type="button"
          role="menuitemradio"
          aria-checked={current === p.id}
          className="ctxmenu__item"
          onClick={() => onSet(p.id)}
        >
          {p.name}
        </button>
      ))}
      <div className="ctxmenu__sep" role="separator" />
      {naming ? (
        <input
          ref={inputRef}
          className="ns-input ns-projects__input"
          aria-label="Project name"
          placeholder="Project name"
          maxLength={200}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onNew(draft);
            }
          }}
        />
      ) : (
        <button
          type="button"
          role="menuitem"
          className="ctxmenu__item ns-projects__new"
          onClick={() => setNaming(true)}
        >
          + New project…
        </button>
      )}
    </Popover>
  );
}
