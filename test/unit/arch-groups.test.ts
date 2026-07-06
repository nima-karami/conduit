import { describe, expect, it } from 'vitest';
import {
  type ArchDoc,
  addGroup,
  addNode,
  encapsulateSelection,
  removeGroup,
  removeNode,
  renameGroup,
  restoreArchitecture,
  seedArchitecture,
  serializeArchitecture,
  ungroup,
} from '../../src/architecture';

function docWith(n: number): { doc: ArchDoc; g: string; ids: string[] } {
  let doc = seedArchitecture('T');
  const g = doc.rootGraph;
  doc = { ...doc, graphs: { [g]: { id: g, title: 'root', nodes: [], edges: [] } } };
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = addNode(doc, g, { title: `N${i}`, x: i * 100, y: 0 });
    doc = r.doc;
    ids.push(r.id);
  }
  return { doc, g, ids };
}

describe('named groups', () => {
  it('creates a group with a default label and valid members; ignores unknowns; no-ops empty', () => {
    const { doc, g, ids } = docWith(2);
    const r = addGroup(doc, g, [ids[0], ids[1], 'ghost']);
    expect(r.groupId).toBeTruthy();
    const grp = r.doc.graphs[g].groups?.[0];
    expect(grp?.label).toBe('Group 1');
    expect(grp?.memberIds).toEqual([ids[0], ids[1]]);
    expect(addGroup(doc, g, []).groupId).toBe('');
    expect(addGroup(doc, g, ['ghost']).doc).toBe(doc);
  });

  it('enforces one group per node — joining a new group leaves the old, empties are dropped', () => {
    const { doc, g, ids } = docWith(2);
    const a = addGroup(doc, g, [ids[0], ids[1]]).doc;
    // Put ids[1] into a fresh group → it leaves group 1; group 1 still has ids[0].
    const b = addGroup(a, g, [ids[1]]).doc;
    const groups = b.graphs[g].groups ?? [];
    const g1 = groups.find((gr) => gr.memberIds.includes(ids[0]));
    const g2 = groups.find((gr) => gr.memberIds.includes(ids[1]));
    expect(g1?.memberIds).toEqual([ids[0]]);
    expect(g2?.memberIds).toEqual([ids[1]]);
    expect(g1?.id).not.toBe(g2?.id);
  });

  it('renames (blank reverts), ungroups (keeps nodes), and deletes group+contents', () => {
    const { doc, g, ids } = docWith(2);
    const { doc: withGrp, groupId } = addGroup(doc, g, [ids[0], ids[1]]);
    expect(renameGroup(withGrp, g, groupId, 'Auth').graphs[g].groups?.[0].label).toBe('Auth');
    expect(renameGroup(withGrp, g, groupId, '  ').graphs[g].groups?.[0].label).toBe('Group 1');
    // Ungroup: box gone, both nodes remain.
    const un = ungroup(withGrp, g, groupId);
    expect(un.graphs[g].groups).toBeUndefined();
    expect(un.graphs[g].nodes.map((n) => n.id).sort()).toEqual([...ids].sort());
    // Delete group + contents: nodes gone too.
    const del = removeGroup(withGrp, g, groupId);
    expect(del.graphs[g].groups).toBeUndefined();
    expect(del.graphs[g].nodes.length).toBe(0);
  });

  it('prunes a group when a member is removed, dropping the group once empty', () => {
    const { doc, g, ids } = docWith(2);
    const withGrp = addGroup(doc, g, [ids[0], ids[1]]).doc;
    const one = removeNode(withGrp, g, ids[0]);
    expect(one.graphs[g].groups?.[0].memberIds).toEqual([ids[1]]);
    const none = removeNode(one, g, ids[1]);
    expect(none.graphs[g].groups).toBeUndefined();
  });

  it('prunes encapsulated members from a group', () => {
    const { doc, g, ids } = docWith(3);
    const withGrp = addGroup(doc, g, [ids[0], ids[1], ids[2]]).doc;
    const enc = encapsulateSelection(withGrp, g, [ids[0], ids[1]]).doc;
    // ids[0], ids[1] moved into the component; only ids[2] remains in the group.
    expect(enc.graphs[g].groups?.[0].memberIds).toEqual([ids[2]]);
  });

  it('round-trips through serialize/restore and validation drops dangling/duplicate members', () => {
    const { doc, g, ids } = docWith(2);
    const withGrp = addGroup(doc, g, [ids[0], ids[1]]).doc;
    const restored = restoreArchitecture(serializeArchitecture(withGrp));
    expect(restored?.graphs[g].groups?.[0].memberIds).toEqual([ids[0], ids[1]]);

    // A hand-authored doc with a bad member id + a node claimed by two groups.
    const raw = JSON.parse(serializeArchitecture(withGrp));
    raw.graphs[g].groups = [
      { id: 'x', label: 'X', memberIds: [ids[0], 'ghost'] },
      { id: 'y', label: 'Y', memberIds: [ids[0], ids[1]] },
    ];
    const r2 = restoreArchitecture(JSON.stringify(raw));
    const groups = r2?.graphs[g].groups ?? [];
    expect(groups.find((gr) => gr.id === 'x')?.memberIds).toEqual([ids[0]]); // ghost dropped
    expect(groups.find((gr) => gr.id === 'y')?.memberIds).toEqual([ids[1]]); // ids[0] already claimed
  });
});
