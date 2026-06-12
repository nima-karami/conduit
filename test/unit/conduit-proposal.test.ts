import { describe, expect, it } from 'vitest';
import type { ArchDoc } from '../../src/architecture';
import type { BoardData } from '../../src/board';
import {
  diffArchitecture,
  diffBoard,
  summarizeArchDiff,
  summarizeBoardDiff,
} from '../../src/conduit-proposal';

const board = (cards: BoardData['cards']): BoardData => ({ version: 1, cards });

describe('diffBoard', () => {
  it('detects an added card', () => {
    const before = board([{ id: 'a', title: 'A', notes: '', stage: 'wishlist' }]);
    const after = board([
      { id: 'a', title: 'A', notes: '', stage: 'wishlist' },
      { id: 'b', title: 'B', notes: '', stage: 'planning' },
    ]);
    const d = diffBoard(before, after);
    expect(d.added.map((c) => c.id)).toEqual(['b']);
    expect(d.removed).toEqual([]);
    expect(d.moved).toEqual([]);
    expect(d.edited).toEqual([]);
  });

  it('detects a removed card', () => {
    const before = board([
      { id: 'a', title: 'A', notes: '', stage: 'wishlist' },
      { id: 'b', title: 'B', notes: '', stage: 'planning' },
    ]);
    const after = board([{ id: 'a', title: 'A', notes: '', stage: 'wishlist' }]);
    const d = diffBoard(before, after);
    expect(d.removed.map((c) => c.id)).toEqual(['b']);
    expect(d.added).toEqual([]);
  });

  it('detects a moved card (stage change only) separately from an edit', () => {
    const before = board([{ id: 'a', title: 'A', notes: 'n', stage: 'wishlist' }]);
    const after = board([{ id: 'a', title: 'A', notes: 'n', stage: 'building' }]);
    const d = diffBoard(before, after);
    expect(d.moved).toHaveLength(1);
    expect(d.moved[0]).toMatchObject({ id: 'a', from: 'wishlist', to: 'building' });
    expect(d.edited).toEqual([]);
  });

  it('detects an edited card (title/notes change, same stage)', () => {
    const before = board([{ id: 'a', title: 'A', notes: 'old', stage: 'wishlist' }]);
    const after = board([{ id: 'a', title: 'A2', notes: 'new', stage: 'wishlist' }]);
    const d = diffBoard(before, after);
    expect(d.edited).toHaveLength(1);
    expect(d.edited[0].id).toBe('a');
    expect(d.edited[0].fields.sort()).toEqual(['notes', 'title']);
    expect(d.moved).toEqual([]);
  });

  it('reports a card that both moved AND was edited in both buckets', () => {
    const before = board([{ id: 'a', title: 'A', notes: 'old', stage: 'wishlist' }]);
    const after = board([{ id: 'a', title: 'A', notes: 'new', stage: 'done' }]);
    const d = diffBoard(before, after);
    expect(d.moved.map((m) => m.id)).toEqual(['a']);
    expect(d.edited.map((e) => e.id)).toEqual(['a']);
  });

  it('is empty when nothing changed', () => {
    const same = board([{ id: 'a', title: 'A', notes: '', stage: 'wishlist' }]);
    const d = diffBoard(same, same);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.moved).toEqual([]);
    expect(d.edited).toEqual([]);
    expect(d.hasChanges).toBe(false);
  });

  it('hasChanges is true when anything differs', () => {
    const before = board([{ id: 'a', title: 'A', notes: '', stage: 'wishlist' }]);
    const after = board([{ id: 'a', title: 'A', notes: '', stage: 'planning' }]);
    expect(diffBoard(before, after).hasChanges).toBe(true);
  });

  it('summarizes a board diff in human terms', () => {
    const before = board([
      { id: 'a', title: 'A', notes: '', stage: 'wishlist' },
      { id: 'b', title: 'B', notes: '', stage: 'wishlist' },
    ]);
    const after = board([
      { id: 'a', title: 'A', notes: '', stage: 'building' },
      { id: 'c', title: 'C', notes: '', stage: 'wishlist' },
    ]);
    const text = summarizeBoardDiff(diffBoard(before, after));
    expect(text).toContain('1 added');
    expect(text).toContain('1 removed');
    expect(text).toContain('1 moved');
  });
});

