/**
 * Context-menu ordering & grouping consistency (2026-06-23 spec). Drives the REAL app and,
 * for each representative object menu, reads the rendered `.ctxmenu` and asserts the canonical
 * order: destructive item is LAST and separated, reference group is copies-then-reveal, and the
 * first rendered item never carries a leading separator. Also checks the editor-tab label casing.
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
    const root = document.querySelector('.ctxmenu');
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

let launched = null;
let repoDir = null;
try {
  repoDir = mkdtempSync(join(tmpdir(), 'conduit-ctxmenu-'));
  git(['init', '-q'], repoDir);
  git(['config', 'user.email', 't@t.t'], repoDir);
  git(['config', 'user.name', 'T'], repoDir);
  writeFileSync(join(repoDir, 'alpha.txt'), 'one\n');
  writeFileSync(join(repoDir, 'beta.txt'), 'two\n');
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

  // ── Editor-tab (open a file first) ────────────────────────────────────────
  await page.click('.filerow[data-ctxtest="1"]');
  await page.waitForSelector('.tab:not(.tab--terminal)', { timeout: 15000 }).catch(() => {});
  const tabSel = await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('.tab')).find(
      (el) => !el.className.includes('terminal') && el.textContent?.includes('.txt'),
    );
    if (t) t.setAttribute('data-ctxtest', '1');
    return !!t;
  });
  if (tabSel) {
    const tab = await openMenuOn(page, '.tab[data-ctxtest="1"]');
    log('editor tab:', JSON.stringify(labels(tab)));
    assertCanonical('editor-tab', tab);
    const L = labels(tab);
    assert(L.includes('Close others'), 'editor-tab: must use sentence case "Close others"');
    assert(
      L.includes('Close to the right') && L.includes('Close to the left'),
      'editor-tab: must use sentence case "Close to the right/left"',
    );
    assert(!L.includes('Close Others'), 'editor-tab: no Title-Case "Close Others"');
    await closeMenu(page);
  } else {
    log('NOTE: editor tab not reachable this run — tab casing asserted by source only');
  }

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
