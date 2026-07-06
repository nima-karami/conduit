import { describe, expect, it } from 'vitest';
import {
  type ArchDoc,
  addInterface,
  addInterfaceField,
  addNode,
  addPort,
  interfaceUsage,
  moveInterfaceField,
  removeInterface,
  removeInterfaceField,
  renameInterface,
  seedArchitecture,
  setPortType,
  type TypeRef,
  updateInterfaceField,
} from '../../src/architecture';

function emptyDoc(): { doc: ArchDoc; g: string } {
  const seeded = seedArchitecture('T');
  const g = seeded.rootGraph;
  return { doc: { ...seeded, graphs: { [g]: { id: g, title: 'root', nodes: [], edges: [] } } }, g };
}

const ref = (id: string): TypeRef => ({ kind: 'ref', interfaceId: id });

describe('interface authoring reducers', () => {
  it('renames an interface but reverts on a blank name', () => {
    const { id, doc } = addInterface(emptyDoc().doc, { name: 'User' });
    expect(renameInterface(doc, id, 'Account').interfaces?.[id].name).toBe('Account');
    expect(renameInterface(doc, id, '   ').interfaces?.[id].name).toBe('User');
    expect(renameInterface(doc, 'nope', 'X')).toBe(doc);
  });

  it('adds a field with defaults (name field{n}, type string)', () => {
    const { id, doc } = addInterface(emptyDoc().doc, { name: 'User' });
    const d2 = addInterfaceField(doc, id);
    const f = d2.interfaces?.[id].fields[0];
    expect(f?.name).toBe('field1');
    expect(f?.type).toEqual({ kind: 'primitive', name: 'string' });
    const d3 = addInterfaceField(d2, id, {
      name: 'age',
      type: { kind: 'primitive', name: 'number' },
    });
    expect(d3.interfaces?.[id].fields.map((x) => x.name)).toEqual(['field1', 'age']);
  });

  it('patches a field, reverts a blank name, and normalizes optional/description away', () => {
    let { id, doc } = addInterface(emptyDoc().doc, { name: 'User' });
    doc = addInterfaceField(doc, id, { name: 'name' });
    const renamed = updateInterfaceField(doc, id, 0, { name: 'fullName' });
    expect(renamed.interfaces?.[id].fields[0].name).toBe('fullName');
    // blank name reverts (no throw, keeps prior)
    expect(updateInterfaceField(doc, id, 0, { name: '  ' }).interfaces?.[id].fields[0].name).toBe(
      'name',
    );
    const opt = updateInterfaceField(doc, id, 0, { optional: true });
    expect(opt.interfaces?.[id].fields[0].optional).toBe(true);
    expect(
      updateInterfaceField(opt, id, 0, { optional: false }).interfaces?.[id].fields[0].optional,
    ).toBeUndefined();
    expect(updateInterfaceField(doc, id, 5, { name: 'x' })).toBe(doc); // out of range
  });

  it('removes and reorders fields (move is a pure array move; no-op out of range)', () => {
    let { id, doc } = addInterface(emptyDoc().doc, { name: 'User' });
    doc = addInterfaceField(doc, id, { name: 'a' });
    doc = addInterfaceField(doc, id, { name: 'b' });
    doc = addInterfaceField(doc, id, { name: 'c' });
    expect(moveInterfaceField(doc, id, 0, 2).interfaces?.[id].fields.map((f) => f.name)).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(moveInterfaceField(doc, id, 1, 1)).toBe(doc); // no-op
    expect(moveInterfaceField(doc, id, 0, 9)).toBe(doc); // out of range
    expect(removeInterfaceField(doc, id, 1).interfaces?.[id].fields.map((f) => f.name)).toEqual([
      'a',
      'c',
    ]);
  });

  it('counts interface usage across ports and fields, looking through lists', () => {
    const base = emptyDoc();
    let doc = base.doc;
    const g = base.g;
    const rUser = addInterface(doc, { name: 'User' });
    doc = rUser.doc;
    const uid = rUser.id;
    // A field on another interface that refs User via a list.
    const rTeam = addInterface(doc, { name: 'Team' });
    doc = rTeam.doc;
    doc = addInterfaceField(doc, rTeam.id, {
      name: 'members',
      type: { kind: 'list', of: ref(uid) },
    });
    // A port typed User.
    const rn = addNode(doc, g, { title: 'N' });
    doc = rn.doc;
    const rp = addPort(doc, g, rn.id, 'out');
    doc = rp.doc;
    doc = setPortType(doc, g, rn.id, rp.portId, ref(uid));
    const usage = interfaceUsage(doc);
    expect(usage[uid]).toBe(2); // one field (through the list) + one port
    expect(usage[rTeam.id]).toBe(0);
  });

  it('deleting a referenced interface clears refs (port→untyped, field→any) via removeInterface', () => {
    const base = emptyDoc();
    let doc = base.doc;
    const g = base.g;
    const rUser = addInterface(doc, { name: 'User' });
    doc = rUser.doc;
    const rn = addNode(doc, g, { title: 'N' });
    doc = rn.doc;
    const rp = addPort(doc, g, rn.id, 'out');
    doc = rp.doc;
    doc = setPortType(doc, g, rn.id, rp.portId, ref(rUser.id));
    const rTeam = addInterface(doc, { name: 'Team' });
    doc = rTeam.doc;
    doc = addInterfaceField(doc, rTeam.id, { name: 'lead', type: ref(rUser.id) });
    const after = removeInterface(doc, rUser.id);
    expect(after.interfaces?.[rUser.id]).toBeUndefined();
    expect(after.graphs[g].nodes[0].outputs?.[0].type).toBeUndefined(); // port → untyped
    expect(after.interfaces?.[rTeam.id].fields[0].type).toEqual({ kind: 'primitive', name: 'any' });
  });
});
