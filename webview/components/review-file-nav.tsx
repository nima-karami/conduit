import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { folderKey } from '../../src/folder-key';
import type { GitOp } from '../../src/git-actions';
import type { GitActionIntent } from '../git-intent';
import { IconReview } from '../icons';
import { type ReviewFile, reviewFileKey } from '../review-repos';
import type { ReviewScope } from '../review-scope';
import { computeWindow } from '../review-window';

/** Seed height for a file-list row before the first one is measured. Every row is identical,
 *  so one measurement corrects the whole column at any density or font scale. */
const NAV_ROW_H = 44;
/** Section headers are the list's second item height; unlike rows they are never measured. */
const NAV_SECTION_H = 28;
const NAV_GROUP_H = 28;
const NO_MEASURED = new Map<number, number>();

export type NavSection = { id: 'staged' | 'unstaged'; label: string; files: readonly ReviewFile[] };

export type NavBlock = {
  group?: { root: string; name: string; title: string; reviewed: number; total: number };
  sections: NavSection[];
};

type NavGroup = NonNullable<NavBlock['group']>;

type NavItem =
  | { kind: 'group'; group: NavGroup }
  | { kind: 'section'; section: NavSection; root: string | undefined }
  | { kind: 'file'; file: ReviewFile };

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
 * them; section and repo group headers are fixed heights in the same list.
 */
export function ReviewFileNav({
  blocks,
  activeKey,
  reviewed,
  canMark,
  onPick,
  onToggleReviewed,
  rowActions,
  onAction,
  onSectionReview,
}: {
  blocks: readonly NavBlock[];
  activeKey: string | null;
  reviewed: ReadonlySet<string>;
  canMark: (file: ReviewFile) => boolean;
  onPick: (file: ReviewFile) => void;
  onToggleReviewed: (file: ReviewFile) => void;
  rowActions?: (file: ReviewFile) => RowAction[];
  onAction?: (intent: GitActionIntent) => Promise<void> | void;
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
  for (const block of blocks) {
    if (block.group) items.push({ kind: 'group', group: block.group });
    for (const section of block.sections) {
      if (section.label !== '') items.push({ kind: 'section', section, root: block.group?.root });
      for (const file of section.files) items.push({ kind: 'file', file });
    }
  }
  const sectionReview = blocks.some((b) => b.group) ? undefined : onSectionReview;

  const heightAt = (i: number) => {
    const kind = items[i].kind;
    return kind === 'group' ? NAV_GROUP_H : kind === 'section' ? NAV_SECTION_H : rowH;
  };
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
  const activeIndex = activeKey
    ? items.findIndex((it) => it.kind === 'file' && reviewFileKey(it.file) === activeKey)
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

  const focusedKeyRef = useRef<string | null>(null);
  const prevKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentKeys = new Set<string>();
    for (const block of blocks)
      for (const section of block.sections)
        for (const file of section.files) currentKeys.add(reviewFileKey(file));
    const focusedKey = focusedKeyRef.current;
    if (focusedKey && prevKeysRef.current.has(focusedKey) && !currentKeys.has(focusedKey)) {
      scrollerRef.current?.focus();
      focusedKeyRef.current = null;
    }
    prevKeysRef.current = currentKeys;
  }, [blocks]);

  return (
    <nav
      ref={scrollerRef}
      className="review__nav"
      aria-label="Changed files"
      tabIndex={-1}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onFocus={(e) => {
        if (!(e.target as HTMLElement).closest('.review__navrow')) focusedKeyRef.current = null;
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focusedKeyRef.current = null;
      }}
    >
      <ul className="review__navlist">
        <li className="review__navpad" style={{ height: win.padTop }} aria-hidden />
        {mounted.map((it, i) =>
          it.kind === 'group' ? (
            <li
              key={`g:${folderKey(it.group.root)}`}
              className="rnav__group"
              aria-label={`${it.group.name}, ${it.group.reviewed} of ${it.group.total} reviewed`}
              title={it.group.title}
            >
              <span className="rnav__groupname">{it.group.name}</span>
              <span
                className={`rnav__groupcount${it.group.reviewed === it.group.total ? ' rnav__groupcount--done' : ''}`}
              >
                {it.group.reviewed}/{it.group.total}
              </span>
            </li>
          ) : it.kind === 'section' ? (
            <li
              key={`s:${it.root === undefined ? '' : folderKey(it.root)}:${it.section.id}`}
              className="rnav__section"
              role="presentation"
            >
              <span>{it.section.label}</span>
              {sectionReview && (
                <button
                  type="button"
                  className="iconbtn iconbtn--sm rnav__sectionreview"
                  title={SECTION_REVIEW_LABEL[it.section.id]}
                  aria-label={SECTION_REVIEW_LABEL[it.section.id]}
                  onClick={() => sectionReview(it.section.id)}
                >
                  <IconReview size={13} />
                </button>
              )}
            </li>
          ) : (
            <ReviewFileRow
              key={reviewFileKey(it.file)}
              change={it.file}
              active={reviewFileKey(it.file) === activeKey}
              reviewed={reviewed.has(reviewFileKey(it.file))}
              canMark={canMark(it.file)}
              onPick={onPick}
              onToggleReviewed={onToggleReviewed}
              actions={rowActions?.(it.file)}
              onAction={onAction}
              onFocusRow={(key) => {
                focusedKeyRef.current = key;
              }}
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
  onFocusRow,
  onMeasure,
}: {
  change: ReviewFile;
  active: boolean;
  reviewed: boolean;
  canMark: boolean;
  onPick: (file: ReviewFile) => void;
  onToggleReviewed: (file: ReviewFile) => void;
  actions?: RowAction[];
  onAction?: (intent: GitActionIntent) => Promise<void> | void;
  onFocusRow: (key: string) => void;
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
      data-root={folderKey(c.repoRoot)}
      onFocus={() => onFocusRow(reviewFileKey(c))}
    >
      <input
        type="checkbox"
        className="review__check"
        checked={reviewed}
        disabled={!canMark}
        title={canMark ? undefined : 'Loading diff…'}
        aria-label={`Mark ${c.path} reviewed`}
        onChange={() => onToggleReviewed(c)}
      />
      <button
        type="button"
        className="review__navbtn"
        aria-current={active ? 'true' : undefined}
        title={c.path}
        onClick={() => onPick(c)}
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
                void onAction({ op: a.op, path: c.path, repoRoot: c.repoRoot });
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
