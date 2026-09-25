/**
 * Repo picker dropdown (multi-repo awareness). Lists the session's repos (name, tag, sub-path),
 * optionally led by an "Auto" row that unpins and followed by a footer action. Reuses the app's
 * `.ctxmenu` styling: portaled + fixed, clamped to the viewport, ↑/↓ + Enter + Esc,
 * outside-click/scroll/resize close. The host validates the chosen root — the renderer never
 * spawns git.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clampMenuPosition } from '../../src/menu-position';
import type { RepoTag } from '../../src/repo-scan';
import { IconCheck } from '../icons';
import { useOverlayEntry } from '../use-overlay-entry';

const TAG_LABEL: Record<RepoTag, string> = {
  home: 'Home',
  nested: 'Nested',
  attached: 'Attached',
};

export const repoTagLabel = (tag: RepoTag): string => TAG_LABEL[tag];

export function RepoTagPill({ tag }: { tag: RepoTag }) {
  return <span className={`repo-head__tag repo-head__tag--${tag}`}>{TAG_LABEL[tag]}</span>;
}

export interface RepoMenuRow {
  root: string;
  name: string;
  tag: RepoTag;
  sub?: string;
  checked: boolean;
}

type Entry =
  | { kind: 'auto'; label: string; checked: boolean }
  | { kind: 'repo'; row: RepoMenuRow }
  | { kind: 'footer'; label: string; onPick: () => void };

export function RepoPickerMenu({
  rows,
  auto,
  footer,
  triggerRef,
  ariaLabel,
  onPick,
  onClose,
}: {
  rows: RepoMenuRow[];
  /** Absent → no Auto row. */
  auto?: { label: string; checked: boolean };
  /** Rendered after a separator. */
  footer?: { label: string; onPick: () => void };
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  ariaLabel: string;
  /** `null` = the Auto row. */
  onPick: (root: string | null) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const entries: Entry[] = [
    ...(auto ? [{ kind: 'auto' as const, ...auto }] : []),
    ...rows.map((row) => ({ kind: 'repo' as const, row })),
    ...(footer ? [{ kind: 'footer' as const, ...footer }] : []),
  ];
  const [activeIndex, setActiveIndex] = useState(() => {
    const i = entries.findIndex((e) =>
      e.kind === 'auto' ? e.checked : e.kind === 'repo' && e.row.checked,
    );
    return i >= 0 ? i : 0;
  });

  useOverlayEntry('popover', onClose);

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

  const pickEntry = (e: Entry) => {
    if (e.kind === 'auto') onPick(null);
    else if (e.kind === 'repo') onPick(e.row.root);
    else e.onPick();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, entries.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = entries[activeIndex];
      if (entry) pickEntry(entry);
    }
  };

  const itemClass = (i: number) =>
    `ctxmenu__item repo-picker-menu__row${activeIndex === i ? ' ctxmenu__item--active' : ''}`;
  const check = (on: boolean) => (
    <span className="ctxmenu__icon">
      {on ? <IconCheck size={13} /> : <span className="repo-picker-menu__nocheck" />}
    </span>
  );

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
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      tabIndex={0}
    >
      {entries.flatMap((e, i) => {
        if (e.kind === 'footer')
          return [
            <div key="footer-sep" className="ctxmenu__sep" />,
            <button
              key="footer"
              type="button"
              role="menuitem"
              className={itemClass(i)}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => pickEntry(e)}
            >
              {check(false)}
              <span className="repo-picker-menu__name">{e.label}</span>
            </button>,
          ];
        const checked = e.kind === 'auto' ? e.checked : e.row.checked;
        return [
          <button
            key={e.kind === 'auto' ? 'auto' : e.row.root}
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            className={itemClass(i)}
            onMouseEnter={() => setActiveIndex(i)}
            onClick={() => pickEntry(e)}
          >
            {check(checked)}
            {e.kind === 'auto' ? (
              <span className="repo-picker-menu__name">{e.label}</span>
            ) : (
              <span className="repo-picker-menu__text">
                <span className="repo-picker-menu__line">
                  <span className="repo-picker-menu__name" dir="ltr" title={e.row.root}>
                    {e.row.name}
                  </span>
                  <RepoTagPill tag={e.row.tag} />
                </span>
                {e.row.sub && (
                  <span className="repo-picker-menu__sub" dir="ltr">
                    {e.row.sub}
                  </span>
                )}
              </span>
            )}
          </button>,
        ];
      })}
    </div>,
    document.body,
  );
}
