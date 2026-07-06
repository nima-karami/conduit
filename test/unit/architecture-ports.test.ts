import { describe, expect, it } from 'vitest';
import {
  type ArchDoc,
  addInterface,
  addNode,
  addPort,
  addTypedEdge,
  type InterfaceDef,
  removeInterface,
  removePort,
  renamePort,
  restoreArchitecture,
  seedArchitecture,
  serializeArchitecture,
  setPortType,
  updateInterfaceFields,
} from '../../src/architecture';

/** A tiny two-node doc in one graph. */
function twoNodeDoc(): { doc: ArchDoc; g: string; a: string; b: string } {
  let doc = seedArchitecture('T');
  // start from an empty root graph for determinism
  const g = doc.rootGraph;
  doc = { ...doc, graphs: { [g]: { id: g, title: 'root', nodes: [], edges: [] } } };
  const ra = addNode(doc, g, { title: 'A', x: 0, y: 0 });
  doc = ra.doc;
  const rb = addNode(doc, g, { title: 'B', x: 200, y: 0 });
  doc = rb.doc;
  return { doc, g, a: ra.id, b: rb.id };
}

describe('port reducers', () => {
  it('adds an output port with a generated id and default name', () => {
    const { doc, g, a } = twoNodeDoc();
    const { doc: d2, portId } = addPort(doc, g, a, 'out');
    const node = d2.graphs[g].nodes.find((n) => n.id === a);
    expect(node?.outputs?.length).toBe(1);
    expect(node?.outputs?.[0].id).toBe(portId);
    expect(node?.outputs?.[0].name).toMatch(/^out\d+$/);
    expect(node?.inputs ?? []).toEqual([]);
  });

  it('renames a port and rejects an empty name', () => {
    const { doc, g, a } = twoNodeDoc();
    const { doc: d2, portId } = addPort(doc, g, a, 'in');
    const named = renamePort(d2, g, a, portId, '  userId  ');
    expect(named.graphs[g].nodes.find((n) => n.id === a)?.inputs?.[0].name).toBe('userId');
    const blank = renamePort(named, g, a, portId, '   ');
    expect(blank.graphs[g].nodes.find((n) => n.id === a)?.inputs?.[0].name).toBe('userId');
  });

  it('sets and clears a port type', () => {
    const { doc, g, a } = twoNodeDoc();
    const { doc: d2, portId } = addPort(doc, g, a, 'out');
    const typed = setPortType(d2, g, a, portId, { kind: 'primitive', name: 'string' });
    expect(typed.graphs[g].nodes.find((n) => n.id === a)?.outputs?.[0].type).toEqual({
      kind: 'primitive',
      name: 'string',
    });
    const cleared = setPortType(typed, g, a, portId, undefined);
    expect(cleared.graphs[g].nodes.find((n) => n.id === a)?.outputs?.[0].type).toBeUndefined();
  });

  it('removes a port and its incident typed edges', () => {
    const { doc, g, a, b } = twoNodeDoc();
    const ra = addPort(doc, g, a, 'out');
    const rb = addPort(ra.doc, g, b, 'in');
    const wired = addTypedEdge(rb.doc, g, a, ra.portId, b, rb.portId);
    expect(wired.graphs[g].edges.length).toBe(1);
    const removed = removePort(wired, g, a, ra.portId);
    expect(removed.graphs[g].nodes.find((n) => n.id === a)?.outputs ?? []).toEqual([]);
    expect(removed.graphs[g].edges.length).toBe(0);
  });
});

describe('typed edges', () => {
  it('wires an output port to an input port', () => {
    const { doc, g, a, b } = twoNodeDoc();
    const ra = addPort(doc, g, a, 'out');
    const rb = addPort(ra.doc, g, b, 'in');
    const wired = addTypedEdge(rb.doc, g, a, ra.portId, b, rb.portId);
    const e = wired.graphs[g].edges[0];
    expect(e.source).toBe(a);
    expect(e.sourcePort).toBe(ra.portId);
    expect(e.target).toBe(b);
    expect(e.targetPort).toBe(rb.portId);
  });

  it('allows fan-in (two edges into one input)', () => {
    const { doc, g, a, b } = twoNodeDoc();
    const ra1 = addPort(doc, g, a, 'out');
    const ra2 = addPort(ra1.doc, g, a, 'out');
    const rb = addPort(ra2.doc, g, b, 'in');
    let d = addTypedEdge(rb.doc, g, a, ra1.portId, b, rb.portId);
    d = addTypedEdge(d, g, a, ra2.portId, b, rb.portId);
    expect(d.graphs[g].edges.length).toBe(2);
  });
});

