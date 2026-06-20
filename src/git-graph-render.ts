import type { CommitNode, GitRef, GraphEdge, GraphLayout, GraphRow } from './protocol';

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

/**
 * PURE. Assign each commit (in the given `--date-order` order) to a lane and produce
 * parent edges, the standard commit-graph algorithm:
 *
 *  - `lanes[i]` holds the sha each active lane is currently *waiting for* (a pending
 *    child→parent reservation). A commit takes the lowest lane reserved for it, or a new
 *    lane if none is.
 *  - Its FIRST parent continues the commit's own lane (the mainline stays straight).
 *  - Each ADDITIONAL parent (a merge) reuses an existing lane already waiting for that
 *    parent, else opens a new lane — yielding ≥2 outgoing edges for a merge commit.
 *  - A lane whose reservation isn't re-established by any parent is freed (tip / root).
 *
 * Deterministic: lowest-index lane always wins. `laneCount` is the max lane ever used.
 *
 * Lives here (the node-free renderer-shared module, not git-history.ts which pulls
 * node:child_process) so Slice B can re-run it on a CLIENT-side filtered commit subset —
 * keeping lanes/edges correct for the visible rows. git-history.ts re-exports it for the
 * host + the existing unit tests.
 */
export function assignLanes(commits: CommitNode[]): GraphLayout {
  const rows: GraphRow[] = [];
  const edges: GraphEdge[] = [];
  // Active lanes; an entry is the sha that lane is waiting to place next, or null = free.
  const lanes: (string | null)[] = [];
  let laneCount = 0;

  const claimLane = (sha: string): number => {
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null) {
        lanes[i] = sha;
        return i;
      }
    }
    lanes.push(sha);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    // Place this commit in the lowest lane reserved for it; if none, open a fresh lane.
    let lane = lanes.indexOf(commit.sha);
    if (lane === -1) lane = claimLane(commit.sha);
    // This lane's reservation is consumed by placing the commit; clear it, then let the
    // commit's parents re-establish reservations below.
    lanes[lane] = null;
    rows.push({ sha: commit.sha, lane });
    if (lane + 1 > laneCount) laneCount = lane + 1;

    commit.parents.forEach((parent, idx) => {
      let toLane: number;
      if (idx === 0) {
        // First parent continues this commit's lane (mainline stays straight) — unless
        // another lane is ALREADY waiting for this same parent (two children of one
        // commit), in which case join that existing lane to avoid a duplicate.
        const existing = lanes.indexOf(parent);
        if (existing !== -1) {
          toLane = existing;
        } else {
          lanes[lane] = parent;
          toLane = lane;
        }
      } else {
        // Merge parent: reuse a lane already awaiting it, else branch a new lane.
        const existing = lanes.indexOf(parent);
        toLane = existing !== -1 ? existing : claimLane(parent);
      }
      if (toLane + 1 > laneCount) laneCount = toLane + 1;
      edges.push({ fromSha: commit.sha, toSha: parent, fromLane: lane, toLane });
    });
  }

  return { rows, edges, laneCount };
}
