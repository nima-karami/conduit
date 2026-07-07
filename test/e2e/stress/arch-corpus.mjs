/**
 * Deterministic large-ArchDoc generator for the arch-canvas-scale stress scenario.
 *
 * Plain ESM (not TS) so both the .mjs stress harness and the vitest unit test import the
 * SAME implementation — the unit test round-trips its output through the real
 * `restoreArchitecture` to prove nothing is dropped (test/unit/arch-corpus.test.ts).
 *
 * All nodes are left at x=0/y=0 on purpose: the canvas auto-layouts an unpositioned graph
 * on load (issue #3), so a run also exercises computeLayout at scale. Each node carries
 * typed in/out ports and edges are typed port→port, exercising the per-node port-label
 * resolution that re-runs on every doc rebuild.
 */

const KINDS = ['service', 'gateway', 'frontend', 'database', 'worker', 'library'];
const IFACE_COUNT = 8;

/**
 * @param {{ nodeCount?: number, edgeCount?: number }} [opts]
 * @returns {object} a valid ArchDoc (envelope-free — the harness wraps it)
 */
export function makeArchCorpus({ nodeCount = 500, edgeCount = 2000 } = {}) {
  // Seeded LCG for reproducible edge wiring across runs and in the unit test.
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const interfaces = {};
  for (let k = 0; k < IFACE_COUNT; k++) {
    interfaces[`i-${k}`] = {
      id: `i-${k}`,
      name: `Iface${k}`,
      fields: [
        { name: 'id', type: { kind: 'primitive', name: 'string' } },
        { name: 'value', type: { kind: 'primitive', name: 'number' }, optional: true },
      ],
    };
  }

  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    const ref = { kind: 'ref', interfaceId: `i-${i % IFACE_COUNT}` };
    nodes.push({
      id: `n${i}`,
      title: `Node ${i}`,
      subtitle: `component #${i}`,
      kind: KINDS[i % KINDS.length],
      x: 0,
      y: 0,
      inputs: [
        { id: `n${i}-in0`, name: 'in', type: ref },
        { id: `n${i}-in1`, name: 'aux', type: { kind: 'primitive', name: 'string' } },
      ],
      outputs: [
        { id: `n${i}-out0`, name: 'out', type: ref },
        { id: `n${i}-out1`, name: 'err', type: { kind: 'primitive', name: 'string' } },
      ],
    });
  }

  const edges = [];
  const seen = new Set();
  const maxAttempts = edgeCount * 20;
  for (let a = 0; edges.length < edgeCount && a < maxAttempts; a++) {
    const s = Math.floor(rand() * nodeCount);
    const t = Math.floor(rand() * nodeCount);
    if (s === t) continue;
    const key = `${s}->${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sp = rand() < 0.5 ? 'out0' : 'out1';
    const tp = rand() < 0.5 ? 'in0' : 'in1';
    edges.push({
      id: `e${edges.length}`,
      source: `n${s}`,
      sourcePort: `n${s}-${sp}`,
      target: `n${t}`,
      targetPort: `n${t}-${tp}`,
    });
  }

  return {
    version: 1,
    rootGraph: 'graph-root',
    graphs: { 'graph-root': { id: 'graph-root', title: 'Stress corpus', nodes, edges } },
    interfaces,
  };
}
