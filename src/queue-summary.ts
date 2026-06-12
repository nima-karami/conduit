// Pure derivations for the pipeline queue summary (N3). Lives in `src/` so both the host
// and renderer can compute the same view from the raw queue entries. No side-effects; fully
// unit-tested. See docs/specs/2026-06-12-n3-orchestration-status.md.

import type { PipelineQueueEntry } from './pipeline';

/** A condensed, display-ready summary of the pipeline queue for the board header. */
export interface QueueSummary {
  /** Total number of entries currently in the queue (the "depth"). */
  depth: number;
  /** The most-recent entries, newest first, capped to avoid noisy popovers. */
  recent: QueueSummaryEntry[];
}

/** One entry in the queue summary popover. */
export interface QueueSummaryEntry {
  id: string;
  cardTitle: string;
  /** The `from` stage. */
  from: string;
  /** The `to` stage. */
  to: string;
  /** The skill configured for this transition. */
  skill: string;
  /** Epoch ms — used for display only. */
  at: number;
}

/** Maximum number of entries surfaced in the summary popover. */
export const QUEUE_SUMMARY_LIMIT = 8;

/**
 * Derive a display-ready summary from the raw queue entries. Pure — no I/O; the caller
 * supplies the entries it already holds. Returns the depth (total count) and the N most
 * recent entries (newest first), so the board header can show a count badge and a popover
 * without re-reading the file on every render.
 *
 * @param entries  The raw `PipelineQueueEntry[]` from the queue (may be empty).
 * @param limit    Maximum entries to include in `recent` (default: `QUEUE_SUMMARY_LIMIT`).
 */
export function summarizeQueue(
  entries: PipelineQueueEntry[],
  limit: number = QUEUE_SUMMARY_LIMIT,
): QueueSummary {
  const depth = entries.length;
  const sorted = [...entries].sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit));
  const recent: QueueSummaryEntry[] = sorted.map((e) => ({
    id: e.id,
    cardTitle: e.cardTitle,
    from: e.from,
    to: e.to,
    skill: e.skill,
    at: e.at,
  }));
  return { depth, recent };
}
