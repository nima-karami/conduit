/**
 * Repo picker dropdown (multi-repo awareness). Opens from the RepoPicker trigger and lists the
 * detected sub-repos plus a top "Auto" entry that unpins (resumes context-following). Reuses the
 * app's `.ctxmenu` styling and the BranchSwitcherMenu interaction pattern: portaled + fixed,
 * clamped to the viewport, ↑/↓ + Enter + Esc, outside-click/scroll/resize close. Picking a repo
 * pins it; picking "Auto" clears the pin. The host validates the chosen root — the renderer
 * never spawns git.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clampMenuPosition } from '../../src/menu-position';
import type { RepoInfo } from '../../src/protocol';
import { IconCheck } from '../icons';
import { useEscapeKey } from '../use-escape-key';

export function RepoPickerMenu({
  repos,
  activeRepoRoot,
  pinned,
  autoLabel,
  triggerRef,
  onPick,
  onClose,
}: {
  repos: RepoInfo[];
  activeRepoRoot?: string;
  pinned?: boolean;
  autoLabel: string;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** `null` = pick the "Auto" (unpin) row; a string = pin that repo root. */
  onPick: (root: string | null) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // Row 0 is "Auto"; rows 1..n are repos. Active row starts on the current selection.
  const initialIndex = useMemo(() => {
    if (!pinned) return 0;
    const i = repos.findIndex((r) => r.root === activeRepoRoot);
    return i >= 0 ? i + 1 : 0;
  }, [pinned, repos, activeRepoRoot]);
  const [activeIndex, setActiveIndex] = useState(initialIndex);

  useEscapeKey(onClose);

  useEffect(() => {
    const t = triggerRef.current;
    const el = menuRef.current;
    if (!t || !el) return;
    const r = t.getBoundingClientRect();
    const m = el.getBoundingClientRect();
    setPos(
      clampMenuPosition(
        { x: r.left, y: r.bottom + 2 },
        { width: m.width, height: m.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [triggerRef]);

  // Focus the menu on open so the roving ↑/↓/Enter keyboard nav works without a click.
  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose, triggerRef]);

  const rowCount = repos.length + 1; // +1 for the Auto row
  const pickIndex = (i: number) => {
    if (i === 0) onPick(null);
    else onPick(repos[i - 1].root);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, rowCount - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickIndex(activeIndex);
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      className="ctxmenu repo-picker-menu"
      style={{
        left: pos?.x ?? -9999,
        top: pos?.y ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
      role="menu"
      aria-label="Active repo"
      onKeyDown={onKeyDown}
      tabIndex={0}
    >
      <button
        type="button"
        role="menuitemradio"
        aria-checked={!pinned}
        className={`ctxmenu__item repo-picker-menu__row${
          activeIndex === 0 ? ' ctxmenu__item--active' : ''
        }`}
        onMouseEnter={() => setActiveIndex(0)}
        onClick={() => onPick(null)}
      >
        <span className="ctxmenu__icon">
          {!pinned ? <IconCheck size={13} /> : <span style={{ width: 13 }} />}
        </span>
        <span className="repo-picker-menu__name">{autoLabel}</span>
      </button>

      {repos.map((r, i) => {
        const isActive = r.root === activeRepoRoot && pinned;
        const idx = i + 1;
        return (
          <button
            key={r.root}
            type="button"
            role="menuitemradio"
            aria-checked={isActive}
            className={`ctxmenu__item repo-picker-menu__row${
              activeIndex === idx ? ' ctxmenu__item--active' : ''
            }`}
            onMouseEnter={() => setActiveIndex(idx)}
            onClick={() => onPick(r.root)}
          >
            <span className="ctxmenu__icon">
              {isActive ? <IconCheck size={13} /> : <span style={{ width: 13 }} />}
            </span>
            <span className="repo-picker-menu__name" dir="ltr">
              {r.name}
            </span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
