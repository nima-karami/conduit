/**
 * Architecture canvas at scale — load a 500-node / 2000-edge corpus through the REAL host path
 * (seed .conduit/architecture.json → requestArchitecture on canvas open), then drag a node.
 *
 * The canvas has no node virtualization and rebuilds the whole doc on every drag frame, so this
 * is the softest spot: it records the load+layout jank and the per-drag-frame cadence at scale.
 *
 * Invariants (fail the lane): the corpus loads with nothing dropped (500 nodes / 2000 edges), and
 * the edges SURVIVE a node move (the v0.24.0 edge-drop regression guard). Advisory: load frames
 * and drag frames.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertInvariant,
  emitReport,
  openArchCanvas,
  openSession,
  runStress,
  seedArchCorpus,
  startPerf,
  stopPerf,
} from './harness-stress.mjs';

const NODES = 500;
const EDGES = 2000;

runStress('arch-canvas-scale', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-arch-scale-'));
  seedArchCorpus(root, { nodeCount: NODES, edgeCount: EDGES });
  await openSession(page, { path: root });

  // Measure the open → layout → mount window: start sampling, open the canvas, wait for the full
  // corpus to land in the live doc.
  await startPerf(page, 'arch-canvas-load');
  const opened = await openArchCanvas(page);
  assertInvariant(opened, 'architecture canvas should open');
  await page.waitForFunction(
    (n) => {
      const g = window.__archDoc?.graphs?.[window.__archGraphId];
      return g && g.nodes.length >= n;
    },
    NODES,
    { timeout: 30000 },
  );
  const loadReport = await stopPerf(page);

  const counts = await page.evaluate(() => {
    const g = window.__archDoc.graphs[window.__archGraphId];
    return { nodes: g.nodes.length, edges: g.edges.length };
  });
  log(`loaded nodes=${counts.nodes} edges=${counts.edges}`);
  // INVARIANT: nothing dropped on load.
  assertInvariant(counts.nodes === NODES, `expected ${NODES} nodes, got ${counts.nodes}`);
  assertInvariant(counts.edges === EDGES, `expected ${EDGES} edges, got ${counts.edges}`);

  // Drag one node across ~30 frames and measure the per-frame cadence (the O(N) rebuild cost).
  const box = await page.evaluate(() => {
    const el = document.querySelector('.react-flow__node');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 12 }; // grab near the top (card header) to drag
  });
  assertInvariant(!!box, 'at least one node should be mounted to drag');

  await startPerf(page, 'arch-canvas-drag');
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(box.x + i * 6, box.y + i * 3);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  const dragReport = await stopPerf(page);

  // INVARIANT: the edges survived the move (regression guard for the RF measured-size fix).
  const edgesAfter = await page.evaluate(
    () => window.__archDoc.graphs[window.__archGraphId].edges.length,
  );
  assertInvariant(edgesAfter === EDGES, `edges vanished on move: ${edgesAfter} != ${EDGES}`);
  const domEdges = await page.evaluate(() => document.querySelectorAll('.react-flow__edge').length);
  log(`after drag: model edges=${edgesAfter} dom edges=${domEdges}`);

  emitReport('arch-canvas-load', loadReport, { nodes: counts.nodes, edges: counts.edges });
  emitReport('arch-canvas-drag', dragReport, { domEdges });
});
