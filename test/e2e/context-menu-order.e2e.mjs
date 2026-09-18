/**
 * Context-menu ordering & grouping consistency (2026-06-23 spec). Drives the REAL app and,
 * for each representative object menu, reads the rendered `.ctxmenu` and asserts the canonical
 * order: destructive item is LAST and separated, reference group is copies-then-reveal, and the
 * first rendered item never carries a leading separator. The editor-tab menu is pinned to its
 * EXACT item order in both variants (plain file and HTML) — its close-family-first order is
 * frozen by docs/specs/archive/2026-06-23-context-menu-consistency.md §4E.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, makeLog, openSession, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[ctx-menu-order] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('ctx-menu-order');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** Right-click a selector and return the menu rows in order: {label, danger, sepBefore, disabled}. */
async function openMenuOn(page, selector) {
  await page.click(selector, { button: 'right' });
  await page.waitForSelector('.ctxmenu', { timeout: 8000 });
  // Let the keyboard/positioning effects settle so the full item list is rendered.
  await page.waitForTimeout(120);
  return page.evaluate(() => {
    // The item wrappers live in `.ctxmenu__scroll`, not directly under `.ctxmenu` — the frame
    // itself must not scroll or Neon's chamfer cuts the bottom of the CONTENT (blockers Q4).
    // Walking `.ctxmenu` instead collapses every row into one and reads as a leading separator.
    const root = document.querySelector('.ctxmenu .ctxmenu__scroll');
    if (!root) throw new Error('.ctxmenu__scroll not found — the menu item container moved');
    return Array.from(root.children).map((wrap) => {
      const item = wrap.querySelector('.ctxmenu__item');
      return {
        label: item?.querySelector('span:last-child')?.textContent?.trim() ?? '',
        danger: !!item?.classList.contains('ctxmenu__item--danger'),
        sepBefore: !!wrap.querySelector('.ctxmenu__sep'),
        disabled: !!item?.disabled,
      };
    });
  });
}

async function closeMenu(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 }).catch(() => {});
}

/** Invariants every object menu must satisfy. */
function assertCanonical(name, rows) {
  assert(rows.length > 0, `${name}: menu should have items`);
  assert(!rows[0].sepBefore, `${name}: first item must not carry a leading separator`);
  const firstDangerIdx = rows.findIndex((r) => r.danger);
  if (firstDangerIdx >= 0) {
    // The destructive group is the FINAL group and is separated. Find its start (the nearest
    // separator at/above the first danger item); it must be a real group break, and no further
    // group break may appear after it (i.e. nothing follows the destructive group).
    let groupStart = firstDangerIdx;
    while (groupStart > 0 && !rows[groupStart].sepBefore) groupStart--;
    assert(
      groupStart > 0 && rows[groupStart].sepBefore,
      `${name}: the destructive group must be separated from the group above it`,
    );
    assert(
      !rows.slice(groupStart + 1).some((r) => r.sepBefore),
      `${name}: the destructive group must be the LAST group (no separators after it)`,
    );
  }
}

const labels = (rows) => rows.map((r) => r.label);

/** The frozen editor-tab order (§4E): the close family first, then the reference group. */
const TAB_ORDER = [
  'Close',
  'Close others',
  'Close to the right',
  'Close to the left',
  'Close all',
  'Copy path',
  'Copy name',
  'Reveal in Explorer',
];
// An HTML tab extends the SAME groups at the tail — where 'Open in browser' used to sit.
// 'View source' is the label while the tab shows the rendered page, which is the default.
const HTML_TAB_ORDER = [...TAB_ORDER, 'View source', 'Open externally'];

/** Tag the tab whose title ends in `ext` so it can be addressed by selector, then pin it —
 *  a single click on a tree row opens a PREVIEW tab, whose menu carries an extra
 *  'Keep Open' row that would make the exact-order assertion depend on how it was opened. */
async function markAndPinTab(page, ext) {
  await page
    .waitForFunction(
      (suffix) =>
        Array.from(document.querySelectorAll('.tab')).some(
          (el) => !el.className.includes('terminal') && el.textContent?.includes(suffix),
        ),
      ext,
      { timeout: 15000 },
    )
    .catch(() => {});
  const found = await page.evaluate((suffix) => {
    for (const el of document.querySelectorAll('.tab[data-ctxtest]')) {
      el.removeAttribute('data-ctxtest');
    }
    const t = Array.from(document.querySelectorAll('.tab')).find(
      (el) => !el.className.includes('terminal') && el.textContent?.includes(suffix),
    );
    if (t) t.setAttribute('data-ctxtest', '1');
    return !!t;
  }, ext);
  if (!found) return false;
  await page.dblclick('.tab[data-ctxtest="1"]');
  await page.waitForTimeout(120);
  return true;
}

