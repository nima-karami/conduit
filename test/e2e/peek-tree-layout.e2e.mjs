/**
 * The references / implementations peek's file tree must lay its rows out the way Monaco's CSS
 * intends: the twistie's chevron clear of the file name, and the ellipsized directory path clear
 * of the count badge — at the default window size AND a narrow one, selected row included.
 *
 * Both broke together because the app's box-sizing reset reached into Monaco's DOM (Monaco is
 * authored for content-box): the twistie's 16px width swallowed its own 14px of padding and the
 * glyph overflowed onto the name. Measured on the real app because it is a LAYOUT result — no
 * declaration in either sheet says "overlap".
 *
 * The chevron is a `::before` codicon glyph, which has no rect of its own, so its right edge is
 * derived: the glyph is centred in the twistie's content box and is `font-size` wide.
 *
 * Run: node test/e2e/run-smoke.mjs peek-tree-layout   (needs `npm run build` first)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearTransients,
  openDoc,
  placeCursor,
  tapIndex,
  waitForIndexReady,
} from './goto-matrix.mjs';
import { assert, openSession, runScenario } from './harness.mjs';

/** Below this the path's last glyph (or its ellipsis) visually touches the badge. */
const MIN_BADGE_GAP = 4;

const DEEP = [
  'packages',
  'ships-service-platform',
  'pkg',
  'ships',
  'partner',
  'integrations',
  'reservation-adapters',
  'implementations-generated',
  'v2',
];
const NAMES = [
  'carnival',
  'royalcaribbean',
  'norwegian',
  'msc-cruises',
  'princess',
  'celebrity',
  'holland-america',
  'cunard',
  'viking-ocean',
  'oceania',
  'regent-seven-seas',
  'silversea',
];

/** One interface implemented in a dozen files at 5–9 directory levels, so every row's path is
 *  long enough to ellipsize. */
function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'peek-tree-'));
  const write = (rel, text) => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  };
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: { target: 'es2022', module: 'esnext', moduleResolution: 'bundler' },
      include: ['**/*.ts'],
    }),
  );
  write('src/partner.ts', 'export interface PartnerAdapter {\n  reserve(id: string): string;\n}\n');
  NAMES.forEach((name, i) => {
    const depth = 5 + (i % 5);
    write(
      `${DEEP.slice(0, depth).join('/')}/${name}.ts`,
      `import type { PartnerAdapter } from '${'../'.repeat(depth)}src/partner';\n\n` +
        `export class Adapter${i} implements PartnerAdapter {\n  reserve(id: string) {\n    return id;\n  }\n}\n`,
    );
  });
  const git = (args) =>
    execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true });
  git(['init', '-q']);
  git(['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'add', '-A']);
  git(['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-q', '-m', 'fx']);
  return root;
}

/** Geometry of every mounted file row in the open peek's tree. */
function measureRows(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.zone-widget .ref-tree .monaco-list-row'));
    return rows
      .filter((row) => row.querySelector('.reference-file'))
      .map((row) => {
        const rect = (sel) => row.querySelector(sel)?.getBoundingClientRect() ?? null;
        const twistie = row.querySelector('.monaco-tl-twistie');
        const tr = twistie.getBoundingClientRect();
        const ts = getComputedStyle(twistie);
        const contentLeft = tr.left + Number.parseFloat(ts.paddingLeft);
        const contentRight = tr.right - Number.parseFloat(ts.paddingRight);
        const glyph = Number.parseFloat(getComputedStyle(twistie, '::before').fontSize);
        const desc = rect('.label-description');
        const clip = rect('.monaco-icon-label-container');
        return {
          name: row.querySelector('.label-name')?.textContent ?? '?',
          selected: row.classList.contains('selected'),
          glyphRight: (contentLeft + contentRight) / 2 + glyph / 2,
          nameLeft: rect('.label-name').left,
          pathRight: Math.min(desc.right, clip.right),
          badgeLeft: rect('.monaco-count-badge').left,
        };
      });
  });
}

function assertRows(rows, where) {
  assert(rows.length >= 6, `${where}: expected ≥6 file rows in the peek tree, got ${rows.length}`);
  for (const r of rows) {
    assert(
      r.glyphRight <= r.nameLeft,
      `${where}: ${r.name} — chevron ends at ${r.glyphRight.toFixed(1)}px, past the name at ${r.nameLeft.toFixed(1)}px`,
    );
    const gap = r.badgeLeft - r.pathRight;
    assert(
      gap >= MIN_BADGE_GAP,
      `${where}: ${r.name} — path ends ${gap.toFixed(1)}px before the count badge (need ≥${MIN_BADGE_GAP})`,
    );
  }
}

runScenario('peek-tree-layout', async ({ app, page, log }) => {
  const root = buildFixture();
  const target = join(root, 'src', 'partner.ts');
  await tapIndex(page);
  const sid = await openSession(page, { path: root });
  await waitForIndexReady(page, log);
  await openDoc(app, page, sid, target);

  const openPeek = async (key) => {
    await clearTransients(page);
    await placeCursor(page, target, 'PartnerAdapter');
    await page.keyboard.press(key);
    await page.waitForSelector('.zone-widget .reference-file', { timeout: 20000 });
    // The tree lays out on the frame after it mounts.
    await page.waitForTimeout(500);
  };

  for (const size of ['default', 'narrow']) {
    if (size === 'narrow') {
      await app.evaluate((electron) =>
        electron.BrowserWindow.getAllWindows()[0].setSize(1100, 800),
      );
      await page.waitForTimeout(500);
    }
    for (const [key, what] of [
      ['Shift+F12', 'references'],
      ['Control+F12', 'implementations'],
    ]) {
      await openPeek(key);
      const rows = await measureRows(page);
      log(`${what} @ ${size}: ${rows.length} rows, first ${JSON.stringify(rows[0])}`);
      assertRows(rows, `${what} @ ${size}`);
    }

    // Select a FILE row with a real click — the selected/focused styling is its own rule set.
    // Opening a peek scrolls the host editor to reveal it, on animation frames a hidden window
    // throttles — so aim only once the row is inside the viewport and has stopped moving.
    let at = null;
    let prev = null;
    for (const deadline = Date.now() + 10000; Date.now() < deadline && !at; ) {
      const cur = await page.evaluate(() => {
        const rows = Array.from(
          document.querySelectorAll('.zone-widget .ref-tree .monaco-list-row'),
        ).filter((r) => r.querySelector('.reference-file'));
        const b = rows[2]?.getBoundingClientRect();
        if (!b || b.top < 0 || b.bottom > window.innerHeight) return null;
        return { x: b.left + 40, y: b.top + b.height / 2 };
      });
      if (cur && prev && cur.x === prev.x && cur.y === prev.y) at = cur;
      prev = cur;
      await page.waitForTimeout(150);
    }
    assert(at, `${size}: the third file row never came to rest inside the peek`);
    await page.mouse.click(at.x, at.y);
    const selected = await page
      .waitForFunction(
        () =>
          !!document.querySelector(
            '.zone-widget .ref-tree .monaco-list-row.selected .reference-file',
          ),
        null,
        { timeout: 5000 },
      )
      .then(() => true)
      .catch(() => false);
    assert(selected, `${size}: clicking a file row left no file row selected`);
    const rows = await measureRows(page);
    assertRows(rows, `selected @ ${size}`);
  }
  await clearTransients(page);
});