describe('interface registry', () => {
  function withUser(): { doc: ArchDoc; g: string; a: string; ifaceId: string; portId: string } {
    const { doc, g, a } = twoNodeDoc();
    const { doc: d2, id: ifaceId } = addInterface(doc, { name: 'User' });
    const d3 = updateInterfaceFields(d2, ifaceId, [
      { name: 'name', type: { kind: 'primitive', name: 'string' } },
      { name: 'birthYear', type: { kind: 'primitive', name: 'number' } },
    ]);
    const rp = addPort(d3, g, a, 'out');
    const typed = setPortType(rp.doc, g, a, rp.portId, { kind: 'ref', interfaceId: ifaceId });
    return { doc: typed, g, a, ifaceId, portId: rp.portId };
  }

  it('creates an interface with fields', () => {
    const { doc, ifaceId } = withUser();
    const iface = doc.interfaces?.[ifaceId] as InterfaceDef;
    expect(iface.name).toBe('User');
    expect(iface.fields.map((f) => f.name)).toEqual(['name', 'birthYear']);
  });

  it('deleting a referenced interface clears a port ref to untyped', () => {
    const { doc, g, a, ifaceId, portId } = withUser();
    const removed = removeInterface(doc, ifaceId);
    expect(removed.interfaces?.[ifaceId]).toBeUndefined();
    const port = removed.graphs[g].nodes
      .find((n) => n.id === a)
      ?.outputs?.find((p) => p.id === portId);
    expect(port?.type).toBeUndefined();
  });

  it('deleting an interface referenced by another interface field clears that field to any', () => {
    const { doc, ifaceId } = withUser();
    // A second interface whose field references User.
    const { doc: d2, id: profileId } = addInterface(doc, { name: 'Profile' });
    const d3 = updateInterfaceFields(d2, profileId, [
      { name: 'owner', type: { kind: 'ref', interfaceId: ifaceId } },
    ]);
    const removed = removeInterface(d3, ifaceId);
    const field = removed.interfaces?.[profileId]?.fields[0];
    expect(field?.type).toEqual({ kind: 'primitive', name: 'any' });
  });
});

describe('migration & round-trip', () => {
  it('round-trips ports, typed edges, and interfaces through serialize/restore', () => {
    const { doc, g, a } = twoNodeDoc();
    const { doc: di, id: ifaceId } = addInterface(doc, { name: 'User' });
    const rp = addPort(di, g, a, 'out');
    const typed = setPortType(rp.doc, g, a, rp.portId, { kind: 'ref', interfaceId: ifaceId });
    const restored = restoreArchitecture(serializeArchitecture(typed));
    expect(restored).not.toBeNull();
    const port = restored?.graphs[g].nodes.find((n) => n.id === a)?.outputs?.[0];
    expect(port?.type).toEqual({ kind: 'ref', interfaceId: ifaceId });
    expect(restored?.interfaces?.[ifaceId]?.name).toBe('User');
  });

  it('drops an edge naming a missing port but keeps a legacy port-less edge', () => {
    const { doc, g, a, b } = twoNodeDoc();
    const withLegacy: ArchDoc = {
      ...doc,
      graphs: {
        [g]: {
          ...doc.graphs[g],
          edges: [
            { id: 'legacy', source: a, target: b },
            { id: 'bad', source: a, target: b, sourcePort: 'nope', targetPort: 'nope' },
          ],
        },
      },
    };
    const restored = restoreArchitecture(serializeArchitecture(withLegacy));
    const ids = restored?.graphs[g].edges.map((e) => e.id);
    expect(ids).toContain('legacy');
    expect(ids).not.toContain('bad');
  });

  it('clears a dangling port ref to a missing interface on load', () => {
    const { doc, g, a } = twoNodeDoc();
    const rp = addPort(doc, g, a, 'out');
    const typed = setPortType(rp.doc, g, a, rp.portId, { kind: 'ref', interfaceId: 'ghost' });
    const restored = restoreArchitecture(serializeArchitecture(typed));
    const port = restored?.graphs[g].nodes.find((n) => n.id === a)?.outputs?.[0];
    expect(port?.type).toBeUndefined();
  });
});
