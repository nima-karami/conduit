// Two-level layout for a mermaid flowchart: `computeLayout` arranges the direct members of one
// container, and subgraphs are folded in bottom-up as boxes sized by their own region.
// Positions are never persisted — see docs/plans/2026-09-19-interactive-plan.plan.md, Contracts.

import { computeLayout, type XY } from './arch-layout';
import type { FlowGraph, FlowNode } from './mermaid-flow';

export interface FlowRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowLayout {
  positions: Record<string, XY>;
  regions: Record<string, FlowRegion>;
}

export const FLOW_PAD = 24;
export const FLOW_XGAP = 220;
export const FLOW_YGAP = 90;

interface Size {
  w: number;
  h: number;
}

interface Container extends Size {
  members: string[];
  /** Member top-left relative to this container's own top-left. */
  local: Record<string, XY>;
}

export function layoutFlow(g: FlowGraph, size: (n: FlowNode) => Size): FlowLayout {
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const subById = new Map(g.subgraphs.map((s) => [s.id, s]));
  const parentOf = (id: string): string | null =>
    (nodeById.get(id) ?? subById.get(id))?.parent ?? null;

  // [id, …containers outward…, null]. The seen-set only guards malformed input; the reducers and
  // the parser both make a parent cycle unreachable.
  const chainOf = (id: string): (string | null)[] => {
    const chain: (string | null)[] = [id];
    const seen = new Set([id]);
    for (let at = parentOf(id); at !== null && !seen.has(at); at = parentOf(at)) {
      chain.push(at);
      seen.add(at);
    }
    chain.push(null);
    return chain;
  };

  // An edge belongs to the deepest container that holds both endpoints, represented there by
  // whichever member (node or subgraph) each endpoint sits under.
  const edgesIn = new Map<string | null, { source: string; target: string }[]>();
  for (const e of g.edges) {
    const from = chainOf(e.source);
    const to = chainOf(e.target);
    const outer = new Set(to.slice(1));
    const i = from.findIndex((c, k) => k > 0 && outer.has(c));
    if (i < 0) continue;
    const source = from[i - 1] as string;
    const target = to[to.indexOf(from[i]) - 1] as string;
    if (source === target) continue;
    const container = from[i];
    const list = edgesIn.get(container);
    if (list) list.push({ source, target });
    else edgesIn.set(container, [{ source, target }]);
  }

  const boxes = new Map<string, Container>();
  const sizeOf = (id: string): Size => {
    const n = nodeById.get(id);
    if (n) return size(n);
    const c = boxes.get(id);
    return c ? { w: c.w, h: c.h } : { w: 0, h: 0 };
  };

  // computeLayout always advances layers along x; a vertical flowchart is that layout transposed.
  const vertical = g.direction === 'TB' || g.direction === 'TD' || g.direction === 'BT';
  const mirrored = g.direction === 'BT' || g.direction === 'RL';

  const layoutContainer = (container: string | null, pad: number): Container => {
    const members = [
      ...g.nodes.filter((n) => n.parent === container).map((n) => n.id),
      ...g.subgraphs.filter((s) => s.parent === container).map((s) => s.id),
    ];
    const local: Record<string, XY> = {};
    if (members.length === 0) return { members, local, w: pad * 2, h: pad * 2 };

    const raw = computeLayout(
      members.map((id) => ({ id })),
      edgesIn.get(container) ?? [],
      {
        xGap: vertical ? FLOW_YGAP : FLOW_XGAP,
        yGap: vertical ? FLOW_XGAP : FLOW_YGAP,
        size: (id) => {
          const s = sizeOf(id);
          return vertical ? { w: s.h, h: s.w } : s;
        },
      },
    );

    const placed = members.map((id) => {
      const p = raw[id];
      const s = sizeOf(id);
      return vertical ? { x: p.y, y: p.x, ...s } : { x: p.x, y: p.y, ...s };
    });
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const b of placed) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }

    // Reflecting about the bounding box leaves the box itself unchanged, so the padding below is
    // the same either way.
    members.forEach((id, i) => {
      const b = placed[i];
      const x = mirrored && !vertical ? minX + maxX - b.x - b.w : b.x;
      const y = mirrored && vertical ? minY + maxY - b.y - b.h : b.y;
      local[id] = { x: x - minX + pad, y: y - minY + pad };
    });
    return { members, local, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  };

  const depthOf = (id: string): number => chainOf(id).length;
  for (const s of [...g.subgraphs].sort((a, b) => depthOf(b.id) - depthOf(a.id)))
    boxes.set(s.id, layoutContainer(s.id, FLOW_PAD));

  const positions: Record<string, XY> = {};
  const regions: Record<string, FlowRegion> = {};
  const place = (c: Container, ox: number, oy: number): void => {
    for (const id of c.members) {
      const x = ox + c.local[id].x;
      const y = oy + c.local[id].y;
      const child = boxes.get(id);
      if (!child) {
        positions[id] = { x, y };
        continue;
      }
      regions[id] = { x, y, w: child.w, h: child.h };
      place(child, x, y);
    }
  };
  place(layoutContainer(null, 0), 0, 0);
  return { positions, regions };
}
