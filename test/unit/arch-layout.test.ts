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
