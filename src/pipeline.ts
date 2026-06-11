// The board PIPELINE model (G4). The feature board doesn't just hold status — each
// column transition can be assigned a Claude Code SKILL, turning a card move into a
// named pipeline step. Pure + unit-tested; persisted as `.conduit/pipeline.json`
// (config) and `.conduit/pipeline-queue.json` (the event stream an agent drains).
//
// HONEST BOUNDARY: this module models + records transitions. It does NOT execute
// skills — the Electron app cannot run a Claude Code skill. The queue is the hook an
// external agent (or the user) acts on. See docs/specs/board-skill-transitions.md.

import type { BoardCard, Stage } from './board';

const VERSION = 1;

/** A transition key is the ordered stage pair `${from}->${to}`. */
export function transitionKey(from: Stage, to: Stage): string {
  return `${from}->${to}`;
}

/** A canonical, forward-adjacent pipeline transition, with a UI label. */
export interface CanonicalTransition {
  from: Stage;
  to: Stage;
  label: string;
}

/** The three forward-adjacent transitions surfaced in the config UI as THE pipeline.
 *  The model still accepts arbitrary (from,to) keys — these are just the canonical set
 *  the panel lists (Wishlist → Planning → Building → Done). */
export const CANONICAL_TRANSITIONS: CanonicalTransition[] = [
  { from: 'wishlist', to: 'planning', label: 'Wish list → Planning' },
  { from: 'planning', to: 'building', label: 'Planning → Building' },
  { from: 'building', to: 'done', label: 'Building → Done' },
];

/** Per-transition → skill-name mapping. Skill names are free text (the agent/CLI owns
 *  the registry; the app does not validate that a skill exists). */
export interface PipelineConfig {
  version: number;
  /** transition key (`from->to`) → skill name. */
  transitions: Record<string, string>;
}

export function emptyPipelineConfig(): PipelineConfig {
  return { version: VERSION, transitions: {} };
}

/** The skill configured for a transition, or `undefined` if none. */
export function skillForTransition(
  config: PipelineConfig,
  from: Stage,
  to: Stage,
): string | undefined {
  return config.transitions[transitionKey(from, to)];
}

/** Set (or clear) the skill for a transition. An empty / whitespace-only skill removes
 *  the mapping. Pure — returns a new config. */
export function setTransitionSkill(
  config: PipelineConfig,
  from: Stage,
  to: Stage,
  skill: string,
): PipelineConfig {
  const key = transitionKey(from, to);
  const trimmed = skill.trim();
  const transitions = { ...config.transitions };
  if (trimmed) transitions[key] = trimmed;
  else delete transitions[key];
  return { ...config, transitions };
}

/** Keep only string→non-empty-string entries, trimming values; drop everything else. */
function cleanTransitions(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

export function serializePipeline(config: PipelineConfig): string {
  return JSON.stringify({ version: VERSION, transitions: config.transitions }, null, 2);
}

/** Restore a config from a blob; falls back to an empty config on missing/invalid input
 *  (never throws — unknown shapes degrade gracefully, like the other `.conduit/` readers). */
export function restorePipeline(blob: string | undefined): PipelineConfig {
  if (blob) {
    try {
      const parsed = JSON.parse(blob);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          version: VERSION,
          transitions: cleanTransitions((parsed as PipelineConfig).transitions),
        };
      }
    } catch {
      /* fall through to empty */
    }
  }
  return emptyPipelineConfig();
}

// ---- Transition queue (the agent-consumable event stream) -------------------

/** One surfaced transition: a card crossed a configured boundary; an agent can run the
 *  skill. Append-only — the app appends, an external agent drains. */
export interface PipelineQueueEntry {
  id: string;
  cardId: string;
  cardTitle: string;
  from: Stage;
  to: Stage;
  /** `from->to`, denormalized so a consumer needn't re-derive it. */
  transition: string;
  skill: string;
  /** Epoch ms when the move happened. */
  at: number;
}

export interface PipelineQueue {
  version: number;
  entries: PipelineQueueEntry[];
}

export function emptyPipelineQueue(): PipelineQueue {
  return { version: VERSION, entries: [] };
}

/** Build a queue entry for a card crossing a configured transition. Pure; the caller
 *  supplies `now` and a unique `id` (defaults provided for ergonomics). */
export function buildQueueEntry(
  card: Pick<BoardCard, 'id' | 'title'>,
  from: Stage,
  to: Stage,
  skill: string,
  now: number = Date.now(),
  id: string = `q-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
): PipelineQueueEntry {
  return {
    id,
    cardId: card.id,
    cardTitle: card.title,
    from,
    to,
    transition: transitionKey(from, to),
    skill,
    at: now,
  };
}

export function appendQueueEntry(queue: PipelineQueue, entry: PipelineQueueEntry): PipelineQueue {
  return { ...queue, entries: [...queue.entries, entry] };
}

const isQueueEntry = (e: unknown): e is PipelineQueueEntry => {
  if (!e || typeof e !== 'object') return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x.id === 'string' &&
    typeof x.cardId === 'string' &&
    typeof x.cardTitle === 'string' &&
    typeof x.from === 'string' &&
    typeof x.to === 'string' &&
    typeof x.transition === 'string' &&
    typeof x.skill === 'string' &&
    typeof x.at === 'number'
  );
};

export function serializePipelineQueue(queue: PipelineQueue): string {
  return JSON.stringify({ version: VERSION, entries: queue.entries }, null, 2);
}

/** Restore a queue from a blob; empty on missing/invalid, dropping malformed entries. */
export function restorePipelineQueue(blob: string | undefined): PipelineQueue {
  if (blob) {
    try {
      const parsed = JSON.parse(blob);
      if (
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as PipelineQueue).entries)
      ) {
        return {
          version: VERSION,
          entries: (parsed as PipelineQueue).entries.filter(isQueueEntry),
        };
      }
    } catch {
      /* fall through to empty */
    }
  }
  return emptyPipelineQueue();
}
