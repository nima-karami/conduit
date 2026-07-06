/**
 * arch-node-graph (slice F) — drives the REAL architecture canvas: add a typed port, undo/redo it,
 * rename it, and wire two ports together, observing the live doc via window.__archDoc (a read-only
 * snapshot, like the harness's window.__sessions). Runs HIDDEN. This crosses the view↔model↔undo
 * boundary a unit test can't.
 */
import { assert, closeApp, launchApp, makeLog, openSession, REPO } from './harness.mjs';

const log = makeLog('arch-node-graph');

let launched;
try {
  launched = await launchApp();
  const { app, page } = launched;
  await openSession(page, { path: REPO });

  // Open the architecture canvas via the command palette. Leave the terminal first (Ctrl+` — the
  // proven escape from shortcut-precedence.e2e) so the app combo isn't swallowed by the terminal.
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached', timeout: 20000 });
  await page.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.press('Control+Backquote');
  await page.waitForFunction(
    () => !document.activeElement?.classList.contains('xterm-helper-textarea'),
    null,
    { timeout: 5000 },
  );
  await page.keyboard.press('Control+Shift+P');
  await page.waitForSelector('.palette', { state: 'visible', timeout: 5000 });
  await page.keyboard.type('architecture');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.archnode', { timeout: 10000 });
  await page.waitForFunction(() => !!window.__archDoc, null, { timeout: 5000 });
  log('canvas open ✓');

  const gid = await page.evaluate(() => window.__archGraphId);
  const nodeIds = await page.evaluate(
    (g) => window.__archDoc.graphs[g].nodes.map((n) => n.id),
    gid,
  );
  const [a, b] = nodeIds;
  const outCount = () =>
    page.evaluate(
      ([g, id]) => (window.__archDoc.graphs[g].nodes.find((n) => n.id === id).outputs || []).length,
      [gid, a],
    );

  // Add an output port to node A (real click on its "+ out").
  await page
    .locator(`.react-flow__node[data-id="${a}"] .archnode__col--out .archport__add`)
    .click();
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

  // Add an input to node B, then drag-wire A.out → B.in (a real React Flow connection gesture).
  await page.locator(`.react-flow__node[data-id="${b}"] .archnode__col--in .archport__add`).click();
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

  log('all assertions passed ✓');
  await closeApp(app, page);
} catch (err) {
  console.error('[arch-node-graph] FAIL', err);
  if (launched) await closeApp(launched.app, launched.page).catch(() => {});
  process.exit(1);
}
