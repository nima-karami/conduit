import { describe, expect, it } from 'vitest';
import {
  type ArchDoc,
  addNode,
  addPort,
  addTypedEdge,
  encapsulateSelection,
  restoreArchitecture,
  seedArchitecture,
  serializeArchitecture,
} from '../../src/architecture';

/**
 * Build:  S ──▶ A ──▶ B ──▶ T   (S,T external; A,B to encapsulate)
 * Ports:  S.out → A.in (crossing in), A.out → B.in (internal), B.out → T.in (crossing out).
 */
function chainDoc() {
  let doc = seedArchitecture('T');
  const g = doc.rootGraph;
  doc = { ...doc, graphs: { [g]: { id: g, title: 'root', nodes: [], edges: [] } } };
  const mk = (title: string, x: number) => {
    const r = addNode(doc, g, { title, x, y: 0 });
    doc = r.doc;
    return r.id;
  };
  const S = mk('S', 0);
  const A = mk('A', 100);
  const B = mk('B', 200);
  const T = mk('T', 300);
  const port = (node: string, dir: 'in' | 'out') => {
    const r = addPort(doc, g, node, dir);
    doc = r.doc;
    return r.portId;
  };
  const sOut = port(S, 'out');
  const aIn = port(A, 'in');
  const aOut = port(A, 'out');
  const bIn = port(B, 'in');
  const bOut = port(B, 'out');
  const tIn = port(T, 'in');
  doc = addTypedEdge(doc, g, S, sOut, A, aIn);
  doc = addTypedEdge(doc, g, A, aOut, B, bIn);
  doc = addTypedEdge(doc, g, B, bOut, T, tIn);
  return { doc, g, S, A, B, T };
}

describe('encapsulateSelection', () => {
  it('moves the selection into a child graph and infers one input + one output', () => {
    const { doc, g, A, B, S, T } = chainDoc();
    const { doc: d2, componentId, childGraph } = encapsulateSelection(doc, g, [A, B]);
    expect(componentId).toBeTruthy();
    expect(childGraph).toBeTruthy();

    const parent = d2.graphs[g];
    const comp = parent.nodes.find((n) => n.id === componentId);
    // Parent keeps S + T + the new component; A and B are gone.
    expect(parent.nodes.map((n) => n.id).sort()).toEqual([S, T, componentId].sort());
    expect(comp?.inputs?.length).toBe(1);
    expect(comp?.outputs?.length).toBe(1);
    expect(comp?.childGraph).toBe(childGraph);

    // Parent wiring: S → component.input, component.output → T.
    const inEdge = parent.edges.find((e) => e.target === componentId);
    const outEdge = parent.edges.find((e) => e.source === componentId);
    expect(inEdge?.source).toBe(S);
    expect(inEdge?.targetPort).toBe(comp?.inputs?.[0].id);
    expect(outEdge?.target).toBe(T);
    expect(outEdge?.sourcePort).toBe(comp?.outputs?.[0].id);
  });

  it('builds the child graph with the internal edge + boundary edges', () => {
    const { doc, g, A, B } = chainDoc();
    const { doc: d2, componentId, childGraph } = encapsulateSelection(doc, g, [A, B]);
    const comp = d2.graphs[g].nodes.find((n) => n.id === componentId);
    const child = d2.graphs[childGraph];
    expect(child.nodes.map((n) => n.id).sort()).toEqual([A, B].sort());
    // A→B internal edge preserved.
    expect(child.edges.some((e) => e.source === A && e.target === B)).toBe(true);
    // boundary:in → A (the component's input flows to A).
    const bIn = child.edges.find((e) => e.source === 'boundary:in');
    expect(bIn?.target).toBe(A);
    expect(bIn?.sourcePort).toBe(comp?.inputs?.[0].id);
    // B → boundary:out (B's output leaves via the component's output).
    const bOut = child.edges.find((e) => e.target === 'boundary:out');
    expect(bOut?.source).toBe(B);
    expect(bOut?.targetPort).toBe(comp?.outputs?.[0].id);
  });

  it('round-trips through serialize/restore (boundary edges survive validation)', () => {
    const { doc, g, A, B } = chainDoc();
    const { doc: d2, childGraph } = encapsulateSelection(doc, g, [A, B]);
    const restored = restoreArchitecture(serializeArchitecture(d2));
    expect(restored).not.toBeNull();
    const child = restored?.graphs[childGraph];
    expect(child?.edges.some((e) => e.source === 'boundary:in')).toBe(true);
    expect(child?.edges.some((e) => e.target === 'boundary:out')).toBe(true);
  });

  it('is a no-op on an empty selection', () => {
    const { doc, g } = chainDoc();
    const { doc: d2, componentId } = encapsulateSelection(doc, g, []);
    expect(componentId).toBe('');
    expect(d2).toBe(doc);
  });
});
