import type { GitRef, GraphEdge, GraphLayout } from './protocol';

/**
 * PURE render-geometry helpers for the git-history graph (Slice A, renderer half). Kept
 * node-free in `src/` so the renderer imports them and a unit test can exercise the math
 * without a DOM. The SVG component (webview/components/git-history-view.tsx) is a thin
 * shell over these.
 */

/** Theme CSS-var names cycled across lanes. Lane 0 (mainline) = the indicator's branch
 *  color (`--accent`); the rest spread across the palette so a branch keeps one hue down
 *  the gutter. Resolved live by the browser, so lanes recolor on a theme switch. */
export const LANE_VARS = [
  '--accent',
  '--blue',
  '--green',
  '--violet',
  '--amber',
  '--accent-2',
  '--red',
] as const;

/** The CSS var for a lane index, cycling the palette so distant lanes still differ. */
export function laneColorVar(lane: number): string {
  const idx = ((lane % LANE_VARS.length) + LANE_VARS.length) % LANE_VARS.length;
  return LANE_VARS[idx];
}

/** Geometry constants shared by the SVG gutter + the row layout (px). ROW_HEIGHT and
 *  NODE_RADIUS are consumed by the component; LANE_WIDTH/GUTTER_PAD only feed the helpers
 *  below, so they stay module-private. */
export const ROW_HEIGHT = 30;
const LANE_WIDTH = 16;
export const NODE_RADIUS = 4.5;
const GUTTER_PAD = 10;

/** Pixel X-center of a lane within the SVG gutter. */
export function laneX(lane: number): number {
  return GUTTER_PAD + lane * LANE_WIDTH;
}

/** Pixel Y-center of a row given its index in the (top-to-bottom) commit order. */
export function rowY(index: number): number {
  return index * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/** Total gutter width needed for `laneCount` lanes (plus padding on both sides). */
export function gutterWidth(laneCount: number): number {
  return GUTTER_PAD * 2 + Math.max(0, laneCount - 1) * LANE_WIDTH;
}

export interface EdgePath {
  fromSha: string;
  toSha: string;
  /** SVG path `d` from this commit's node down to its parent's node. */
  d: string;
  /** The lane that owns the edge's COLOR — the destination (parent) lane, so a branch
   *  keeps its hue as it descends; a merge edge into a side lane reads as that lane. */
  colorLane: number;
}

/**
 * Build the SVG path for one parent edge. A straight in-lane edge is a vertical line; a
 * lane-changing edge (branch/merge) is a smooth vertical-bezier elbow so it reads as a
 * curve, not a diagonal — matching the bespoke diff/canvas density. `fromIndex`/`toIndex`
 * are the rows' positions in the rendered order (parent may be far below).
 */
export function edgePath(edge: GraphEdge, fromIndex: number, toIndex: number): EdgePath {
  const x1 = laneX(edge.fromLane);
  const y1 = rowY(fromIndex);
  const x2 = laneX(edge.toLane);
  const y2 = rowY(toIndex);
  if (edge.fromLane === edge.toLane) {
    return {
      fromSha: edge.fromSha,
      toSha: edge.toSha,
      d: `M${x1} ${y1} L${x2} ${y2}`,
      colorLane: edge.toLane,
    };
  }
  // Bezier with vertical control handles → an S-curve that leaves/enters each node
  // vertically (so the join at the node reads clean), bending across the lane gap.
  const midY = (y1 + y2) / 2;
  const d = `M${x1} ${y1} C${x1} ${midY} ${x2} ${midY} ${x2} ${y2}`;
  return { fromSha: edge.fromSha, toSha: edge.toSha, d, colorLane: edge.toLane };
}

/**
 * Resolve every edge to a drawable path, dropping edges whose parent isn't in the loaded
 * page (a parent older than the current limit has no row to point at). `indexOf` maps a
 * sha to its rendered row index (or -1).
 */
export function edgePaths(layout: GraphLayout, indexOf: (sha: string) => number): EdgePath[] {
  const out: EdgePath[] = [];
  for (const edge of layout.edges) {
    const fromIndex = indexOf(edge.fromSha);
    const toIndex = indexOf(edge.toSha);
    if (fromIndex < 0 || toIndex < 0) continue;
    out.push(edgePath(edge, fromIndex, toIndex));
  }
  return out;
}

export interface BadgeSplit {
  visible: GitRef[];
  /** How many refs were hidden past the cap (0 = none). */
  overflow: number;
}

/**
 * Cap visible ref badges so a heavily-tagged commit doesn't crowd the row. HEAD always
 * stays visible (it's the "you are here" marker); the rest fill the remaining slots in
 * their parsed order. Returns the overflow count for a "+k" pill.
 */
export function splitBadges(refs: GitRef[], cap: number): BadgeSplit {
  if (refs.length <= cap) return { visible: refs, overflow: 0 };
  const head = refs.filter((r) => r.kind === 'head');
  const rest = refs.filter((r) => r.kind !== 'head');
  const room = Math.max(0, cap - head.length);
  const visible = [...head, ...rest.slice(0, room)];
  return { visible, overflow: refs.length - visible.length };
}

/** True when a commit is a merge (≥2 parents) — drawn as a hollow diamond node. */
export function isMerge(parents: string[]): boolean {
  return parents.length >= 2;
}
