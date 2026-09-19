import { describe, expect, it } from 'vitest';
import {
  applyAutoLayout,
  autoLayoutUnpositioned,
  computeLayout,
  needsLayout,
} from '../../src/arch-layout';
import { type ArchDoc, addEdge, addNode, seedArchitecture } from '../../src/architecture';

const n = (id: string) => ({ id });
const e = (source: string, target: string) => ({ source, target });

describe('computeLayout', () => {
  it('lays a chain out left-to-right by layer', () => {
    const pos = computeLayout([n('a'), n('b'), n('c')], [e('a', 'b'), e('b', 'c')], { xGap: 300 });
    expect(pos.a.x).toBe(0);
    expect(pos.b.x).toBe(300);
    expect(pos.c.x).toBe(600);
  });

  it('places a diamond with the join one layer past its branches', () => {
    const pos = computeLayout(
      [n('a'), n('b'), n('c'), n('d')],
      [e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')],
      { xGap: 300 },
    );
    expect(pos.a.x).toBe(0);
    expect(pos.b.x).toBe(300);
    expect(pos.c.x).toBe(300);
    expect(pos.d.x).toBe(600); // longest path a→b→d / a→c→d = 2
    // the two middle-layer nodes are separated vertically
    expect(pos.b.y).not.toBe(pos.c.y);
  });

  it('terminates and assigns finite layers on a cycle', () => {
    const pos = computeLayout([n('a'), n('b'), n('c')], [e('a', 'b'), e('b', 'c'), e('c', 'a')], {
      xGap: 300,
    });
    for (const id of ['a', 'b', 'c']) {
      expect(Number.isFinite(pos[id].x)).toBe(true);
      expect(Number.isFinite(pos[id].y)).toBe(true);
    }
  });

  // Locked: the no-size path must stay byte-identical, so `size` can be added without moving
  // a single existing architecture card.
  const FIXTURE_NODES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(n);
  const FIXTURE_EDGES = [
    e('a', 'b'),
    e('a', 'c'),
    e('b', 'd'),
    e('c', 'd'),
    e('d', 'f'),
    e('f', 'g'),
    e('g', 'd'),
    e('a', 'e'),
  ];

  it('without size the positions are unchanged from the recorded fixture', () => {
    expect(computeLayout(FIXTURE_NODES, FIXTURE_EDGES)).toEqual({
      a: { x: 0, y: -75 },
      b: { x: 340, y: -225 },
      c: { x: 340, y: -75 },
      d: { x: 680, y: 0 },
      e: { x: 340, y: 225 },
      f: { x: 0, y: 75 },
      g: { x: 340, y: 75 },
    });
  });

  it('with size, layer x advances by the widest node of the previous layer plus xGap', () => {
    const widths: Record<string, number> = { a: 100, b: 250, c: 60, d: 40 };
    const pos = computeLayout(
      [n('a'), n('b'), n('c'), n('d')],
      [e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')],
      { xGap: 20, yGap: 10, size: (id) => ({ w: widths[id], h: 30 }) },
    );

    expect(pos.a.x).toBe(0);
    expect(pos.b.x).toBe(120); // 0 + width(a) 100 + xGap 20
    expect(pos.c.x).toBe(120);
    expect(pos.d.x).toBe(390); // 120 + widest of {b:250, c:60} + xGap 20
  });

  it('with size, nodes in a layer are stacked by height plus yGap', () => {
    const heights: Record<string, number> = { a: 10, b: 40, c: 80, d: 25 };
    const pos = computeLayout(
      [n('a'), n('b'), n('c'), n('d')],
      [e('a', 'b'), e('a', 'c'), e('a', 'd')],
      { xGap: 20, yGap: 10, size: (id) => ({ w: 50, h: heights[id] }) },
    );

    const column = ['b', 'c', 'd'].sort((l, r) => pos[l].y - pos[r].y);
    for (let i = 0; i < column.length - 1; i++)
      expect(pos[column[i + 1]].y - pos[column[i]].y).toBe(heights[column[i]] + 10);
  });

  it('ignores boundary endpoints and self-loops', () => {
    const pos = computeLayout([n('a'), n('b')], [e('boundary:in', 'a'), e('a', 'a'), e('a', 'b')], {
      xGap: 300,
    });
    expect(pos.a.x).toBe(0);
    expect(pos.b.x).toBe(300);
  });
});

describe('needsLayout', () => {
  const graph = (nodes: { x: number; y: number }[]) => ({
    id: 'g',
    title: 'g',
    nodes: nodes.map((p, i) => ({ id: `n${i}`, title: `n${i}`, kind: 'service' as const, ...p })),
    edges: [],
  });
  it('is true when ≥2 nodes share one point (agent omitted x/y → 0,0)', () => {
    expect(
      needsLayout(
        graph([
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ]),
      ),
    ).toBe(true);
  });
  it('is false when nodes are positioned, or there is fewer than two', () => {
    expect(
      needsLayout(
        graph([
          { x: 0, y: 0 },
          { x: 200, y: 0 },
        ]),
      ),
    ).toBe(false);
    expect(needsLayout(graph([{ x: 0, y: 0 }]))).toBe(false);
  });
});

describe('applyAutoLayout / autoLayoutUnpositioned', () => {
  function chainAtOrigin(): { doc: ArchDoc; g: string; ids: string[] } {
    let doc = seedArchitecture('T');
    const g = doc.rootGraph;
    doc = { ...doc, graphs: { [g]: { id: g, title: 'root', nodes: [], edges: [] } } };
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = addNode(doc, g, { title: `N${i}`, x: 0, y: 0 });
      doc = r.doc;
      ids.push(r.id);
    }
    doc = addEdge(doc, g, ids[0], ids[1]);
    doc = addEdge(doc, g, ids[1], ids[2]);
    return { doc, g, ids };
  }

  it('repositions a graph so no two connected nodes share an x', () => {
    const { doc, g, ids } = chainAtOrigin();
    const laid = applyAutoLayout(doc, g);
    const xs = ids.map((id) => laid.graphs[g].nodes.find((nd) => nd.id === id)?.x);
    expect(new Set(xs).size).toBe(3); // three distinct layers
  });

  it('lays out only the graphs that look unpositioned', () => {
    const { doc, g } = chainAtOrigin();
    const before = doc.graphs[g].nodes.every((nd) => nd.x === 0);
    expect(before).toBe(true);
    const laid = autoLayoutUnpositioned(doc);
    expect(laid.graphs[g].nodes.every((nd) => nd.x === 0)).toBe(false);
    // running again is a no-op (now positioned)
    expect(autoLayoutUnpositioned(laid)).toBe(laid);
  });
});
