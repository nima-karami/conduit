/**
 * Compare-refs dialog (spec 2026-06-30-review-compare-dialog §B). A first-class, focus-trapped
 * modal that replaces the cramped nested in-band compare builder: two ref slots (Base, Target)
 * shown together, each an async combobox over Branches · Remotes · Tags · Commits (+ a pasted/short
 * SHA), a Swap control, a live `base…head` preview with a dot-mode hint, and Compare/Cancel.
 *
 * Reuses the shipped range engine wholesale (A1): on confirm it emits the same `{kind:'range'}`
 * the in-band builder did, so the Review render path is untouched. The host validates every picked
 * ref exactly (electron/main.ts) — the renderer never spawns git. Enumeration uses a RENDERER-side
 * timeout (mirroring CommitPickerMenu's LOAD_TIMEOUT_MS) for a Retry-able enum error, so the
 * shared fire-and-forget `git:refsResult` broadcast keeps no error channel (spec §3).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  dotModeFor,
  endpointKey,
  endpointLabel,
  type RefEndpoint,
  shortSha,
} from '../../src/git-range';
import { isStaleHistory } from '../../src/git-search';
import type { CommitNode } from '../../src/protocol';
import { post, subscribe } from '../bridge';
import type { ReviewSource } from '../docs';
import { IconClose, IconCompare, IconSwap } from '../icons';
import { relativeTime } from '../relative-time';
import { filterCommitsForPicker, isPastedSha } from '../review-commit';

const STR = {
  title: 'Compare changes',
  base: 'Base',
  target: 'Target',
  choose: 'Choose a ref…',
  clear: 'Clear',
  swap: 'Swap base and target',
  compare: 'Compare',
  cancel: 'Cancel',
  branches: 'Branches',
  remotes: 'Remotes',
  tags: 'Tags',
  commits: 'Commits',
  workingTree: 'Working tree',
  useCommit: (sha7: string) => `Use commit ${sha7}`,
  noMatch: 'No refs or commits match',
  loading: 'Loading refs…',
  enumError: "Couldn't load refs",
  retry: 'Retry',
  pickTwo: 'Pick two different points',
  pickBoth: 'Choose a base and a target to compare',
  mergeBaseHint: 'merge-base / three-dot',
  workingHint: 'working tree / two-dot',
  refineMore: (n: number) => `+${n} more — refine search`,
} as const;

const HISTORY_LIMIT = 150;
const LOAD_TIMEOUT_MS = 8000;
/** Per-section render cap: deep ref/commit lists filter client-side, so a long section collapses
 *  to a "refine search" hint rather than flooding the dropdown (spec §4). */
const SECTION_RENDER_CAP = 50;

interface RefLists {
  branches: string[];
  remotes: string[];
  tags: string[];
}
const EMPTY_REFS: RefLists = { branches: [], remotes: [], tags: [] };

interface ComboRow {
  id: string;
  endpoint: RefEndpoint;
  render: () => React.ReactNode;
}
interface ComboSection {
  label: string;
  rows: ComboRow[];
  overflow: number;
}

function buildSections(
  idPrefix: string,
  query: string,
  refs: RefLists,
  commits: CommitNode[],
  allowWorking: boolean,
): ComboSection[] {
  const q = query.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  const out: ComboSection[] = [];

  const section = (label: string, all: ComboRow[]) => {
    if (all.length === 0) return;
    out.push({
      label,
      rows: all.slice(0, SECTION_RENDER_CAP),
      overflow: Math.max(0, all.length - SECTION_RENDER_CAP),
    });
  };

  if (allowWorking && match(STR.workingTree)) {
    out.push({
      label: STR.workingTree,
      rows: [
        {
          id: `${idPrefix}-working`,
          endpoint: { kind: 'working' },
          render: () => <span className="cmp-combo__name">{STR.workingTree}</span>,
        },
      ],
      overflow: 0,
    });
  }

  const refRow = (idTag: string, name: string, endpoint: RefEndpoint): ComboRow => ({
    id: `${idPrefix}-${idTag}-${name}`,
    endpoint,
    render: () => (
      <span className="cmp-combo__name" dir="ltr" title={name}>
        {name}
      </span>
    ),
  });

  section(
    STR.branches,
    refs.branches.filter(match).map((b) => refRow('b', b, { kind: 'branch', ref: b })),
  );
  section(
    STR.remotes,
    refs.remotes.filter(match).map((r) => refRow('r', r, { kind: 'branch', ref: r, remote: true })),
  );
  section(
    STR.tags,
    refs.tags.filter(match).map((t) => refRow('t', t, { kind: 'tag', ref: t })),
  );

  const filteredCommits = filterCommitsForPicker(commits, query);
  section(
    STR.commits,
    filteredCommits.map((c) => ({
      id: `${idPrefix}-c-${c.sha}`,
      endpoint: { kind: 'commit', sha: c.sha, subject: c.subject },
      render: () => (
        <>
          <span className="cmp-combo__sha" dir="ltr">
            {shortSha(c.sha)}
          </span>
          <span className="cmp-combo__subject" title={c.subject}>
            {c.subject}
          </span>
          <span className="cmp-combo__date">{relativeTime(c.date * 1000)}</span>
        </>
      ),
    })),
  );

  const pasted = isPastedSha(query);
  if (pasted && filteredCommits.length === 0) {
    out.push({
      label: STR.commits,
      rows: [
        {
          id: `${idPrefix}-pasted`,
          endpoint: { kind: 'commit', sha: pasted },
          render: () => (
            <>
              <IconCompare size={12} />
              <span className="cmp-combo__subject">{STR.useCommit(shortSha(pasted))}</span>
            </>
          ),
        },
      ],
      overflow: 0,
    });
  }

  return out;
}

