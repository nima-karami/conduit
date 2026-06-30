/**
 * Review-tab source picker (docs/specs/2026-06-29-review-commit-picker.md). A searchable, portaled
 * dropdown — opened from the git-band source trigger — for scoping the Review page to the working
 * tree, any recent commit, or a pasted SHA. The two-ref comparison moved to a first-class modal
 * (spec 2026-06-30-review-compare-dialog §B): the "Compare…" row now opens {@link CompareDialog}
 * instead of a nested in-band builder. Commits load via `git:history` (the host enumerates — the
 * renderer never spawns git). Mirrors {@link BranchSwitcherMenu}'s shell + keyboard model.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isStaleHistory } from '../../src/git-search';
import { clampMenuPosition } from '../../src/menu-position';
import type { CommitNode } from '../../src/protocol';
import { post, subscribe } from '../bridge';
import type { ReviewSource } from '../docs';
import { IconCheck, IconCompare, IconReview } from '../icons';
import { relativeTime } from '../relative-time';
import { filterCommitsForPicker, isPastedSha } from '../review-commit';
import { useEscapeKey } from '../use-escape-key';

const STR = {
  filterPlaceholder: 'Search commits…',
  workingTree: 'Working tree',
  loading: 'Loading commits…',
  error: "Couldn't load commits",
  retry: 'Retry',
  noCommits: 'No commits yet',
  noMatch: 'No commits match',
  current: 'Current',
  reviewCommit: (sha: string) => `Review commit ${sha}`,
  label: 'Review source',
  compare: 'Compare…',
} as const;

/** Recent-commit cap; deep history is the History view's job (spec D3). */
const HISTORY_LIMIT = 150;
/** `git:history` has no error channel, so a true non-response is caught by this timeout and
 *  surfaced as a Retry-able error row rather than an indefinite spinner (spec D7). */
const LOAD_TIMEOUT_MS = 8000;

type Phase = 'loading' | 'loaded' | 'error';

const shortSha = (sha: string) => sha.slice(0, 7);

/** A flat, keyboard-navigable row carrying the source it selects. */
interface PickerRow {
  id: string;
  source: ReviewSource;
  checked: boolean;
  render: () => React.ReactNode;
}

