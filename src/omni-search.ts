// Pure ranking + grouping for the center omni-search bar (R4.13). Given a query and
// the three searchable corpora — sessions (by title), agents (by name), and files (by
// filename/relative path) — produce a flat, group-ordered, fuzzy-ranked result list.
//
// This is the name/title matcher only. File *content* search is intentionally out of
// scope here: L5's `src/content-search.ts` already powers the Explorer's Search panel
// and could later back a "content mode" of this same bar (typed prefix or a toggle).
// Keeping ranking pure (no React, no host bridge) lets it be unit-tested in isolation
// and reused by the renderer's CommandPalette to render the grouped overlay.

import { fuzzyScore } from './fuzzy';

/** The three result kinds the omni-bar can surface, in their fixed display order. */
export type OmniKind = 'session' | 'agent' | 'file';

/** Minimal shape of a searchable session (matched on `title`). */
export interface OmniSession {
  id: string;
  title: string;
  /** Optional context shown as a subtitle (e.g. the project basename). */
  subtitle?: string;
}

/** Minimal shape of a searchable agent (matched on `name`). */
export interface OmniAgent {
  id: string;
  name: string;
  subtitle?: string;
}

/** Minimal shape of a searchable file (matched on `rel`, its project-relative path). */
export interface OmniFile {
  /** Absolute path — the stable identity + what the picker opens. */
  abs: string;
  /** Project-relative path — what is matched and displayed. */
  rel: string;
}

export interface OmniInputs {
  sessions: OmniSession[];
  agents: OmniAgent[];
  files: OmniFile[];
}

/** A single ranked result, carrying enough to render + route the pick. */
export interface OmniResult {
  kind: OmniKind;
  /** Stable id used for React keys + dedupe (`<kind>:<id>`). */
  id: string;
  /** Primary label, the text the query fuzzy-matched against. */
  title: string;
  subtitle?: string;
  /** Fuzzy score (higher = better); 0 for the empty-query (idle) listing. */
  score: number;
}

export interface OmniGroup {
  kind: OmniKind;
  label: string;
  results: OmniResult[];
}

/** Per-kind group heading + the fixed display order (Sessions, Agents, Files). */
const GROUP_ORDER: { kind: OmniKind; label: string }[] = [
  { kind: 'session', label: 'Sessions' },
  { kind: 'agent', label: 'Agents' },
  { kind: 'file', label: 'Files' },
];

/** Per-group cap so a huge file list can't dominate the overlay. */
const PER_GROUP_LIMIT = 30;

/**
 * Rank one kind's items against the query. An empty query returns the items in their
 * incoming order (the idle listing) with score 0; a non-empty query keeps only fuzzy
 * matches, sorted by score descending, capped at `limit`.
 */
function rankKind<T>(
  query: string,
  items: T[],
  toTitle: (t: T) => string,
  toResult: (t: T, score: number) => OmniResult,
  limit = PER_GROUP_LIMIT,
): OmniResult[] {
  const q = query.trim();
  if (q === '') return items.slice(0, limit).map((it) => toResult(it, 0));
  const scored: { result: OmniResult; score: number }[] = [];
  for (const it of items) {
    const m = fuzzyScore(q, toTitle(it));
    if (m) scored.push({ result: toResult(it, m.score), score: m.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.result);
}

/**
 * Filter + rank + group the omni-search inputs for `query`. Groups are returned in the
 * fixed order (Sessions, Agents, Files); empty groups are dropped. Within a group the
 * order is fuzzy-score descending (or the incoming order when the query is empty).
 */
export function rankOmniResults(query: string, inputs: OmniInputs): OmniGroup[] {
  const byKind: Record<OmniKind, OmniResult[]> = {
    session: rankKind(
      query,
      inputs.sessions,
      (s) => s.title,
      (s, score) => ({
        kind: 'session',
        id: `session:${s.id}`,
        title: s.title,
        subtitle: s.subtitle,
        score,
      }),
    ),
    agent: rankKind(
      query,
      inputs.agents,
      (a) => a.name,
      (a, score) => ({
        kind: 'agent',
        id: `agent:${a.id}`,
        title: a.name,
        subtitle: a.subtitle,
        score,
      }),
    ),
    file: rankKind(
      query,
      inputs.files,
      (f) => f.rel,
      (f, score) => ({ kind: 'file', id: `file:${f.abs}`, title: f.rel, score }),
    ),
  };
  return GROUP_ORDER.map(({ kind, label }) => ({ kind, label, results: byKind[kind] })).filter(
    (g) => g.results.length > 0,
  );
}

/** Flatten grouped results (group order preserved) for keyboard navigation. */
export function flattenOmni(groups: OmniGroup[]): OmniResult[] {
  return groups.flatMap((g) => g.results);
}
