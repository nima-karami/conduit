import { describe, expect, it } from 'vitest';
import {
  addEdge,
  addNode,
  breadcrumb,
  ensureChildGraph,
  moveNode,
  removeEdge,
  removeNode,
  restoreArchitecture,
  seedArchitecture,
  serializeArchitecture,
  setEdgeLabel,
  updateNode,
} from '../../src/architecture';

describe('architecture model', () => {
  it('seeds a root graph with nodes and edges', () => {
    const doc = seedArchitecture('Demo');
    const root = doc.graphs[doc.rootGraph];
    expect(root.title).toBe('Demo');
    expect(root.nodes.length).toBeGreaterThan(0);
    expect(root.edges.length).toBeGreaterThan(0);
  });

  it('adds, updates and moves a node', () => {
    let doc = seedArchitecture();
    const { doc: d2, id } = addNode(doc, doc.rootGraph, {
      title: 'Cache',
      kind: 'data',
      x: 10,
      y: 20,
    });
    doc = d2;
    expect(doc.graphs[doc.rootGraph].nodes.find((n) => n.id === id)).toMatchObject({
      title: 'Cache',
      kind: 'data',
      x: 10,
      y: 20,
    });
    doc = updateNode(doc, doc.rootGraph, id, { subtitle: 'redis' });
    expect(doc.graphs[doc.rootGraph].nodes.find((n) => n.id === id)?.subtitle).toBe('redis');
    doc = moveNode(doc, doc.rootGraph, id, 99, 88);
    expect(doc.graphs[doc.rootGraph].nodes.find((n) => n.id === id)).toMatchObject({
      x: 99,
      y: 88,
    });
  });

  it('adds an edge, rejects duplicates and self-loops', () => {
    const doc = seedArchitecture();
    const g = doc.rootGraph;
    const before = doc.graphs[g].edges.length;
    const d1 = addEdge(doc, g, 'n-ui', 'n-store');
    expect(d1.graphs[g].edges.length).toBe(before + 1);
    const d2 = addEdge(d1, g, 'n-ui', 'n-store'); // duplicate
    expect(d2.graphs[g].edges.length).toBe(before + 1);
    const d3 = addEdge(d2, g, 'n-ui', 'n-ui'); // self-loop
    expect(d3.graphs[g].edges.length).toBe(before + 1);
  });

  it('removes a node together with its incident edges', () => {
    const doc = seedArchitecture();
    const g = doc.rootGraph;
    const out = removeNode(doc, g, 'n-core');
    expect(out.graphs[g].nodes.some((n) => n.id === 'n-core')).toBe(false);
    expect(out.graphs[g].edges.some((e) => e.source === 'n-core' || e.target === 'n-core')).toBe(
      false,
    );
  });

  it('removes an edge by id', () => {
    const doc = seedArchitecture();
    const g = doc.rootGraph;
    const edgeId = doc.graphs[g].edges[0].id;
    const out = removeEdge(doc, g, edgeId);
    expect(out.graphs[g].edges.some((e) => e.id === edgeId)).toBe(false);
  });

  it('sets, edits and clears an edge label', () => {
    const doc = seedArchitecture();
    const g = doc.rootGraph;
    // seeded e1 already has a label; pick an edge and overwrite it
    const edgeId = doc.graphs[g].edges[0].id;

    const labeled = setEdgeLabel(doc, g, edgeId, '  calls  '); // trims
    expect(labeled.graphs[g].edges.find((e) => e.id === edgeId)?.label).toBe('calls');

    const edited = setEdgeLabel(labeled, g, edgeId, 'reads from');
    expect(edited.graphs[g].edges.find((e) => e.id === edgeId)?.label).toBe('reads from');

    // empty / whitespace clears the property entirely (round-trips as undefined)
    const cleared = setEdgeLabel(edited, g, edgeId, '   ');
    const clearedEdge = cleared.graphs[g].edges.find((e) => e.id === edgeId);
    expect(clearedEdge?.label).toBeUndefined();
    expect(Object.hasOwn(clearedEdge as object, 'label')).toBe(false);
  });

  it('setEdgeLabel is pure and no-ops on unknown graph/edge', () => {
    const doc = seedArchitecture();
    const g = doc.rootGraph;
    const edgeId = doc.graphs[g].edges[0].id;
    const before = JSON.stringify(doc);

    expect(setEdgeLabel(doc, 'no-such-graph', edgeId, 'x')).toBe(doc);
    expect(setEdgeLabel(doc, g, 'no-such-edge', 'x')).toBe(doc);
    // original doc untouched (no mutation)
    expect(JSON.stringify(doc)).toBe(before);
    const out = setEdgeLabel(doc, g, edgeId, 'new');
    expect(out).not.toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('creates a child graph and builds a breadcrumb to it', () => {
    const doc = seedArchitecture();
    const { doc: d2, childGraph } = ensureChildGraph(doc, doc.rootGraph, 'n-core');
    expect(childGraph).toBeTruthy();
    expect(d2.graphs[childGraph]).toBeTruthy();
    // ensure is idempotent
    const { childGraph: again } = ensureChildGraph(d2, d2.rootGraph, 'n-core');
    expect(again).toBe(childGraph);
    const crumbs = breadcrumb(d2, childGraph);
    expect(crumbs.map((c) => c.id)).toEqual([d2.rootGraph, childGraph]);
  });

  it('prunes nested child graphs when removing their owning node', () => {
    let doc = seedArchitecture();
    const { doc: d2, childGraph } = ensureChildGraph(doc, doc.rootGraph, 'n-core');
    doc = d2;
    expect(doc.graphs[childGraph]).toBeTruthy();
    doc = removeNode(doc, doc.rootGraph, 'n-core');
    expect(doc.graphs[childGraph]).toBeUndefined();
  });

  it('round-trips through serialize/restore and drops dangling child refs', () => {
    const doc = seedArchitecture();
    const restored = restoreArchitecture(serializeArchitecture(doc));
    expect(restored?.rootGraph).toBe(doc.rootGraph);
    expect(Object.keys(restored?.graphs ?? {})).toEqual(Object.keys(doc.graphs));

    // A node pointing at a missing graph should have its childGraph cleared.
    const blob = JSON.stringify({
      version: 1,
      rootGraph: 'r',
      graphs: {
        r: {
          id: 'r',
          title: 'R',
          nodes: [{ id: 'a', title: 'A', kind: 'service', x: 0, y: 0, childGraph: 'ghost' }],
          edges: [],
        },
      },
    });
    const out = restoreArchitecture(blob);
    expect(out?.graphs.r.nodes[0].childGraph).toBeUndefined();
  });

  it('returns null for missing/invalid blobs', () => {
    expect(restoreArchitecture(undefined)).toBeNull();
    expect(restoreArchitecture('not json')).toBeNull();
    expect(restoreArchitecture(JSON.stringify({ version: 1, graphs: {} }))).toBeNull(); // no rootGraph
  });
});
