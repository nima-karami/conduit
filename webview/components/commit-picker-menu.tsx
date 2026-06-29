/**
 * Review-tab source picker (docs/specs/2026-06-29-review-commit-picker.md +
 * 2026-06-29-review-changes-polish item 4). A searchable, portaled dropdown — opened from the
 * git-band source trigger — for scoping the Review page to the working tree, any recent commit /
 * pasted SHA, OR a comparison of two refs (base…head).
 *
 * It is a small push/pop VIEW STACK inside one portaled menu (no nested overlays, so focus stays
 * linear): `list` (working + commits + Compare…) → `compare` (Base/Target fields) → an endpoint
 * sub-picker (`pickBase`/`pickHead`: branches + commits, plus the working tree for the target).
 * Esc pops one level; Back returns to the previous view. Commits load via `git:history`, branches
 * via `git:refs` (host enumerates — the renderer never spawns git, and the host re-validates every
 * ref it is asked to diff). Mirrors {@link BranchSwitcherMenu}'s shell + keyboard model.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { dotModeFor, endpointLabel, type RefEndpoint } from '../../src/git-range';
import { isStaleHistory } from '../../src/git-search';
import { clampMenuPosition } from '../../src/menu-position';
import type { CommitNode } from '../../src/protocol';
import { post, subscribe } from '../bridge';
import type { ReviewSource } from '../docs';
import { IconBranch, IconCheck, IconChevron, IconReview } from '../icons';
import { relativeTime } from '../relative-time';
import { filterCommitsForPicker, isPastedSha } from '../review-commit';
import { useEscapeKey } from '../use-escape-key';

const STR = {
  filterPlaceholder: 'Search commits…',
  searchRefs: 'Search branches & commits…',
  workingTree: 'Working tree',
  loading: 'Loading commits…',
  error: "Couldn't load commits",
  retry: 'Retry',
  noCommits: 'No commits yet',
  noMatch: 'No commits match',
  noRefMatch: 'No branches or commits match',
  current: 'Current',
  reviewCommit: (sha: string) => `Review commit ${sha}`,
  label: 'Review source',
  compare: 'Compare…',
  compareTitle: 'Compare changes',
  chooseBase: 'Choose base',
  chooseTarget: 'Choose target',
  base: 'Base',
  target: 'Target',
  choose: 'Choose…',
  doCompare: 'Compare',
  back: 'Back',
} as const;

/** Recent-commit cap; deep history is the History view's job (spec D3). */
const HISTORY_LIMIT = 150;
/** `git:history` has no error channel, so a true non-response is caught by this timeout and
 *  surfaced as a Retry-able error row rather than an indefinite spinner (spec D7). */
const LOAD_TIMEOUT_MS = 8000;

type Phase = 'loading' | 'loaded' | 'error';
type PickerView = 'list' | 'compare' | 'pickBase' | 'pickHead';

const shortSha = (sha: string) => sha.slice(0, 7);

/** A flat, keyboard-navigable row carrying the source it selects (list view). */
interface PickerRow {
  id: string;
  source: ReviewSource;
  checked: boolean;
  render: () => React.ReactNode;
}
/** A flat, keyboard-navigable row carrying the endpoint it selects (sub-picker views). */
interface EndpointRow {
  id: string;
  endpoint: RefEndpoint;
  render: () => React.ReactNode;
}

