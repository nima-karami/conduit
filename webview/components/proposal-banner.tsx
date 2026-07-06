// Shared proposal banner + diff (N1), used by both the board view and the architecture
// canvas. Renders the human review affordance (summary, per-item diff, Accept/Reject); the
// apply/delete happens host-side (ADR 0002 §3) — the renderer only posts the decision.

import { useState } from 'react';
import type { ArchDiff, BoardDiff } from '../../src/conduit-proposal';
import { summarizeArchDiff, summarizeBoardDiff } from '../../src/conduit-proposal';
import { IconChevron, IconClose, IconDoc, IconSparkle } from '../icons';

interface BannerProps {
  /** Which surface — only affects the noun in the copy. */
  kind: 'board' | 'architecture';
  /** Primary action label (e.g. "Accept" for the board, "Review changes" for the canvas). */
  primaryLabel: string;
  onPrimary: () => void;
  onReject: () => void;
}

/** The banner chrome shared by both diff shapes. */
function Shell({
  kind,
  summary,
  rows,
  primaryLabel,
  onPrimary,
  onReject,
}: BannerProps & { summary: string; rows: DiffRow[] }) {
  const [open, setOpen] = useState(false);
  const noun = kind === 'board' ? 'board' : 'architecture';
  return (
    <div className="proposal" role="region" aria-label={`Agent ${noun} proposal`}>
      <div className="proposal__bar">
        <span className="proposal__icon" aria-hidden>
          <IconSparkle size={14} />
        </span>
        <div className="proposal__text">
          <span className="proposal__title">An agent proposed changes to this {noun}</span>
          <span className="proposal__summary">{summary}</span>
        </div>
        <button
          className="proposal__toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className={`proposal__chev ${open ? 'proposal__chev--open' : ''}`}>
            <IconChevron size={12} />
          </span>
          {open ? 'Hide diff' : 'View diff'}
        </button>
        <div className="proposal__acts">
          <button className="btn btn--primary proposal__accept" onClick={onPrimary}>
            <IconDoc size={12} /> {primaryLabel}
          </button>
          <button className="btn btn--ghost proposal__reject" onClick={onReject}>
            <IconClose size={12} /> Reject
          </button>
        </div>
      </div>
      {open && (
        <ul className="proposal__diff">
          {rows.length === 0 ? (
            <li className="proposal__row proposal__row--none">No changes in this proposal.</li>
          ) : (
            rows.map((r) => (
              <li className={`proposal__row proposal__row--${r.tag}`} key={r.key}>
                <span className={`proposal__tag proposal__tag--${r.tag}`}>{r.tagLabel}</span>
                <span className="proposal__label">{r.text}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

interface DiffRow {
  key: string;
  tag: 'add' | 'remove' | 'move' | 'edit';
  tagLabel: string;
  text: string;
}

function boardRows(diff: BoardDiff): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const c of diff.added)
    rows.push({ key: `a-${c.id}`, tag: 'add', tagLabel: 'Added', text: c.title });
  for (const c of diff.removed)
    rows.push({ key: `r-${c.id}`, tag: 'remove', tagLabel: 'Removed', text: c.title });
  for (const m of diff.moved)
    rows.push({
      key: `m-${m.id}`,
      tag: 'move',
      tagLabel: 'Moved',
      text: `${m.title}: ${m.from} → ${m.to}`,
    });
  for (const e of diff.edited)
    rows.push({
      key: `e-${e.id}`,
      tag: 'edit',
      tagLabel: 'Edited',
      text: `${e.title} (${e.fields.join(', ')})`,
    });
  return rows;
}

/** Proposal banner for the feature board. */
export function BoardProposalBanner({
  diff,
  onAccept,
  onReject,
}: {
  diff: BoardDiff;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <Shell
      kind="board"
      summary={summarizeBoardDiff(diff)}
      rows={boardRows(diff)}
      primaryLabel="Accept"
      onPrimary={onAccept}
      onReject={onReject}
    />
  );
}

function archRows(diff: ArchDiff): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const n of diff.addedNodes)
    rows.push({ key: `an-${n.id}`, tag: 'add', tagLabel: 'Added', text: `node: ${n.title}` });
  for (const n of diff.removedNodes)
    rows.push({ key: `rn-${n.id}`, tag: 'remove', tagLabel: 'Removed', text: `node: ${n.title}` });
  for (const n of diff.editedNodes)
    rows.push({
      key: `en-${n.id}`,
      tag: 'edit',
      tagLabel: 'Edited',
      text: `node: ${n.title} (${n.fields.join(', ')})`,
    });
  for (const e of diff.addedEdges)
    rows.push({
      key: `ae-${e.id}`,
      tag: 'add',
      tagLabel: 'Added',
      text: `edge${e.label ? `: ${e.label}` : ''}`,
    });
  for (const e of diff.removedEdges)
    rows.push({ key: `re-${e.id}`, tag: 'remove', tagLabel: 'Removed', text: 'edge' });
  for (const e of diff.editedEdges)
    rows.push({
      key: `ee-${e.id}`,
      tag: 'edit',
      tagLabel: 'Edited',
      text: `edge (${e.fields.join(', ')})`,
    });
  return rows;
}

/** Proposal banner for the architecture canvas. The primary action opens an editable review on the
 *  canvas (issue #1) rather than blind-applying, so the human sees and can tweak before saving. */
export function ArchProposalBanner({
  diff,
  onReview,
  onReject,
}: {
  diff: ArchDiff;
  onReview: () => void;
  onReject: () => void;
}) {
  return (
    <Shell
      kind="architecture"
      summary={summarizeArchDiff(diff)}
      rows={archRows(diff)}
      primaryLabel="Review changes"
      onPrimary={onReview}
      onReject={onReject}
    />
  );
}
