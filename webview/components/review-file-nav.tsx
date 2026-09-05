import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GitOp } from '../../src/git-actions';
import type { ChangeDTO } from '../../src/protocol';
import type { GitActionIntent } from '../git-intent';
import { IconReview } from '../icons';
import type { ReviewScope } from '../review-scope';
import { computeWindow } from '../review-window';

/** Seed height for a file-list row before the first one is measured. Every row is identical,
 *  so one measurement corrects the whole column at any density or font scale. */
const NAV_ROW_H = 44;
/** Section headers are the list's second item height; unlike rows they are never measured. */
const NAV_SECTION_H = 28;
const NO_MEASURED = new Map<number, number>();

export type NavSection = { id: 'staged' | 'unstaged'; label: string; files: readonly ChangeDTO[] };

type NavItem = { kind: 'section'; section: NavSection } | { kind: 'file'; file: ChangeDTO };

type RowAction = { label: string; op: GitOp; danger?: boolean; title: string };

const SECTION_REVIEW_LABEL: Record<NavSection['id'], string> = {
  staged: 'Review staged changes',
  unstaged: 'Review unstaged changes',
};

/**
 * The Review file list: one row per changed file — reviewed checkbox, status badge, name over
 * directory, `+n −m`. Clicking the name scrolls that file's card to the top. A row with no line
 * changes (binary/image, or a mode-only change) shows `—`, mirroring the card header, which shows
 * no `+/−` when both counts are 0.
 *
 * Windowed on the SAME `computeWindow` the card list uses: the review surface is the one most
 * likely to be pointed at a thousand-file diff, and a column that mounted every row would undo
 * the card list's virtualization. File rows are uniform, so one measured row calibrates all of
 * them; section headers are a fixed second height in the same list.
 */
export function ReviewFileNav({
  sections,
  activePath,
  reviewed,
  canMark,
  onPick,
  onToggleReviewed,
  rowActions,
  onAction,
  onSectionReview,
}: {
  sections: readonly NavSection[];
  activePath: string | null;
  reviewed: ReadonlySet<string>;
  canMark: (path: string) => boolean;
  onPick: (path: string) => void;
  onToggleReviewed: (path: string) => void;
  rowActions?: (file: ChangeDTO) => RowAction[];
  onAction?: (intent: GitActionIntent) => void;
  onSectionReview?: (scope: ReviewScope) => void;
}) {
  const scrollerRef = useRef<HTMLElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [rowH, setRowH] = useState(NAV_ROW_H);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const items: NavItem[] = [];
  for (const section of sections) {
    if (section.label !== '') items.push({ kind: 'section', section });
    for (const file of section.files) items.push({ kind: 'file', file });
  }

  const heightAt = (i: number) => (items[i].kind === 'section' ? NAV_SECTION_H : rowH);
  const win = computeWindow({
    count: items.length,
    scrollTop,
    viewportHeight,
    overscanPx: viewportHeight,
    estimate: heightAt,
    measured: NO_MEASURED,
  });

  // Follow the card scroller: keep the highlighted row on screen without a DOM read, since the
  // active row is often not mounted (that is the whole point of the window).
  const activeIndex = activePath
    ? items.findIndex((it) => it.kind === 'file' && it.file.path === activePath)
    : -1;
  let activeTop = 0;
  for (let i = 0; i < activeIndex; i++) activeTop += heightAt(i);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || activeIndex < 0 || viewportHeight === 0) return;
    if (activeTop < el.scrollTop) el.scrollTop = activeTop;
    else if (activeTop + rowH > el.scrollTop + viewportHeight)
      el.scrollTop = activeTop + rowH - viewportHeight;
  }, [activeIndex, activeTop, rowH, viewportHeight]);

  const mounted =
    win.endIndex >= win.startIndex ? items.slice(win.startIndex, win.endIndex + 1) : [];
  const firstFile = mounted.findIndex((it) => it.kind === 'file');

  const prevPathsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentPaths = new Set<string>();
    for (const section of sections) for (const file of section.files) currentPaths.add(file.path);
    const focusedRow = document.activeElement?.closest('.review__navrow');
    const focusedPath = focusedRow?.getAttribute('data-path');
    if (focusedPath && prevPathsRef.current.has(focusedPath) && !currentPaths.has(focusedPath)) {
      scrollerRef.current?.focus();
    }
    prevPathsRef.current = currentPaths;
  }, [sections]);

  return (
    <nav
      ref={scrollerRef}
      className="review__nav"
      aria-label="Changed files"
      tabIndex={-1}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <ul className="review__navlist">
        <li className="review__navpad" style={{ height: win.padTop }} aria-hidden />
        {mounted.map((it, i) =>
          it.kind === 'section' ? (
            <li key={`s:${it.section.id}`} className="rnav__section" role="presentation">
              <span>{it.section.label}</span>
              {onSectionReview && (
                <button
                  type="button"
                  className="iconbtn iconbtn--sm rnav__sectionreview"
                  title={SECTION_REVIEW_LABEL[it.section.id]}
                  aria-label={SECTION_REVIEW_LABEL[it.section.id]}
                  onClick={() => onSectionReview(it.section.id)}
                >
                  <IconReview size={13} />
                </button>
              )}
            </li>
          ) : (
            <ReviewFileRow
              key={it.file.path}
              change={it.file}
              active={it.file.path === activePath}
              reviewed={reviewed.has(it.file.path)}
              canMark={canMark(it.file.path)}
              onPick={onPick}
              onToggleReviewed={onToggleReviewed}
              actions={rowActions?.(it.file)}
              onAction={onAction}
              onMeasure={i === firstFile ? setRowH : undefined}
            />
          ),
        )}
        <li className="review__navpad" style={{ height: win.padBottom }} aria-hidden />
      </ul>
    </nav>
  );
}

