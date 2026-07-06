import { describe, expect, it } from 'vitest';
import { type ArchDoc, addNode, insertSpace, seedArchitecture } from '../../src/architecture';

function grid(): { doc: ArchDoc; g: string; ids: Record<string, string> } {
  let doc = seedArchitecture('T');
  const g = doc.rootGraph;
  doc = { ...doc, graphs: { [g]: { id: g, title: 'root', nodes: [], edges: [] } } };
  const ids: Record<string, string> = {};
  const put = (name: string, x: number, y: number) => {
    const r = addNode(doc, g, { title: name, x, y });
    doc = r.doc;
    ids[name] = r.id;
  };
  put('near', 0, 0);
  put('mid', 100, 100);
  put('far', 300, 300);
  return { doc, g, ids };
}

const xOf = (doc: ArchDoc, g: string, id: string) =>
  doc.graphs[g].nodes.find((n) => n.id === id)?.x;
const yOf = (doc: ArchDoc, g: string, id: string) =>
  doc.graphs[g].nodes.find((n) => n.id === id)?.y;

describe('insertSpace', () => {
  it('opens horizontal space: nodes at x >= origin shift by dx, nodes left of it stay', () => {
    const { doc, g, ids } = grid();
    const d2 = insertSpace(doc, g, 'x', 100, 50);
    expect(xOf(d2, g, ids.near)).toBe(0); // x=0 < 100 → stays
    expect(xOf(d2, g, ids.mid)).toBe(150); // x=100 >= 100 → +50
    expect(xOf(d2, g, ids.far)).toBe(350); // x=300 → +50
  });

  it('opens vertical space along y independently', () => {
    const { doc, g, ids } = grid();
    const d2 = insertSpace(doc, g, 'y', 100, 40);
    expect(yOf(d2, g, ids.near)).toBe(0);
    expect(yOf(d2, g, ids.mid)).toBe(140);
    expect(yOf(d2, g, ids.far)).toBe(340);
    // x is untouched by a y-axis insert.
    expect(xOf(d2, g, ids.far)).toBe(300);
  });

  it('tightens with a negative delta but clamps so a node never crosses the origin', () => {
    const { doc, g, ids } = grid();
    // mid is at x=100 (== origin); far at x=300. Pull back by 500 → both clamp to the guide (100).
    const d2 = insertSpace(doc, g, 'x', 100, -500);
    expect(xOf(d2, g, ids.near)).toBe(0); // near cluster untouched
    expect(xOf(d2, g, ids.mid)).toBe(100); // clamped at origin, not below
    expect(xOf(d2, g, ids.far)).toBe(100); // clamped at origin
  });

  it('is a no-op for a zero delta or an unknown graph', () => {
    const { doc, g } = grid();
    expect(insertSpace(doc, g, 'x', 100, 0)).toBe(doc);
    expect(insertSpace(doc, 'nope', 'x', 100, 50)).toBe(doc);
  });
});