let launched = null;
let repoDir = null;
try {
  repoDir = mkdtempSync(join(tmpdir(), 'conduit-ctxmenu-'));
  git(['init', '-q'], repoDir);
  git(['config', 'user.email', 't@t.t'], repoDir);
  git(['config', 'user.name', 'T'], repoDir);
  writeFileSync(join(repoDir, 'alpha.txt'), 'one\n');
  writeFileSync(join(repoDir, 'beta.txt'), 'two\n');
  writeFileSync(join(repoDir, 'report.html'), '<!doctype html><title>R</title><h1>R</h1>\n');
  git(['add', '.'], repoDir);
  git(['commit', '-qm', 'seed'], repoDir);
  writeFileSync(join(repoDir, 'alpha.txt'), 'one changed\n'); // a working-tree change

  launched = await launchApp();
  const { page } = launched;
  await tapBridge(page);
  await openSession(page, { path: repoDir.replace(/\\/g, '/'), agentId: 'shell:cmd' });

  // ── Session row ───────────────────────────────────────────────────────────
  await page.waitForSelector('.session', { timeout: 15000 });
  const session = await openMenuOn(page, '.session');
  log('session:', JSON.stringify(labels(session)));
  assertCanonical('session', session);
  const copyPathI = labels(session).indexOf('Copy path');
  const revealI = labels(session).indexOf('Reveal in Explorer');
  assert(copyPathI >= 0 && revealI > copyPathI, 'session: Reveal must come after Copy path');
  await closeMenu(page);

  // ── Change row (Changes tab) ──────────────────────────────────────────────
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.rtab'))
      .find((el) => el.textContent?.trim().startsWith('Changes'))
      ?.click();
  });
  await page.waitForSelector('.change', { timeout: 15000 });
  const change = await openMenuOn(page, '.change');
  log('change:', JSON.stringify(labels(change)));
  assertCanonical('change', change);
  assert(
    labels(change)[change.length - 1] === 'Discard all changes',
    'change: last item must be "Discard all changes"',
  );
  const cCopy = labels(change).indexOf('Copy path');
  const cReveal = labels(change).indexOf('Reveal in Explorer');
  assert(cCopy >= 0 && cReveal > cCopy, 'change: Reveal must come after Copy path');
  await closeMenu(page);

  // ── File-tree node (Files tab) ────────────────────────────────────────────
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.rtab'))
      .find((el) => el.textContent?.trim() === 'Files')
      ?.click();
  });
  await page.waitForSelector('.filerow', { timeout: 15000 });
  const fileRow = await page.evaluate(() => {
    const r = Array.from(document.querySelectorAll('.filerow')).find((el) =>
      el.querySelector('.filerow__name')?.textContent?.endsWith('.txt'),
    );
    if (r) r.setAttribute('data-ctxtest', '1');
    return !!r;
  });
  assert(fileRow, 'a .txt file row should be present in the tree');
  const node = await openMenuOn(page, '.filerow[data-ctxtest="1"]');
  log('file node:', JSON.stringify(labels(node)));
  assertCanonical('file-node', node);
  assert(labels(node)[node.length - 1] === 'Delete', 'file-node: last item must be "Delete"');
  await closeMenu(page);

  // ── Editor-tab, plain file ────────────────────────────────────────────────
  await page.click('.filerow[data-ctxtest="1"]');
  await page.waitForSelector('.tab:not(.tab--terminal)', { timeout: 15000 });
  assert(await markAndPinTab(page, '.txt'), 'the .txt editor tab should be present');
  const tab = await openMenuOn(page, '.tab[data-ctxtest="1"]');
  log('editor tab:', JSON.stringify(labels(tab)));
  assertCanonical('editor-tab', tab);
  assert(
    JSON.stringify(labels(tab)) === JSON.stringify(TAB_ORDER),
    `editor-tab: order must be exactly ${JSON.stringify(TAB_ORDER)}, got ${JSON.stringify(labels(tab))}`,
  );
  await closeMenu(page);

  // ── Editor-tab, HTML file ─────────────────────────────────────────────────
  const htmlRow = await page.evaluate(() => {
    const r = Array.from(document.querySelectorAll('.filerow')).find((el) =>
      el.querySelector('.filerow__name')?.textContent?.endsWith('.html'),
    );
    if (r) r.setAttribute('data-ctxhtml', '1');
    return !!r;
  });
  assert(htmlRow, 'report.html should be present in the tree');
  await page.click('.filerow[data-ctxhtml="1"]');
  assert(await markAndPinTab(page, '.html'), 'the .html editor tab should be present');
  const htmlTab = await openMenuOn(page, '.tab[data-ctxtest="1"]');
  log('html editor tab:', JSON.stringify(labels(htmlTab)));
  assertCanonical('html-editor-tab', htmlTab);
  assert(
    JSON.stringify(labels(htmlTab)) === JSON.stringify(HTML_TAB_ORDER),
    `html-editor-tab: order must be exactly ${JSON.stringify(HTML_TAB_ORDER)}, got ${JSON.stringify(labels(htmlTab))}`,
  );
  await closeMenu(page);

  log('All assertions passed ✓');
  await launched.cleanup();
  rmSync(repoDir, { recursive: true, force: true });
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) log('FAIL ✗', e.message);
  else {
    console.error('[ctx-menu-order] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
  }
  try {
    await launched?.cleanup();
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(isAssertion ? 1 : 2);
}
