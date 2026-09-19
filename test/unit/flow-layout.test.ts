import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLOW_PAD, type FlowRegion, layoutFlow } from '../../src/flow-layout';
import { type FlowGraph, type FlowNode, parseFlowchart } from '../../src/mermaid-flow';

const FIXTURE = path.join(__dirname, '..', 'e2e', 'fixtures', 'plan', 'identity.md');

function graphOf(source: string): FlowGraph {
  const parsed = parseFlowchart(source);
  if (!parsed.ok) throw new Error(`${parsed.reason} (line ${parsed.line})`);
  return parsed.graph;
}

function fixtureGraph(): FlowGraph {
  const fence = /```mermaid\r?\n([\s\S]*?)```/.exec(fs.readFileSync(FIXTURE, 'utf8'));
  if (!fence) throw new Error('no mermaid fence in the fixture');
  return graphOf(fence[1]);
}

// Deliberately uneven so a layout that ignored `size` would collapse boxes onto each other.
const size = (n: FlowNode) => ({ w: 60 + n.label.length * 7, h: n.shape === 'circle' ? 64 : 36 });

const NESTED = [
  'flowchart LR',
  'subgraph outer [Outer]',
  '  a([Start])',
  '  subgraph inner [Inner]',
  '    b{Decide}',
  '    c((Done))',
  '  end',
  '  subgraph sibling [Sibling]',
  '    f[Fan out to a much longer label]',
  '  end',
  'end',
  'd[[Worker]]',
  'e(Plain)',
  'a --> b',
  'b --> c',
  'c --> f',
  'a --> d',
  'd --> e',
  'f --> d',
  '',
].join('\n');

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const contains = (outer: Box, inner: Box, margin: number): boolean =>
  inner.x >= outer.x + margin &&
  inner.y >= outer.y + margin &&
  inner.x + inner.w <= outer.x + outer.w - margin &&
  inner.y + inner.h <= outer.y + outer.h - margin;

function boxesOf(g: FlowGraph): Map<string, Box> {
  const { positions, regions } = layoutFlow(g, size);
  const boxes = new Map<string, Box>();
  for (const n of g.nodes) boxes.set(n.id, { ...positions[n.id], ...size(n) });
  for (const sub of g.subgraphs) boxes.set(sub.id, regions[sub.id] as FlowRegion);
  return boxes;
}

/** Direct members of each container, keyed by subgraph id (`null` = the top level). */
function membersByContainer(g: FlowGraph): Map<string | null, string[]> {
  const out = new Map<string | null, string[]>([[null, []]]);
  for (const s of g.subgraphs) out.set(s.id, []);
  for (const n of g.nodes) out.get(n.parent)?.push(n.id);
  for (const s of g.subgraphs) out.get(s.parent)?.push(s.id);
  return out;
}

describe('layoutFlow', () => {
  it('every node gets a position and every subgraph a region', () => {
    for (const g of [fixtureGraph(), graphOf(NESTED)]) {
      const { positions, regions } = layoutFlow(g, size);

      expect(Object.keys(positions).sort()).toEqual(g.nodes.map((n) => n.id).sort());
      expect(Object.keys(regions).sort()).toEqual(g.subgraphs.map((s) => s.id).sort());
      for (const p of Object.values(positions)) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
      for (const r of Object.values(regions)) expect(r.w > 0 && r.h > 0).toBe(true);
    }
  });

  it('members lie inside their region with FLOW_PAD margin', () => {
    const g = graphOf(NESTED);
    const boxes = boxesOf(g);

    for (const [container, members] of membersByContainer(g)) {
      if (container === null || members.length === 0) continue;
      const region = boxes.get(container) as Box;
      for (const id of members) expect(contains(region, boxes.get(id) as Box, FLOW_PAD)).toBe(true);
      // and the region is tight around them, not arbitrarily large
      const left = Math.min(...members.map((id) => (boxes.get(id) as Box).x));
      const top = Math.min(...members.map((id) => (boxes.get(id) as Box).y));
      expect(left - region.x).toBe(FLOW_PAD);
      expect(top - region.y).toBe(FLOW_PAD);
    }
  });

  it('a nested subgraph lies inside its parent region', () => {
    const boxes = boxesOf(graphOf(NESTED));

    expect(contains(boxes.get('outer') as Box, boxes.get('inner') as Box, FLOW_PAD)).toBe(true);
    expect(contains(boxes.get('outer') as Box, boxes.get('sibling') as Box, FLOW_PAD)).toBe(true);
    expect(contains(boxes.get('inner') as Box, boxes.get('b') as Box, FLOW_PAD)).toBe(true);
    expect(contains(boxes.get('outer') as Box, boxes.get('b') as Box, FLOW_PAD)).toBe(true);
  });

  it('TB places a source above its sink; LR places it left', () => {
    const chain = (dir: string) => {
      const g = graphOf(`flowchart ${dir}\nsrc[Source] --> sink[Sink]\n`);
      const { positions } = layoutFlow(g, size);
      const centre = (id: string) => {
        const n = g.nodes.find((x) => x.id === id) as FlowNode;
        return { cx: positions[id].x + size(n).w / 2, cy: positions[id].y + size(n).h / 2 };
      };
      return { src: centre('src'), sink: centre('sink') };
    };

    const lr = chain('LR');
    expect(lr.src.cx).toBeLessThan(lr.sink.cx);
    expect(lr.src.cy).toBeCloseTo(lr.sink.cy, 0); // one node per layer — columns share a centre line

    const tb = chain('TB');
    expect(tb.src.cy).toBeLessThan(tb.sink.cy);
    expect(tb.src.cx).toBeCloseTo(tb.sink.cx, 0);

    expect(chain('RL').src.cx).toBeGreaterThan(chain('RL').sink.cx);
    expect(chain('BT').src.cy).toBeGreaterThan(chain('BT').sink.cy);
  });

  it('deterministic for the same graph', () => {
    const g = graphOf(NESTED);
    expect(layoutFlow(g, size)).toEqual(layoutFlow(g, size));
    // a second parse of the same source must land in the same place too
    expect(layoutFlow(graphOf(NESTED), size)).toEqual(layoutFlow(g, size));
  });

  it('no two nodes or regions overlap in the fixture and in a two-nested-subgraph case', () => {
    let compared = 0;
    for (const g of [fixtureGraph(), graphOf(NESTED)]) {
      const boxes = boxesOf(g);
      // Siblings must be disjoint; a region legitimately encloses its own members, so overlap is
      // only meaningful between members of one container.
      for (const members of membersByContainer(g).values())
        for (let i = 0; i < members.length; i++)
          for (let j = i + 1; j < members.length; j++) {
            compared++;
            expect(overlaps(boxes.get(members[i]) as Box, boxes.get(members[j]) as Box)).toBe(
              false,
            );
          }
    }
    expect(compared).toBeGreaterThan(6); // a layout that placed nothing would pass vacuously
  });
});