export function CommitPickerMenu({
  sessionId,
  source,
  triggerRef,
  onSelect,
  onClose,
}: {
  sessionId?: string;
  source?: ReviewSource;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onSelect: (next: ReviewSource) => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [commits, setCommits] = useState<CommitNode[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [view, setView] = useState<PickerView>('list');
  const [compareBase, setCompareBase] = useState<RefEndpoint | null>(null);
  const [compareHead, setCompareHead] = useState<RefEndpoint | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseFieldRef = useRef<HTMLButtonElement>(null);
  const baseId = useId();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Monotonic request id (latest-wins) — a slow earlier `git:historyResult` is dropped.
  const reqCounter = useRef(0);
  const latestReqId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Esc pops one view level (sub-picker → compare → list); only Esc at the list closes the menu.
  useEscapeKey(() => {
    if (view === 'list') return onClose();
    if (view === 'pickBase' || view === 'pickHead') return setView('compare');
    setView('list');
  });

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
    if (sessionId) post({ type: 'git:refs', sessionId });
    const unsub = subscribe((msg) => {
      if (msg.type === 'git:refsResult' && msg.sessionId === sessionId) {
        setBranches(msg.branches);
        return;
      }
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
  // height changes (phase/filter/view) so a flip-above near the viewport bottom stays correct.
  // biome-ignore lint/correctness/useExhaustiveDependencies: phase/filter/view are reposition triggers, not read here.
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
  }, [triggerRef, phase, filter, view]);

  // Focus the right control per view; reset the filter + active row on a view change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run on view change only.
  useEffect(() => {
    setFilter('');
    setActiveIndex(0);
    if (view === 'compare') baseFieldRef.current?.focus();
    else inputRef.current?.focus();
  }, [view]);

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

  // ── List-view rows (working / current-off-window / commits / pasted-sha) ──────────────────
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

  // ── Endpoint sub-picker rows (branches + commits; working tree only for the target) ───────
  const wantWorking = view === 'pickHead'; // base is committish-only (D8)
  const endpointRows: EndpointRow[] = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const out: EndpointRow[] = [];
    if (wantWorking && (!q || STR.workingTree.toLowerCase().includes(q))) {
      out.push({
        id: `${baseId}-ep-working`,
        endpoint: { kind: 'working' },
        render: () => <span className="commit-picker__working">{STR.workingTree}</span>,
      });
    }
    for (const b of branches.filter((b) => !q || b.toLowerCase().includes(q))) {
      out.push({
        id: `${baseId}-ep-b-${b}`,
        endpoint: { kind: 'branch', ref: b },
        render: () => (
          <>
            <IconBranch size={12} />
            <span className="commit-picker__subject" title={b}>
              {b}
            </span>
          </>
        ),
      });
    }
    for (const c of filterCommitsForPicker(commits, filter)) {
      out.push({
        id: `${baseId}-ep-c-${c.sha}`,
        endpoint: { kind: 'commit', sha: c.sha, subject: c.subject },
        render: () => (
          <>
            <span className="commit-picker__sha" dir="ltr">
              {shortSha(c.sha)}
            </span>
            <span className="commit-picker__subject" title={c.subject}>
              {c.subject}
            </span>
          </>
        ),
      });
    }
    return out;
  }, [baseId, branches, commits, filter, wantWorking]);

  const isSubPicker = view === 'pickBase' || view === 'pickHead';
  const navRows = view === 'list' ? rows.length : isSubPicker ? endpointRows.length : 0;
  const clampedActive = Math.min(activeIndex, Math.max(navRows - 1, 0));

  useEffect(() => {
    const id =
      view === 'list'
        ? rows[clampedActive]?.id
        : isSubPicker
          ? endpointRows[clampedActive]?.id
          : '';
    if (id)
      menuRef.current
        ?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [clampedActive, rows, endpointRows, view, isSubPicker]);

  const selectSource = (row: PickerRow | undefined) => {
    if (!row) return;
    onSelect(row.source);
    onClose();
  };
  const selectEndpoint = (row: EndpointRow | undefined) => {
    if (!row) return;
    if (view === 'pickBase') setCompareBase(row.endpoint);
    else setCompareHead(row.endpoint);
    setView('compare');
  };
  const confirmCompare = () => {
    if (!compareBase || !compareHead) return;
    if (dotModeFor(compareBase, compareHead) === 'working') {
      onSelect({ kind: 'working' });
    } else {
      onSelect({ kind: 'range', base: compareBase, head: compareHead });
    }
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (view === 'compare') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(navRows - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (view === 'list') selectSource(rows[clampedActive]);
      else if (isSubPicker) selectEndpoint(endpointRows[clampedActive]);
    }
  };

  const viewLabel =
    view === 'compare'
      ? STR.compareTitle
      : view === 'pickBase'
        ? STR.chooseBase
        : view === 'pickHead'
          ? STR.chooseTarget
          : STR.label;

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
      aria-label={viewLabel}
      aria-busy={phase === 'loading' && view === 'list'}
      onKeyDown={onKeyDown}
    >
      {view === 'compare' ? (
        <CompareBuilder
          baseFieldRef={baseFieldRef}
          base={compareBase}
          head={compareHead}
          onBack={() => setView('list')}
          onPickBase={() => setView('pickBase')}
          onPickHead={() => setView('pickHead')}
          onConfirm={confirmCompare}
        />
      ) : isSubPicker ? (
        <>
          <SubHeader title={viewLabel} onBack={() => setView('compare')} />
          <input
            ref={inputRef}
            type="text"
            className="git-branch-menu__filter"
            placeholder={STR.searchRefs}
            value={filter}
            role="combobox"
            aria-expanded
            aria-controls={`${baseId}-eplist`}
            aria-activedescendant={endpointRows[clampedActive]?.id}
            aria-label={STR.searchRefs}
            onChange={(e) => {
              setFilter(e.target.value);
              setActiveIndex(0);
            }}
          />
          <div id={`${baseId}-eplist`} className="commit-picker__list">
            {endpointRows.map((row, i) => (
              <button
                key={row.id}
                id={row.id}
                type="button"
                role="menuitem"
                className={`ctxmenu__item commit-picker__row${i === clampedActive ? ' ctxmenu__item--active' : ''}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => selectEndpoint(row)}
              >
                <span className="ctxmenu__icon">
                  <span style={{ width: 13 }} />
                </span>
                {row.render()}
              </button>
            ))}
          </div>
          {endpointRows.length === 0 && (
            <div className="ctxmenu__item commit-picker__status" aria-disabled>
              {STR.noRefMatch}
            </div>
          )}
        </>
      ) : (
        <ListView
          baseId={baseId}
          inputRef={inputRef}
          rows={rows}
          clampedActive={clampedActive}
          filter={filter}
          phase={phase}
          commitsLen={commits.length}
          filteredLen={filtered.length}
          showPasted={showPasted}
          onFilter={(v) => {
            setFilter(v);
            setActiveIndex(0);
          }}
          onActive={setActiveIndex}
          onSelect={selectSource}
          onRetry={requestHistory}
          onCompare={() => setView('compare')}
        />
      )}
    </div>,
    document.body,
  );
}

/** Back affordance + title for the compare builder and the endpoint sub-pickers. */
function SubHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="commit-picker__subhead">
      <button type="button" className="commit-picker__back" onClick={onBack} aria-label={STR.back}>
        <IconChevron size={13} className="commit-picker__back-chev" />
      </button>
      <span className="commit-picker__subtitle">{title}</span>
    </div>
  );
}

function CompareBuilder({
  baseFieldRef,
  base,
  head,
  onBack,
  onPickBase,
  onPickHead,
  onConfirm,
}: {
  baseFieldRef: React.RefObject<HTMLButtonElement>;
  base: RefEndpoint | null;
  head: RefEndpoint | null;
  onBack: () => void;
  onPickBase: () => void;
  onPickHead: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <SubHeader title={STR.compareTitle} onBack={onBack} />
      <div className="commit-picker__compare">
        <button
          ref={baseFieldRef}
          type="button"
          className="commit-picker__field"
          aria-haspopup="menu"
          aria-label={STR.base}
          onClick={onPickBase}
        >
          <span className="commit-picker__field-label">{STR.base}</span>
          <span className="commit-picker__field-value">
            {base ? endpointLabel(base) : STR.choose}
          </span>
        </button>
        <span className="commit-picker__compare-sep" aria-hidden>
          …
        </span>
        <button
          type="button"
          className="commit-picker__field"
          aria-haspopup="menu"
          aria-label={STR.target}
          onClick={onPickHead}
        >
          <span className="commit-picker__field-label">{STR.target}</span>
          <span className="commit-picker__field-value">
            {head ? endpointLabel(head) : STR.choose}
          </span>
        </button>
        <button
          type="button"
          className="commit-picker__confirm"
          disabled={!base || !head}
          onClick={onConfirm}
        >
          {STR.doCompare}
        </button>
      </div>
    </>
  );
}

function ListView({
  baseId,
  inputRef,
  rows,
  clampedActive,
  filter,
  phase,
  commitsLen,
  filteredLen,
  showPasted,
  onFilter,
  onActive,
  onSelect,
  onRetry,
  onCompare,
}: {
  baseId: string;
  inputRef: React.RefObject<HTMLInputElement>;
  rows: PickerRow[];
  clampedActive: number;
  filter: string;
  phase: Phase;
  commitsLen: number;
  filteredLen: number;
  showPasted: boolean;
  onFilter: (v: string) => void;
  onActive: (i: number) => void;
  onSelect: (row: PickerRow) => void;
  onRetry: () => void;
  onCompare: () => void;
}) {
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
          <button type="button" className="commit-picker__retry" onClick={onRetry}>
            {STR.retry}
          </button>
        </div>
      );
    }
    if (commitsLen === 0) {
      return (
        <div className="ctxmenu__item commit-picker__status" aria-disabled>
          {STR.noCommits}
        </div>
      );
    }
    if (filteredLen === 0 && !showPasted) {
      return (
        <div className="ctxmenu__item commit-picker__status" aria-disabled>
          {STR.noMatch}
        </div>
      );
    }
    return null;
  })();

  return (
    <>
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
        onChange={(e) => onFilter(e.target.value)}
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
            onMouseEnter={() => onActive(i)}
            onClick={() => onSelect(row)}
          >
            <span className="ctxmenu__icon">
              {row.checked ? <IconCheck size={13} /> : <span style={{ width: 13 }} />}
            </span>
            {row.render()}
          </button>
        ))}
      </div>

      {status}

      <button type="button" className="commit-picker__compare-entry" onClick={onCompare}>
        <IconBranch size={13} />
        <span>{STR.compare}</span>
      </button>
    </>
  );
}
