import { useRef, useState } from 'react';
import type { RepoHeadModel } from '../../src/changes-view-model';
import type { RepoTag } from '../../src/repo-scan';
import type { ChangesViewMode } from '../../src/settings';
import { IconChevronDown, IconFolder, IconPin } from '../icons';
import { type RepoMenuRow, RepoPickerMenu, RepoTagPill, repoTagLabel } from './repo-picker-menu';

const STR = {
  collapse: (label: string) => `Collapse ${label}`,
  expand: (label: string) => `Expand ${label}`,
  picker: (label: string, pinned: boolean) => `Active repo: ${label}${pinned ? ', pinned' : ''}`,
  pickerMenu: 'Active repo',
  auto: 'Auto (follow context)',
  showAll: 'Show all repos',
} as const;

const isMenuKey = (e: React.KeyboardEvent) =>
  e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');

export interface RepoHeadProps {
  head: RepoHeadModel;
  view: ChangesViewMode;
  tag: RepoTag;
  collapsed: boolean;
  listId: string;
  onToggle: () => void;
  /** Active view with ≥2 repos. */
  picker?: {
    rows: RepoMenuRow[];
    pinned: boolean;
    onPick: (root: string | null) => void;
    onShowAll: () => void;
  };
  chip: React.ReactNode;
  onActivate: () => void;
  onContextMenu: (e: React.MouseEvent | React.KeyboardEvent) => void;
}

export function RepoHead({
  head,
  view,
  tag,
  collapsed,
  listId,
  onToggle,
  picker,
  chip,
  onActivate,
  onContextMenu,
}: RepoHeadProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pickerRef = useRef<HTMLButtonElement>(null);
  const onControlKey = (e: React.KeyboardEvent) => {
    if (!isMenuKey(e)) return;
    e.preventDefault();
    onContextMenu(e);
  };
  const name = (
    <span className="repo-head__name" dir="ltr">
      {head.label}
    </span>
  );

  return (
    <div
      className={`repo-head repo-head--${tag} repo-head--${view}`}
      role="group"
      aria-label={`${head.label}, ${repoTagLabel(tag)}`}
      title={head.repo.root}
      onClick={(e) => {
        if (!(e.target as Element).closest('button')) onActivate();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e);
      }}
    >
      {view === 'all' && (
        <button
          type="button"
          className={`iconbtn iconbtn--sm repo-head__chev${collapsed ? ' repo-head__chev--collapsed' : ''}`}
          aria-expanded={!collapsed}
          aria-controls={listId}
          aria-label={collapsed ? STR.expand(head.label) : STR.collapse(head.label)}
          onClick={onToggle}
          onKeyDown={onControlKey}
        >
          <IconChevronDown size={12} />
        </button>
      )}
      <IconFolder size={13} className="repo-head__glyph" />
      {view === 'active' && picker ? (
        <button
          ref={pickerRef}
          type="button"
          className="repo-head__picker"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={STR.picker(head.label, picker.pinned)}
          onClick={() => setMenuOpen((v) => !v)}
          onKeyDown={onControlKey}
        >
          {name}
          {picker.pinned && <IconPin size={11} className="repo-head__pin" />}
          <IconChevronDown size={11} className="repo-head__caret" />
        </button>
      ) : (
        name
      )}
      {view === 'all' && <RepoTagPill tag={tag} />}
      <span className="repo-head__chip">{chip}</span>
      {head.sub && (
        <span className="repo-head__sub" dir="ltr">
          {head.sub}
        </span>
      )}
      {menuOpen && picker && (
        <RepoPickerMenu
          rows={picker.rows}
          auto={{ label: STR.auto, checked: !picker.pinned }}
          footer={{
            label: STR.showAll,
            onPick: () => {
              setMenuOpen(false);
              picker.onShowAll();
            },
          }}
          ariaLabel={STR.pickerMenu}
          triggerRef={pickerRef}
          onPick={(root) => {
            setMenuOpen(false);
            picker.onPick(root);
            pickerRef.current?.focus();
          }}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}
