/**
 * plan-blocks — a plan's fences are live: the `ts` fence is a Monaco editor whose keystrokes reach
 * disk, and the `mermaid` fence is a structural node/edge editor whose every mutation is written
 * back as flowchart source.
 *
 * The whole Slice 5 Check (docs/plans/2026-09-19-interactive-plan.plan.md).
 *
 * Setup matches plan-editor.e2e.mjs: `.conduit/plans/` exists before the project is opened (the
 * host watcher can only attach to a directory that exists), the plan is written after, and the app
 * is shut down before the temp dir goes (the session's shell holds it as its cwd).
 *
 * A change reaches disk ~500 ms after the last input — Milkdown's listener debounces 200 ms, the
 * block editors 150 ms and PlanView's write 300 ms — so every check polls the file rather than
 * sleeping a fixed time.
 *
 * Windows-only, matching the suite.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, launchApp, makeLog, openSession } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[plan-blocks] SKIP — suite is Windows-only');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'plan', 'identity.md');
const log = makeLog('plan-blocks');

const SIGNATURE =
  'export function createIdentity(input: { email: string }): Promise<{ id: string }>';
/** Typed in with the caret parked before ` }): Promise` — no bracket Monaco would auto-close. */
const ADDED_PARAM = '; traceId: string';
const SIGNATURE_AFTER = SIGNATURE.replace(' }): Promise', `${ADDED_PARAM} }): Promise`);

const root = mkdtempSync(join(tmpdir(), 'conduit-planblocks-'));
const plans = join(root, '.conduit', 'plans');
mkdirSync(plans, { recursive: true });