function ReviewFileRow({
  change: c,
  active,
  reviewed,
  canMark,
  onPick,
  onToggleReviewed,
  actions,
  onAction,
  onMeasure,
}: {
  change: ChangeDTO;
  active: boolean;
  reviewed: boolean;
  canMark: boolean;
  onPick: (path: string) => void;
  onToggleReviewed: (path: string) => void;
  actions?: RowAction[];
  onAction?: (intent: GitActionIntent) => void;
  /** Set on the first mounted row only — calibrates the window's uniform row height. */
  onMeasure?: (h: number) => void;
}) {
  const parts = c.path.split('/');
  const name = parts.pop() ?? c.path;
  const dir = parts.join('/');
  const noLines = c.added === 0 && c.removed === 0;

  const rowRef = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el || !onMeasure) return;
    const report = () => onMeasure(el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onMeasure]);

  return (
    <li
      ref={rowRef}
      className={`review__navrow${active ? ' review__navrow--active' : ''}${reviewed ? ' review__navrow--done' : ''}`}
      data-path={c.path}
    >
      <input
        type="checkbox"
        className="review__check"
        checked={reviewed}
        disabled={!canMark}
        title={canMark ? undefined : 'Loading diff…'}
        aria-label={`Mark ${c.path} reviewed`}
        onChange={() => onToggleReviewed(c.path)}
      />
      <button
        type="button"
        className="review__navbtn"
        aria-current={active ? 'true' : undefined}
        title={c.path}
        onClick={() => onPick(c.path)}
      >
        <span className={`change__kind change__kind--${c.kind}`}>{c.kind}</span>
        <span className="review__navpath">
          <span className="review__navname">{name}</span>
          {dir && <span className="review__navdir">{dir}</span>}
        </span>
        <span className="review__navstat">
          {noLines ? (
            <span className="review__navdash">—</span>
          ) : (
            <>
              {c.added > 0 && <span className="diffstat--add">+{c.added}</span>}
              {c.removed > 0 && <span className="diffstat--del"> −{c.removed}</span>}
            </>
          )}
        </span>
      </button>
      {actions && actions.length > 0 && onAction && (
        <span className="change__row-actions">
          {actions.map((a) => (
            <button
              key={a.op}
              type="button"
              className={`change__action ${a.danger ? 'change__action--danger' : ''}`}
              title={a.title}
              onClick={(e) => {
                e.stopPropagation();
                onAction({ op: a.op, path: c.path });
              }}
            >
              {a.label}
            </button>
          ))}
        </span>
      )}
    </li>
  );
}