const arch = (over: Partial<ArchDoc> = {}): ArchDoc => ({
  version: 1,
  rootGraph: 'g',
  graphs: {
    g: {
      id: 'g',
      title: 'G',
      nodes: [{ id: 'n1', title: 'N1', kind: 'service', x: 0, y: 0 }],
      edges: [],
    },
  },
  ...over,
});

describe('diffArchitecture', () => {
  it('detects an added node', () => {
    const before = arch();
    const after = arch({
      graphs: {
        g: {
          id: 'g',
          title: 'G',
          nodes: [
            { id: 'n1', title: 'N1', kind: 'service', x: 0, y: 0 },
            { id: 'n2', title: 'N2', kind: 'database', x: 10, y: 10 },
          ],
          edges: [],
        },
      },
    });
    const d = diffArchitecture(before, after);
    expect(d.addedNodes.map((n) => n.id)).toEqual(['n2']);
    expect(d.removedNodes).toEqual([]);
  });

  it('detects a removed node', () => {
    const before = arch({
      graphs: {
        g: {
          id: 'g',
          title: 'G',
          nodes: [
            { id: 'n1', title: 'N1', kind: 'service', x: 0, y: 0 },
            { id: 'n2', title: 'N2', kind: 'database', x: 10, y: 10 },
          ],
          edges: [],
        },
      },
    });
    const after = arch();
    const d = diffArchitecture(before, after);
    expect(d.removedNodes.map((n) => n.id)).toEqual(['n2']);
  });

  it('detects an edited node (title/kind/position/prose)', () => {
    const before = arch();
    const after = arch({
      graphs: {
        g: {
          id: 'g',
          title: 'G',
          nodes: [{ id: 'n1', title: 'N1 renamed', kind: 'frontend', x: 0, y: 0 }],
          edges: [],
        },
      },
    });
    const d = diffArchitecture(before, after);
    expect(d.editedNodes).toHaveLength(1);
    expect(d.editedNodes[0].id).toBe('n1');
    expect(d.editedNodes[0].fields).toContain('title');
    expect(d.editedNodes[0].fields).toContain('kind');
  });

  it('detects added/removed/edited edges across all graphs', () => {
    const before = arch({
      graphs: {
        g: {
          id: 'g',
          title: 'G',
          nodes: [
            { id: 'n1', title: 'N1', kind: 'service', x: 0, y: 0 },
            { id: 'n2', title: 'N2', kind: 'service', x: 1, y: 1 },
          ],
          edges: [{ id: 'e1', source: 'n1', target: 'n2', label: 'old' }],
        },
      },
    });
    const after = arch({
      graphs: {
        g: {
          id: 'g',
          title: 'G',
          nodes: [
            { id: 'n1', title: 'N1', kind: 'service', x: 0, y: 0 },
            { id: 'n2', title: 'N2', kind: 'service', x: 1, y: 1 },
          ],
          edges: [
            { id: 'e1', source: 'n1', target: 'n2', label: 'new' },
            { id: 'e2', source: 'n2', target: 'n1' },
          ],
        },
      },
    });
    const d = diffArchitecture(before, after);
    expect(d.addedEdges.map((e) => e.id)).toEqual(['e2']);
    expect(d.editedEdges.map((e) => e.id)).toEqual(['e1']);
    expect(d.removedEdges).toEqual([]);
  });

  it('hasChanges false on an identical doc', () => {
    expect(diffArchitecture(arch(), arch()).hasChanges).toBe(false);
  });

  it('summarizes an architecture diff', () => {
    const before = arch();
    const after = arch({
      graphs: {
        g: {
          id: 'g',
          title: 'G',
          nodes: [
            { id: 'n1', title: 'N1', kind: 'service', x: 0, y: 0 },
            { id: 'n2', title: 'N2', kind: 'database', x: 10, y: 10 },
          ],
          edges: [],
        },
      },
    });
    const text = summarizeArchDiff(diffArchitecture(before, after));
    expect(text).toContain('1 node added');
  });
});