export function CommitPickerMenu({
  sessionId,
  source,
  triggerRef,
  onSelect,
  onClose,
  onOpenCompare,
}: {
  sessionId?: string;
  source?: ReviewSource;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onSelect: (next: ReviewSource) => void;
  onClose: () => void;
  /** Open the first-class Compare dialog (spec 2026-06-30); the caller also closes this menu. */
  onOpenCompare: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [commits, setCommits] = useState<CommitNode[]>([]);
  const [filter, setFilter] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Monotonic request id (latest-wins) — a slow earlier `git:historyResult` is dropped.
  const reqCounter = useRef(0);
  const latestReqId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEscapeKey(onClose);

  const requestHistory = useMemo(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (!sessionId) {
        setPhase('loaded');
        setCommits([]);
        return;
      }
      reqCounter.current += 1;
      latestReqId.current = reqCounter.current;
      setPhase('loading');
      post({ type: 'git:history', sessionId, limit: HISTORY_LIMIT, requestId: reqCounter.current });
      timer.current = setTimeout(() => setPhase('error'), LOAD_TIMEOUT_MS);
    },
    [sessionId],
  );

  useEffect(() => {
    requestHistory();
    const unsub = subscribe((msg) => {
      if (msg.type !== 'git:historyResult' || msg.sessionId !== sessionId) return;
      if (isStaleHistory(msg.requestId, latestReqId.current)) return;
      if (timer.current) clearTimeout(timer.current);
      setCommits(msg.commits);
      setPhase('loaded');
    });
    return () => {
      unsub();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [sessionId, requestHistory]);

  // Position below the trigger, clamped to the viewport (portaled + fixed). Re-run when the body
  // height changes (phase/filter) so a flip-above near the viewport bottom stays correct.
  // biome-ignore lint/correctness/useExhaustiveDependencies: phase/filter are reposition triggers, not read here.
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
  }, [triggerRef, phase, filter]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Dismiss on outside click / resize (mirrors BranchSwitcherMenu); the trigger is excluded so
  // its toggle click doesn't double-fire.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, triggerRef]);

  const currentSha = source?.kind === 'commit' ? source.sha : null;
  const filtered = useMemo(() => filterCommitsForPicker(commits, filter), [commits, filter]);
  const currentOffWindow =
    source?.kind === 'commit' && !commits.some((c) => c.sha === source.sha) ? source : null;
  const pastedSha = isPastedSha(filter);
  const showPasted = pastedSha !== null && filtered.length === 0;

  const rows: PickerRow[] = useMemo(() => {
    const out: PickerRow[] = [];
    out.push({
      id: `${baseId}-working`,
      source: { kind: 'working' },
      checked: !source || source.kind === 'working',
      render: () => <span className="commit-picker__working">{STR.workingTree}</span>,
    });
    if (currentOffWindow) {
      out.push({
        id: `${baseId}-current`,
        source: currentOffWindow,
        checked: true,
        render: () => (
          <>
            <span className="commit-picker__sha" dir="ltr">
              {shortSha(currentOffWindow.sha)}
            </span>
            <span className="commit-picker__subject">
              {currentOffWindow.subject ?? shortSha(currentOffWindow.sha)}
            </span>
            <span className="commit-picker__hint">{STR.current}</span>
          </>
        ),
      });
    }
    for (const c of filtered) {
      out.push({
        id: `${baseId}-c-${c.sha}`,
        source: { kind: 'commit', sha: c.sha, subject: c.subject },
        checked: c.sha === currentSha,
        render: () => (
          <>
            <span className="commit-picker__sha" dir="ltr">
              {shortSha(c.sha)}
            </span>
            <span className="commit-picker__subject" title={c.subject}>
              {c.subject}
            </span>
            <span className="commit-picker__date">{relativeTime(c.date * 1000)}</span>
          </>
        ),
      });
    }
    if (showPasted && pastedSha) {
      out.push({
        id: `${baseId}-pasted`,
        source: { kind: 'commit', sha: pastedSha },
        checked: false,
        render: () => (
          <>
            <IconReview size={13} />
            <span className="commit-picker__subject">{STR.reviewCommit(shortSha(pastedSha))}</span>
          </>
        ),
      });
    }
    return out;
  }, [baseId, source, currentSha, currentOffWindow, filtered, showPasted, pastedSha]);

  const clampedActive = Math.min(activeIndex, Math.max(rows.length - 1, 0));

  useEffect(() => {
    const id = rows[clampedActive]?.id;
    if (id)
      menuRef.current
        ?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [clampedActive, rows]);

  const selectSource = (row: PickerRow | undefined) => {
    if (!row) return;
    onSelect(row.source);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectSource(rows[clampedActive]);
    }
  };

  const status = (() => {
    if (phase === 'loading') {
      return (
        <div className="ctxmenu__item commit-picker__status" aria-disabled>
          {STR.loading}
        </div>
      );
    }
    if (phase === 'error') {
      return (
        <div className="commit-picker__status commit-picker__status--error">
          <span>{STR.error}</span>
          <button type="button" className="commit-picker__retry" onClick={requestHistory}>
            {STR.retry}
          </button>
        </div>
      );
    }
    if (commits.length === 0) {
      return (
        <div className="ctxmenu__item commit-picker__status" aria-disabled>
          {STR.noCommits}
        </div>
      );
    }
    if (filtered.length === 0 && !showPasted) {
      return (
        <div className="ctxmenu__item commit-picker__status" aria-disabled>
          {STR.noMatch}
        </div>
      );
    }
    return null;
  })();

  return createPortal(
    <div
      ref={menuRef}
      className="ctxmenu git-branch-menu commit-picker"
      style={{
        left: pos?.x ?? -9999,
        top: pos?.y ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
      role="menu"
      aria-label={STR.label}
      aria-busy={phase === 'loading'}
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        type="text"
        className="git-branch-menu__filter"
        placeholder={STR.filterPlaceholder}
        value={filter}
        role="combobox"
        aria-expanded
        aria-controls={`${baseId}-list`}
        aria-activedescendant={rows[clampedActive]?.id}
        aria-label={STR.filterPlaceholder}
        onChange={(e) => {
          setFilter(e.target.value);
          setActiveIndex(0);
        }}
      />

      <div id={`${baseId}-list`} className="commit-picker__list">
        {rows.map((row, i) => (
          <button
            key={row.id}
            id={row.id}
            type="button"
            role="menuitemradio"
            aria-checked={row.checked}
            className={`ctxmenu__item commit-picker__row${i === clampedActive ? ' ctxmenu__item--active' : ''}`}
            onMouseEnter={() => setActiveIndex(i)}
            onClick={() => selectSource(row)}
          >
            <span className="ctxmenu__icon">
              {row.checked ? <IconCheck size={13} /> : <span style={{ width: 13 }} />}
            </span>
            {row.render()}
          </button>
        ))}
      </div>

      {status}

      <button type="button" className="commit-picker__compare-entry" onClick={onOpenCompare}>
        <IconCompare size={13} />
        <span>{STR.compare}</span>
      </button>
    </div>,
    document.body,
  );
}
