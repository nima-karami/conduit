import { describe, expect, it } from 'vitest';
import { restoreArchitecture } from '../../src/architecture';
// The stress harness and this test share ONE corpus generator (plain .mjs).
import { makeArchCorpus } from '../e2e/stress/arch-corpus.mjs';

describe('makeArchCorpus', () => {
  it('produces exactly the requested node/edge counts', () => {
    const doc = makeArchCorpus({ nodeCount: 500, edgeCount: 2000 });
    const g = doc.graphs['graph-root'];
    expect(g.nodes).toHaveLength(500);
    expect(g.edges).toHaveLength(2000);
  });

  it('round-trips through restoreArchitecture with NOTHING dropped', () => {
    const doc = makeArchCorpus({ nodeCount: 500, edgeCount: 2000 });
    const restored = restoreArchitecture(JSON.stringify(doc));
    expect(restored).not.toBeNull();
    const g = restored?.graphs['graph-root'];
    // If any node, edge, or port were malformed the validator would silently drop it —
    // preserved counts prove the corpus is well-formed and load-bearing for the scenario.
    expect(g?.nodes).toHaveLength(500);
    expect(g?.edges).toHaveLength(2000);
    expect(Object.keys(restored?.interfaces ?? {})).toHaveLength(8);
  });

  it('keeps every edge endpoint + port pointing at a real node port', () => {
    const doc = makeArchCorpus({ nodeCount: 60, edgeCount: 200 });
    const g = doc.graphs['graph-root'];
    const ids = new Set(g.nodes.map((n) => n.id));
    const outPorts = new Map(
      g.nodes.map((n) => [n.id, new Set((n.outputs ?? []).map((p) => p.id))]),
    );
    const inPorts = new Map(g.nodes.map((n) => [n.id, new Set((n.inputs ?? []).map((p) => p.id))]));
    for (const e of g.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
      expect(e.source).not.toBe(e.target); // no self-loops
      expect(!!e.sourcePort && outPorts.get(e.source)?.has(e.sourcePort)).toBe(true);
      expect(!!e.targetPort && inPorts.get(e.target)?.has(e.targetPort)).toBe(true);
    }
  });

  it('is deterministic (same seed → identical doc)', () => {
    const a = makeArchCorpus({ nodeCount: 40, edgeCount: 120 });
    const b = makeArchCorpus({ nodeCount: 40, edgeCount: 120 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