let launched = null;
let code = 0;
try {
  launched = await launchApp();
  const { page } = launched;

  await openSession(page, { path: root });
  await page.waitForTimeout(1500);

  copyFileSync(FIXTURE, join(plans, 'identity.md'));
  log('wrote identity.md into .conduit/plans');

  const toast = page.locator('.toast', { hasText: 'Agent updated plan identity' }).first();
  await toast.waitFor({ state: 'visible', timeout: 5000 });
  await toast.locator('.toast__action', { hasText: 'Open' }).click();

  const editor = page.locator('.plan__editor').first();
  await editor.waitFor({ state: 'visible', timeout: 5000 });
  log('plan open in the editor ✓');

  const planFile = join(plans, 'identity.md');
  const fixtureText = readFileSync(FIXTURE, 'utf8');
  const readPlan = () => readFileSync(planFile, 'utf8');
  const fenceOf = (text, lang) =>
    new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\\n\`\`\``).exec(text)?.[1] ?? null;

  const until = async (holds, budgetMs) => {
    const started = Date.now();
    for (;;) {
      if (holds()) return Date.now() - started;
      if (Date.now() - started >= budgetMs) return null;
      await page.waitForTimeout(50);
    }
  };
  const untilFile = (holds, budgetMs) => until(() => holds(readPlan()), budgetMs);

  // ── the ts fence is Monaco, and typing in it reaches disk ────────────────────────────────
  const codeBlock = page.locator('.plan__code').first();
  const monacoUp = await codeBlock
    .locator('.monaco-editor')
    .first()
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  assert(monacoUp, 'the ts fence must render a .monaco-editor inside .plan__code');
  log('ts fence rendered as Monaco ✓');

  // A real click, because focus is the thing that broke: the block's root has to be
  // `contenteditable=false` or the caret lands in the PROSE and the fence never sees an edit.
  await codeBlock.locator('.view-line').first().click();
  const focused = await page.evaluate(() => document.activeElement?.closest('.plan__code') != null);
  assert(focused, 'clicking the ts fence must put focus inside the block, not in the prose');

  // Caret keys are real; the text is not. Monaco 0.55 takes text through an `EditContext`, which
  // Playwright's synthesized input does not reach, so the insertion goes through the same `type`
  // command a keystroke would run — at whatever caret the arrow keys actually left behind.
  await page.keyboard.press('End');
  const lefts = SIGNATURE.length - SIGNATURE.indexOf(' }): Promise');
  for (let i = 0; i < lefts; i++) await page.keyboard.press('ArrowLeft');
  const typed = await page.evaluate((text) => {
    const editor = (window.monaco?.editor.getEditors?.() ?? []).find((e) => e.hasTextFocus());
    if (!editor) return false;
    editor.trigger('e2e', 'type', { text });
    return true;
  }, ADDED_PARAM);
  assert(typed, 'the focused editor must be reachable to type into');

  const wroteCode = await untilFile((t) => t.includes('traceId: string'), 4000);
  assert(wroteCode !== null, 'a keystroke in the Monaco fence must reach the file within 4 s');
  log(`Monaco edit written through in ${wroteCode} ms ✓`);

  const afterCode = readPlan();
  assert(
    fenceOf(afterCode, 'ts') === SIGNATURE_AFTER,
    `the ts fence must be the signature plus the parameter, got "${fenceOf(afterCode, 'ts')}"`,
  );
  assert(
    fenceOf(afterCode, 'mermaid') === fenceOf(fixtureText, 'mermaid'),
    'the mermaid fence must be byte-identical after editing the ts fence',
  );
  assert(
    afterCode.startsWith('---\ntitle: Identity service\n---\n\n# Identity service\n'),
    'the frontmatter and heading must keep their bytes',
  );
  assert(
    afterCode.includes(
      'Transactions carry a payer id, so the transaction service looks an account up on every\nwrite. That lookup is the only coupling between the two backend services.',
    ),
    'the prose must keep its bytes, hard wrap and all',
  );
  log('only the ts fence changed ✓');

  // ── the mermaid fence is a diagram ───────────────────────────────────────────────────────
  const flow = page.locator('.planflow .react-flow').first();
  const flowUp = await flow
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  assert(flowUp, 'the mermaid fence must render a .react-flow canvas');

  const nodeCount = await page.locator('.planflow__node').count();
  assert(nodeCount === 3, `the diagram must render 3 .planflow__node, got ${nodeCount}`);
  const regionCount = await page.locator('.planflow__region').count();
  assert(regionCount === 1, `the diagram must render 1 .planflow__region, got ${regionCount}`);

  // Counting them is not seeing them: a fit against an unsized canvas leaves every node in the
  // DOM at minZoom, outside the canvas and clipped away. Assert they are on it, at a real size.
  const laidOut = await page.evaluate(() => {
    const canvas = document.querySelector('.planflow__canvas')?.getBoundingClientRect();
    const nodes = [...document.querySelectorAll('.planflow__node')].map((n) =>
      n.getBoundingClientRect(),
    );
    if (!canvas || nodes.length === 0) return null;
    return nodes.every(
      (r) =>
        r.width >= 40 &&
        r.height >= 16 &&
        r.left >= canvas.left - 1 &&
        r.right <= canvas.right + 1 &&
        r.top >= canvas.top - 1 &&
        r.bottom <= canvas.bottom + 1,
    );
  });
  assert(laidOut === true, 'every diagram node must be laid out inside the canvas at a real size');
  log('diagram rendered 3 nodes and 1 region, all on the canvas ✓');

  // A right-click on an edge has to land ON the path: an edge <g>'s bounding-box centre is very
  // often off the curve, so the point is taken from the interaction path itself.
  const pointOnEdge = async (edgeId) =>
    page.evaluate((id) => {
      const g = document.querySelector(`.react-flow__edge[data-id="${id}"]`);
      const path =
        g?.querySelector('path.react-flow__edge-interaction') ?? g?.querySelector('path');
      if (!path) return null;
      const at = path.getPointAtLength(path.getTotalLength() / 2);
      const m = path.getScreenCTM();
      if (!m) return null;
      return { x: m.a * at.x + m.c * at.y + m.e, y: m.b * at.x + m.d * at.y + m.f };
    }, edgeId);

  // Fixture edge order: e0 web→identity, e1 web→txn, e2 txn→identity.
  const edgeAt = await pointOnEdge('e2');
  assert(edgeAt !== null, 'the txn → identity edge must be on the canvas');
  await page.mouse.click(edgeAt.x, edgeAt.y, { button: 'right' });

  const menu = page.locator('.ctxmenu').first();
  await menu.waitFor({ state: 'visible', timeout: 4000 });
  await menu.locator('.ctxmenu__item', { hasText: 'Delete' }).first().click();

  const wroteDelete = await untilFile((t) => !t.includes('txn -->|lookup| identity'), 4000);
  assert(wroteDelete !== null, 'deleting an edge must reach the file within 4 s');
  const afterDelete = fenceOf(readPlan(), 'mermaid') ?? '';
  assert(
    afterDelete.includes('web --> identity') && afterDelete.includes('web --> txn'),
    `the other two edges must remain, got "${afterDelete}"`,
  );
  log(`edge delete written through in ${wroteDelete} ms ✓`);

  // ── pane menu → Add node ─────────────────────────────────────────────────────────────────
  const paneAt = await page.evaluate(() => {
    const pane = document.querySelector('.planflow .react-flow__pane');
    if (!pane) return null;
    const box = pane.getBoundingClientRect();
    const blockers = [...document.querySelectorAll('.react-flow__node, .planflow__toolbar')].map(
      (el) => el.getBoundingClientRect(),
    );
    const clear = (x, y) =>
      !blockers.some(
        (b) => x >= b.left - 8 && x <= b.right + 8 && y >= b.top - 8 && y <= b.bottom + 8,
      );
    for (let y = box.bottom - 10; y > box.top + 10; y -= 10) {
      for (let x = box.left + 10; x < box.right - 10; x += 10) {
        if (clear(x, y)) return { x, y };
      }
    }
    return null;
  });
  assert(paneAt !== null, 'the diagram canvas must have a point clear of its nodes');
  await page.mouse.click(paneAt.x, paneAt.y, { button: 'right' });

  await menu.waitFor({ state: 'visible', timeout: 4000 });
  await menu.locator('.ctxmenu__item', { hasText: 'Add node' }).first().click();

  const wroteAdd = await untilFile((t) => /^n1$/m.test(fenceOf(t, 'mermaid') ?? ''), 4000);
  assert(wroteAdd !== null, 'Add node must reach the file within 4 s');
  log(`added node written through in ${wroteAdd} ms ✓`);

  // ── keyboard: Shift+F10 on the web node → Connect to… → n1 ───────────────────────────────
  await page.locator('.react-flow__node[data-id="web"]').first().focus();
  await page.keyboard.press('Shift+F10');
  await menu.waitFor({ state: 'visible', timeout: 4000 });
  await menu.locator('.ctxmenu__item', { hasText: 'Connect to' }).first().click();

  const picker = page.locator('.planflow__picker').first();
  await picker.waitFor({ state: 'visible', timeout: 4000 });
  await picker.locator('#planflow-pick-n1').click();

  const wroteConnect = await untilFile(
    (t) => (fenceOf(t, 'mermaid') ?? '').includes('web --> n1'),
    4000,
  );
  assert(wroteConnect !== null, 'Connect to… must write `web --> n1` within 4 s');
  log(`connect written through in ${wroteConnect} ms ✓`);

  // ── keyboard: click to select, Delete to remove ──────────────────────────────────────────
  // Selection is the whole mechanism here: ReactFlow is controlled, so it marks nothing itself
  // and its Delete key deletes only what is `selected`. Clicking has to light the node up.
  await page.locator('.react-flow__node[data-id="n1"]').first().click();
  const selectedNodes = await page.locator('.planflow__node--selected').count();
  assert(selectedNodes === 1, `clicking a node must select exactly it, got ${selectedNodes}`);

  await page.keyboard.press('Delete');
  const wroteNodeDelete = await untilFile((t) => {
    const fence = fenceOf(t, 'mermaid') ?? '';
    return !fence.includes('n1');
  }, 4000);
  assert(wroteNodeDelete !== null, 'Delete on a selected node must reach the file within 4 s');
  assert(
    !(fenceOf(readPlan(), 'mermaid') ?? '').includes('web --> n1'),
    'deleting the node must take its edge with it',
  );
  log(`selected node deleted by keyboard in ${wroteNodeDelete} ms ✓`);

  // The canvas re-renders from the fence the delete just wrote, so wait for the edge rather than
  // reading the DOM the same tick the file settled.
  await page
    .locator('.react-flow__edge[data-id="e0"]')
    .first()
    .waitFor({ state: 'attached', timeout: 4000 })
    .catch(() => {});
  const firstEdgeAt = await pointOnEdge('e0');
  assert(
    firstEdgeAt !== null,
    `the web → identity edge must be on the canvas, fence was:\n${fenceOf(readPlan(), 'mermaid')}`,
  );
  await page.mouse.click(firstEdgeAt.x, firstEdgeAt.y);
  const selectedEdges = await page.locator('.react-flow__edge.selected').count();
  assert(selectedEdges === 1, `clicking an edge must select exactly it, got ${selectedEdges}`);

  await page.keyboard.press('Delete');
  const wroteEdgeDelete = await untilFile(
    (t) => !(fenceOf(t, 'mermaid') ?? '').includes('web --> identity'),
    4000,
  );
  assert(wroteEdgeDelete !== null, 'Delete on a selected edge must reach the file within 4 s');
  assert(
    (fenceOf(readPlan(), 'mermaid') ?? '').includes('web --> txn'),
    'the other edge must survive the keyboard delete',
  );
  log(`selected edge deleted by keyboard in ${wroteEdgeDelete} ms ✓`);

  const finalMermaid = fenceOf(readPlan(), 'mermaid') ?? '';
  assert(
    !finalMermaid.includes('txn -->|lookup| identity'),
    'the deleted edge must still be gone at the end',
  );
  assert(
    fenceOf(readPlan(), 'ts') === SIGNATURE_AFTER,
    'the ts fence must be untouched by the diagram edits',
  );

  // ── an empty plan still takes a keystroke ────────────────────────────────────────────────
  // A zero-byte or frontmatter-only plan has no blocks, while ProseMirror always holds one empty
  // paragraph. Read as the two parsers disagreeing, that refused every keystroke on a plan the
  // agent had only just created — the one moment a human is most likely to start typing.
  const emptyFile = join(plans, 'empty.md');
  writeFileSync(emptyFile, '');
  const emptyToast = page.locator('.toast', { hasText: 'Agent updated plan empty' }).first();
  await emptyToast.waitFor({ state: 'visible', timeout: 6000 });
  await emptyToast.locator('.toast__action', { hasText: 'Open' }).click();

  const prose = page.locator('.plan__editor .ProseMirror').first();
  await prose.waitFor({ state: 'visible', timeout: 6000 });
  await prose.click();
  await page.keyboard.type('Hello plan');

  const wroteEmpty = await until(
    () => readFileSync(emptyFile, 'utf8').includes('Hello plan'),
    6000,
  );
  assert(
    wroteEmpty !== null,
    `typing into an empty plan must reach the file, it held "${readFileSync(emptyFile, 'utf8')}"`,
  );
  // "Saved" has to mean the typed text is on disk — the failure mode QA saw was the bar saying so
  // after a refusal, with the keystrokes still only in the editor.
  await page
    .locator('.plan__save', { hasText: 'Saved' })
    .first()
    .waitFor({ state: 'visible', timeout: 4000 });
  const retries = await page.locator('.plan__retry').count();
  assert(retries === 0, 'an empty plan must not offer Retry after a keystroke');
  log(`empty plan accepted a keystroke, on disk in ${wroteEmpty} ms ✓`);

  log('PASS ✓ — live Monaco fence, live diagram, pointer and keyboard pathways');
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    log('FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[plan-blocks] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
    code = 2;
  }
}

try {
  await launched?.cleanup();
} catch {
  /* already gone */
}
try {
  rmSync(root, { recursive: true, force: true });
} catch {
  // A handle the OS has not released yet; tmpdir is reaped anyway.
}
process.exit(code);
