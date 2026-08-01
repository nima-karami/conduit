// Level of detail for the architecture canvas (§7.6, handoff open item 4).
//
// WHAT THIS IS FOR, measured rather than assumed. The ladder was built expecting it to soften the
// 500-node freeze. It does not — and the arch-canvas-scale scenario cannot even resolve whether it
// helps or hurts: unchanged code measures 47.0s of block in one run and 112.4s in another, an
// envelope that contains every reading taken with the ladder on. Full table and the two rejected
// alternatives: docs/runs/2026-07-31-revamp/blockers.md (open item 4).
//
// So this is a LEGIBILITY ladder with an honest readout, not a performance fix, and nothing here
// should be cited as one. The thresholds are set where a card stops being readable at the zoom a
// graph that size forces, and the budget chip states the count, the ceiling and the rung so the app
// never just quietly gets slower. The freeze itself belongs to the board card "Virtualize the
// architecture canvas": the cost is the O(N) doc rebuild per drag frame, which no amount of
// per-card thinning touches.
//
// The pins are NOT detail: they are where the wires attach. Rewiring the edges onto whole-node
// handles instead was tried and is a semantic change to the graph as well as a 15× load
// regression, so a reduced rung keeps every pin and drops the LABEL beside it — hence "pins only"
// rather than a rung that claims the ports are gone.

/** The ceiling §7.6 states on screen. Not enforced — a bigger graph still loads, and says so. */
export const NODE_BUDGET = 500;

export type DetailLevel = 'full' | 'pins-only' | 'no-subtitles' | 'chips';

/** Richest → sparsest, which is the order a picker should offer them in. */
export const DETAIL_LEVELS: readonly DetailLevel[] = [
  'full',
  'pins-only',
  'no-subtitles',
  'chips',
] as const;

/**
 * Node counts at which each rung engages — the FIRST count that renders at that level. Chosen by
 * what survives the zoom a graph that size gets fitted to, since the header's measurements ruled
 * out choosing them by cost: 10px port labels stop resolving somewhere under 0.5 zoom, subtitles
 * a little past that, and beyond ~320 the card is a coloured tile with a word on it either way.
 */
export const LOD_THRESHOLDS = {
  /** ≥ this many nodes: port rows keep their pins and lose their name/type labels. */
  pinsOnly: 80,
  /** ≥ this many nodes: also drop subtitles. */
  noSubtitles: 200,
  /** ≥ this many nodes: title-only chips — no icon, no drill affordance. */
  chips: 320,
} as const;

/** The level a graph of `nodeCount` nodes renders at with no manual override. */
export function autoDetail(nodeCount: number): DetailLevel {
  if (nodeCount >= LOD_THRESHOLDS.chips) return 'chips';
  if (nodeCount >= LOD_THRESHOLDS.noSubtitles) return 'no-subtitles';
  if (nodeCount >= LOD_THRESHOLDS.pinsOnly) return 'pins-only';
  return 'full';
}

/** Whether a pin shows its `name: Type` text. The pin itself is always drawn. */
export function showsPortLabels(level: DetailLevel): boolean {
  return level === 'full';
}

export function showsSubtitle(level: DetailLevel): boolean {
  return level === 'full' || level === 'pins-only';
}

/** A chip carries its title and kind bar only — no icon, no drill button, no subtitle. */
export function isChip(level: DetailLevel): boolean {
  return level === 'chips';
}

const LEVEL_LABEL: Record<DetailLevel, string> = {
  full: 'full detail',
  'pins-only': 'pins only',
  'no-subtitles': 'titles only',
  chips: 'chips',
};

export function detailLabel(level: DetailLevel): string {
  return LEVEL_LABEL[level];
}

/**
 * The on-screen budget line: `48 / 500 nodes · full detail`. `manual` marks a level the human
 * pinned, so the chip never implies the ladder chose a rung it didn't.
 */
export function budgetLabel(nodeCount: number, level: DetailLevel, manual = false): string {
  return `${nodeCount} / ${NODE_BUDGET} nodes · ${detailLabel(level)}${manual ? ' (pinned)' : ''}`;
}

/** Over budget is a real state (nothing blocks a bigger graph) and gets its own dot colour. */
export function isOverBudget(nodeCount: number): boolean {
  return nodeCount > NODE_BUDGET;
}
