/**
 * arch-node-graph (slice F) — drives the REAL architecture canvas: add a typed port, undo/redo it,
 * rename it, and wire two ports together, observing the live doc via window.__archDoc (a read-only
 * snapshot, like the harness's window.__sessions). Runs HIDDEN. This crosses the view↔model↔undo
 * boundary a unit test can't.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, launchApp, makeLog, openSession } from './harness.mjs';

const log = makeLog('arch-node-graph');

// Use a throwaway project so the canvas seeds clean and never mutates the repo's own
// .conduit/architecture.json (applyDoc persists to the active project).
const tmpProject = mkdtempSync(join(tmpdir(), 'conduit-arch-'));

let launched;
try {
  launched = await launchApp();
  const { app, page } = launched;
  await openSession(page, { path: tmpProject });

  // Open the architecture canvas via the command palette. Retried because on a saturated machine
  // the palette/shortcut occasionally doesn't register (env flake, not a product bug).
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached', timeout: 20000 });
  let opened = false;
  for (let attempt = 0; attempt < 4 && !opened; attempt++) {
    await page
      .locator('.xterm-helper-textarea')
      .first()
      .focus()
      .catch(() => {});
    await page.keyboard.press('Control+Backquote'); // leave the terminal so the app combo fires
    await page.waitForTimeout(250);
    await page.keyboard.press('Control+Shift+P');
    const palette = await page
      .waitForSelector('.palette', { state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (!palette) continue;
    await page.keyboard.type('architecture');
    await page.keyboard.press('Enter');
    opened = await page
      .waitForSelector('.archnode', { timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    if (!opened) await page.keyboard.press('Escape').catch(() => {});
  }
  assert(opened, 'architecture canvas should open (via the command palette)');
  await page.waitForFunction(() => !!window.__archDoc, null, { timeout: 5000 });
  log('canvas open ✓');

  const gid = await page.evaluate(() => window.__archGraphId);
  const nodeIds = await page.evaluate(
    (g) => window.__archDoc.graphs[g].nodes.map((n) => n.id),
    gid,
  );
  const [a, b] = nodeIds;

  // Inline title edit (slice A): double-click the title, rename, Enter persists to the doc.
  await page.locator(`.react-flow__node[data-id="${a}"] .archnode__title`).dblclick();
  await page.keyboard.type('Renamed Core');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    ([g, id]) => window.__archDoc.graphs[g].nodes.find((n) => n.id === id).title === 'Renamed Core',
    [gid, a],
    { timeout: 5000 },
  );
  log('inline title edit ✓');

  const outCount = () =>
    page.evaluate(
      ([g, id]) => (window.__archDoc.graphs[g].nodes.find((n) => n.id === id).outputs || []).length,
      [gid, a],
    );

  // Add an output port to node A. Select it (click the head, not a widget) so the ZUI reveals
  // its +/- widgets (spec A), then click "+ out".
  await page.locator(`.react-flow__node[data-id="${a}"] .archnode__head`).click();
  const addOut = page.locator(
    `.react-flow__node[data-id="${a}"] .archnode__col--out .archport__add`,
  );
  await addOut.waitFor({ state: 'visible', timeout: 5000 });
  await addOut.click();
  await page.waitForFunction(
    ([g, id]) =>
      (window.__archDoc.graphs[g].nodes.find((n) => n.id === id).outputs || []).length === 1,
    [gid, a],
    { timeout: 5000 },
  );
  log('add output port ✓');

  // Undo removes it; redo restores it.
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    ([g, id]) =>
      (window.__archDoc.graphs[g].nodes.find((n) => n.id === id).outputs || []).length === 0,
    [gid, a],
    { timeout: 5000 },
  );
  log('undo ✓');
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(
    ([g, id]) =>
      (window.__archDoc.graphs[g].nodes.find((n) => n.id === id).outputs || []).length === 1,
    [gid, a],
    { timeout: 5000 },
  );
  log('redo ✓');
  assert((await outCount()) === 1, 'node A should have one output after redo');

  // Rename the port in place.
  await page
    .locator(`.react-flow__node[data-id="${a}"] .archnode__col--out .archport__name`)
    .first()
    .dblclick();
  await page.keyboard.type('result');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    ([g, id]) =>
      window.__archDoc.graphs[g].nodes.find((n) => n.id === id).outputs[0].name === 'result',
    [gid, a],
    { timeout: 5000 },
  );
  log('rename port ✓');

  // Icon picker (slice A): re-select the node (undo/redo can clear selection), then pick an icon.
  await page.locator(`.react-flow__node[data-id="${a}"] .archnode__head`).click();
  await page.locator('.arch__iconpicker .arch__iconopt[aria-label="Database"]').click();
  await page.waitForFunction(
    ([g, id]) => window.__archDoc.graphs[g].nodes.find((n) => n.id === id).icon === 'database',
    [gid, a],
    { timeout: 5000 },
  );
  log('icon picker ✓');

  // Add an input to node B (select via its head to reveal widgets), then drag-wire A.out → B.in.
  await page.locator(`.react-flow__node[data-id="${b}"] .archnode__head`).click();
  const addIn = page.locator(`.react-flow__node[data-id="${b}"] .archnode__col--in .archport__add`);
  await addIn.waitFor({ state: 'visible', timeout: 5000 });
  await addIn.click();
  await page.waitForFunction(
    ([g, id]) =>
      (window.__archDoc.graphs[g].nodes.find((n) => n.id === id).inputs || []).length === 1,
    [gid, b],
    { timeout: 5000 },
  );
  const src = await page
    .locator(`.react-flow__node[data-id="${a}"] .archnode__col--out .react-flow__handle`)
    .first()
    .boundingBox();
  const tgt = await page
    .locator(`.react-flow__node[data-id="${b}"] .archnode__col--in .react-flow__handle`)
    .first()
    .boundingBox();
  assert(!!src && !!tgt, 'both port handles should be present');
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(tgt.x + tgt.width / 2, tgt.y + tgt.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(
    (g) => window.__archDoc.graphs[g].edges.some((e) => e.sourcePort && e.targetPort),
    gid,
    { timeout: 5000 },
  );
  log('wire A.out → B.in ✓');

  // Navigation (slice B): drill into A → breadcrumb grows + a read-only boundary node surfaces A's
  // declared output; Escape steps UP to the parent (does not close the canvas).
  await page.locator(`.react-flow__node[data-id="${a}"] .archnode__drill`).click();
  await page.waitForFunction((g) => window.__archGraphId !== g, gid, { timeout: 5000 });
  await page.waitForSelector('.archboundary--out', { timeout: 5000 });
  const boundaryText = await page.locator('.archboundary--out').innerText();
  assert(/result/.test(boundaryText), 'boundary:out should surface the parent output "result"');
  assert((await page.locator('.arch__crumb').count()) === 2, 'breadcrumb should show two levels');
  log('drill + boundary interface ✓');

  await page.keyboard.press('Escape');
  await page.waitForFunction((g) => window.__archGraphId === g, gid, { timeout: 5000 });
  assert(
    (await page.locator('.archnode').count()) > 0,
    'Escape should step up to the parent (canvas still open), not close it',
  );
  log('Escape steps up ✓');

  // Composition (slice D): encapsulate a selection into a nested component. (Multi-node inference
  // is unit-tested in arch-encapsulate.test.ts; here we prove the button → reducer wiring: after
  // encapsulating A, A is no longer at root but lives inside a new component's child graph.)
  await page.locator(`.react-flow__node[data-id="${a}"] .archnode__head`).click();
  await page.locator('.arch__group').click();
  await page.waitForFunction(
    ([g, aid]) => {
      const doc = window.__archDoc;
      const root = doc.graphs[g];
      if (root.nodes.some((n) => n.id === aid)) return false; // A must have left the root graph
      return root.nodes.some(
        (n) => n.childGraph && doc.graphs[n.childGraph]?.nodes.some((x) => x.id === aid),
      );
    },
    [gid, a],
    { timeout: 5000 },
  );
  log('encapsulate ✓');

  log('all assertions passed ✓');
  await closeApp(app, page);
} catch (err) {
  console.error('[arch-node-graph] FAIL', err);
  if (launched) {
    await launched.page.screenshot({ path: join(tmpdir(), 'arch-fail.png') }).catch(() => {});
    await closeApp(launched.app, launched.page).catch(() => {});
  }
  process.exit(1);
}
