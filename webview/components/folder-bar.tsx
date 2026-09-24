import type { FolderSectionModel } from '../../src/session-sections';
import { IconChevronDown, IconFolder, IconMore, IconPlus, IconRefresh } from '../icons';

const STR = {
  home: 'Home',
  attached: 'Attached',
};

export interface FolderBarProps {
  section: FolderSectionModel;
  collapsed: boolean;
  treeId: string;
  /** The anchored dir in this section, or section.path. */
  createTarget: string;
  collapseRef: React.Ref<HTMLButtonElement>;
  onToggle: () => void;
  onRefresh: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onMenu: (at: { x: number; y: number; keyboard: boolean }) => void;
}

function baseName(p: string): string {
  return (
    p
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? p
  );
}

export function FolderBar({
  section,
  collapsed,
  treeId,
  createTarget,
  collapseRef,
  onToggle,
  onRefresh,
  onNewFile,
  onNewFolder,
  onMenu,
}: FolderBarProps) {
  const { label } = section;
  const atRoot = createTarget === section.path;
  const newFile = atRoot ? `New file at root of ${label}` : `New file in ${baseName(createTarget)}`;
  const newFolder = atRoot
    ? `New folder at root of ${label}`
    : `New folder in ${baseName(createTarget)}`;
  const toggleLabel = `${collapsed ? 'Expand' : 'Collapse'} ${label}`;
  // Shift+F10 / the Menu key on any bar button opens the folder menu (spec §9).
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    e.preventDefault();
    const r = btn.getBoundingClientRect();
    onMenu({ x: r.left, y: r.bottom, keyboard: true });
  };
  return (
    <div
      className="files__bar"
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu({ x: e.clientX, y: e.clientY, keyboard: false });
      }}
    >
      <span className="files__root" title={section.path}>
        <IconFolder size={13} className="files__root-icon" />
        <bdi className="files__root-name" dir="auto">
          {section.name}
          {section.parentHint !== undefined && (
            <span className="files__root-hint"> — {section.parentHint}</span>
          )}
        </bdi>
        <span className={`files__tag files__tag--${section.kind}`}>
          {section.kind === 'home' ? STR.home : STR.attached}
        </span>
      </span>
      <button
        ref={collapseRef}
        type="button"
        className="iconbtn iconbtn--sm files__collapse"
        title={toggleLabel}
        aria-label={toggleLabel}
        aria-expanded={!collapsed}
        aria-controls={collapsed ? undefined : treeId}
        onClick={onToggle}
      >
        <IconChevronDown
          size={14}
          className={`files__bar-chev${collapsed ? '' : ' files__bar-chev--open'}`}
        />
      </button>
      <button
        type="button"
        className="iconbtn iconbtn--sm"
        title={`Refresh ${label}`}
        aria-label={`Refresh ${label}`}
        onClick={onRefresh}
      >
        <IconRefresh size={14} />
      </button>
      <button
        type="button"
        className="iconbtn iconbtn--sm"
        title={newFile}
        aria-label={newFile}
        onClick={onNewFile}
      >
        <IconPlus size={15} />
      </button>
      <button
        type="button"
        className="iconbtn iconbtn--sm"
        title={newFolder}
        aria-label={newFolder}
        onClick={onNewFolder}
      >
        <IconFolder size={15} />
      </button>
      <button
        type="button"
        className="iconbtn iconbtn--sm"
        title={`Folder actions for ${label}`}
        aria-label={`Folder actions for ${label}`}
        aria-haspopup="menu"
        onClick={(e) => {
          // The scroller's click closes any open menu; this one must survive its own click.
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          // detail 0 = keyboard activation (Enter/Space) → start the menu highlighted.
          onMenu({ x: r.left, y: r.bottom, keyboard: e.detail === 0 });
        }}
      >
        <IconMore size={14} />
      </button>
    </div>
  );
}
