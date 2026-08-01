import { describe, expect, it } from 'vitest';
import { restoreArchitecture } from '../../src/architecture';
import { diffArchitecture } from '../../src/conduit-proposal';
import { ARCH_FIXTURE_DOC, ARCH_FIXTURE_PROPOSAL } from '../e2e/visual/fixture-repo.mjs';

// The fixture's architecture.json was written against an invented schema (`ports[]`, a
// `{ kind: 'iface' }` type, no `rootGraph`), so restoreArchitecture returned null and the canvas
// quietly fell back to its four-node built-in seed — every canvas screenshot in the run showed the
// seed, not the fixture. A silent fallback is the failure mode, so the fixture is validated here.
describe('visual fixture architecture', () => {
  it('survives the real loader with nothing dropped', () => {
    const restored = restoreArchitecture(JSON.stringify(ARCH_FIXTURE_DOC));
    expect(restored).not.toBeNull();
    const g = restored?.graphs.root;
    expect(g?.nodes).toHaveLength(ARCH_FIXTURE_DOC.graphs.root.nodes.length);
    expect(g?.edges).toHaveLength(ARCH_FIXTURE_DOC.graphs.root.edges.length);
    // A ref to a missing interface is CLEARED rather than rejected, so the port keeps its name
    // and the doc still loads — preserved types are what prove the registry actually resolves.
    expect(Object.keys(restored?.interfaces ?? {})).toHaveLength(5);
    for (const n of g?.nodes ?? [])
      for (const p of [...(n.inputs ?? []), ...(n.outputs ?? [])]) expect(p.type).toBeDefined();
  });

  it('wires every edge to a port that exists', () => {
    const g = ARCH_FIXTURE_DOC.graphs.root;
    const outs = new Map(g.nodes.map((n) => [n.id, new Set((n.outputs ?? []).map((p) => p.id))]));
    const ins = new Map(g.nodes.map((n) => [n.id, new Set((n.inputs ?? []).map((p) => p.id))]));
    for (const e of g.edges) {
      expect(outs.get(e.source)?.has(e.sourcePort ?? '')).toBe(true);
      expect(ins.get(e.target)?.has(e.targetPort ?? '')).toBe(true);
    }
  });

  it('proposes exactly one added node, which is what the canvas review flags', () => {
    const proposal = restoreArchitecture(JSON.stringify(ARCH_FIXTURE_PROPOSAL));
    expect(proposal).not.toBeNull();
    const diff = diffArchitecture(ARCH_FIXTURE_DOC, proposal ?? ARCH_FIXTURE_DOC);
    expect(diff.addedNodes.map((n) => n.title)).toEqual(['Plan View']);
    expect(diff.editedNodes).toHaveLength(0);
  });
});