function RefCombobox({
  idPrefix,
  label,
  allowWorking,
  refs,
  commits,
  value,
  onChange,
  inputRef,
}: {
  idPrefix: string;
  label: string;
  allowWorking: boolean;
  refs: RefLists;
  commits: CommitNode[];
  value: RefEndpoint | null;
  onChange: (next: RefEndpoint | null) => void;
  inputRef: React.RefObject<HTMLInputElement> | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = `${idPrefix}-list`;
  const labelId = `${idPrefix}-label`;
  const localRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? localRef;

  const sections = useMemo(
    () => buildSections(idPrefix, query, refs, commits, allowWorking),
    [idPrefix, query, refs, commits, allowWorking],
  );
  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const clamped = Math.min(activeIndex, Math.max(flat.length - 1, 0));

  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const id = flat[clamped]?.id;
    if (id)
      menuRef.current
        ?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [open, clamped, flat]);

  const pick = (row: ComboRow | undefined) => {
    if (!row) return;
    onChange(row.endpoint);
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(0);
      } else setActiveIndex((i) => Math.min(i + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && flat[clamped]) {
        e.preventDefault();
        pick(flat[clamped]);
      }
    } else if (e.key === 'Escape' && open) {
      // Esc closes only this list; the dialog's Esc (cancel) must not also fire (spec §10).
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  const displayValue = open ? query : value ? endpointLabel(value) : '';

  return (
    <div className="cmp-field">
      <span className="cmp-field__label" id={labelId}>
        {label}
      </span>
      <div className="cmp-combo">
        <input
          ref={ref}
          type="text"
          className="cmp-combo__input"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-labelledby={labelId}
          aria-activedescendant={open ? flat[clamped]?.id : undefined}
          aria-autocomplete="list"
          placeholder={STR.choose}
          value={displayValue}
          dir="ltr"
          onFocus={() => {
            setQuery('');
            setOpen(true);
            setActiveIndex(0);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {value && (
          <button
            type="button"
            className="cmp-combo__clear"
            aria-label={STR.clear}
            title={STR.clear}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange(null);
              setQuery('');
              ref.current?.focus();
            }}
          >
            <IconClose size={11} />
          </button>
        )}
        {open && (
          <div ref={menuRef} className="cmp-combo__menu" id={listId} role="listbox">
            {flat.length === 0 ? (
              <div className="cmp-combo__empty">{STR.noMatch}</div>
            ) : (
              sections.map((s) => (
                <div
                  key={s.rows[0]?.id ?? s.label}
                  role="group"
                  aria-label={s.label}
                  className="cmp-combo__group"
                >
                  <div className="cmp-combo__grouphead">{s.label}</div>
                  {s.rows.map((row) => (
                    <button
                      key={row.id}
                      id={row.id}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={flat[clamped]?.id === row.id}
                      className={`cmp-combo__row${flat[clamped]?.id === row.id ? ' cmp-combo__row--active' : ''}`}
                      onMouseEnter={() => setActiveIndex(flat.findIndex((r) => r.id === row.id))}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(row)}
                    >
                      {row.render()}
                    </button>
                  ))}
                  {s.overflow > 0 && (
                    <div className="cmp-combo__more">{STR.refineMore(s.overflow)}</div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function CompareDialog({
  sessionId,
  source,
  onCompare,
  onCancel,
}: {
  sessionId?: string;
  /** Prefill from an active comparison so re-opening tweaks the live range (spec §2). */
  source?: ReviewSource;
  onCompare: (next: ReviewSource) => void;
  onCancel: () => void;
}) {
  const prefill = source?.kind === 'range' ? source : null;
  const [base, setBase] = useState<RefEndpoint | null>(prefill?.base ?? null);
  const [head, setHead] = useState<RefEndpoint | null>(prefill?.head ?? null);
  const [refs, setRefs] = useState<RefLists>(EMPTY_REFS);
  const [commits, setCommits] = useState<CommitNode[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');

  const rootRef = useRef<HTMLDivElement>(null);
  const baseInputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const baseId = useId();
  const targetId = useId();

  const reqCounter = useRef(0);
  const latestReqId = useRef(0);
  const gotRefs = useRef(false);
  const gotCommits = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!sessionId) {
      setPhase('ready');
      return;
    }
    gotRefs.current = false;
    gotCommits.current = false;
    reqCounter.current += 1;
    latestReqId.current = reqCounter.current;
    setPhase('loading');
    post({ type: 'git:refs', sessionId });
    post({ type: 'git:history', sessionId, limit: HISTORY_LIMIT, requestId: reqCounter.current });
    timer.current = setTimeout(() => setPhase('error'), LOAD_TIMEOUT_MS);
  }, [sessionId]);

  useEffect(() => {
    load();
    const unsub = subscribe((msg) => {
      if (msg.type === 'git:refsResult' && msg.sessionId === sessionId) {
        setRefs({ branches: msg.branches, remotes: msg.remotes, tags: msg.tags });
        gotRefs.current = true;
      } else if (msg.type === 'git:historyResult' && msg.sessionId === sessionId) {
        if (isStaleHistory(msg.requestId, latestReqId.current)) return;
        setCommits(msg.commits);
        gotCommits.current = true;
      } else return;
      if (gotRefs.current && gotCommits.current) {
        if (timer.current) clearTimeout(timer.current);
        setPhase('ready');
      }
    });
    return () => {
      unsub();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [sessionId, load]);

  // Focus the Base field on open; restore focus to the trigger that opened the dialog on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    baseInputRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  const identical = !!base && !!head && endpointKey(base) === endpointKey(head);
  const canCompare = !!base && !!head && !identical;
  const swapDisabled = head?.kind === 'working';

  const swap = () => {
    if (swapDisabled) return;
    setBase(head);
    setHead(base);
  };

  const confirm = () => {
    if (!canCompare || !base || !head) return;
    if (dotModeFor(base, head) === 'working') onCompare({ kind: 'working' });
    else onCompare({ kind: 'range', base, head });
  };

  const preview = (() => {
    if (!base || !head) return { text: STR.pickBoth, hint: '' };
    const text = `${endpointLabel(base)}…${endpointLabel(head)}`;
    if (identical) return { text, hint: STR.pickTwo };
    return { text, hint: dotModeFor(base, head) === 'two' ? STR.workingHint : STR.mergeBaseHint };
  })();

  const onRootKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== 'Tab') return;
    const root = rootRef.current;
    if (!root) return;
    const focusables = [
      ...root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => el.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal__backdrop" onClick={onCancel}>
      <div
        ref={rootRef}
        className="compare-dialog"
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onRootKeyDown}
      >
        <div className="compare-dialog__head">
          <IconCompare size={15} />
          <span className="compare-dialog__title" id={titleId}>
            {STR.title}
          </span>
        </div>

        {phase === 'error' ? (
          <div className="compare-dialog__status compare-dialog__status--error">
            <span>{STR.enumError}</span>
            <button type="button" className="btn" onClick={load}>
              {STR.retry}
            </button>
          </div>
        ) : (
          <>
            <div className="compare-dialog__slots">
              <RefCombobox
                idPrefix={baseId}
                label={STR.base}
                allowWorking={false}
                refs={refs}
                commits={commits}
                value={base}
                onChange={setBase}
                inputRef={baseInputRef}
              />
              <button
                type="button"
                className="compare-dialog__swap"
                aria-label={STR.swap}
                title={STR.swap}
                disabled={swapDisabled}
                onClick={swap}
              >
                <IconSwap size={14} />
              </button>
              <RefCombobox
                idPrefix={targetId}
                label={STR.target}
                allowWorking
                refs={refs}
                commits={commits}
                value={head}
                onChange={setHead}
                inputRef={null}
              />
            </div>

            <div className="compare-dialog__preview" aria-live="polite">
              <span className="compare-dialog__preview-label" dir="ltr">
                {preview.text}
              </span>
              {preview.hint && <span className="compare-dialog__preview-hint">{preview.hint}</span>}
            </div>

            <div className="compare-dialog__actions">
              {phase === 'loading' && (
                <span className="compare-dialog__loading">{STR.loading}</span>
              )}
              <button type="button" className="btn" onClick={onCancel}>
                {STR.cancel}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!canCompare}
                onClick={confirm}
              >
                {STR.compare}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
