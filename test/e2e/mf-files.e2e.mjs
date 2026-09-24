/**
 * mf-files — the Files tab, search and quick open across a session's folders
 * (docs/specs/2026-09-23-mf-files.md §7.2/§7.3). One phase per plan slice, in order, on one
 * session: home `rmb` (a git repo) + attached `ci-image`, later `api-contracts`.
 *
 * Every button is a real click; pickers answer through `__pickDirHook` (locked L11) and OS
 * drops enter through `window.__conduitOsDrop` (spec §3.3), both e2e-only seams.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

// ── fixture ─────────────────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'mffiles-e2e-'));
const rmb = join(root, 'rmb');
const ciImage = join(root, 'ci-image');
const apiContracts = join(root, 'api-contracts');

function writeCiImage() {
  mkdirSync(join(ciImage, 'src'), { recursive: true });
  mkdirSync(join(ciImage, 'lib'), { recursive: true });
  writeFileSync(join(ciImage, 'src', 'index.ts'), 'export const ci = 1;\n');
  writeFileSync(join(ciImage, 'lib', 'util.ts'), 'export const utilValue = 42;\n');
  writeFileSync(
    join(ciImage, 'main.ts'),
    "import { utilValue } from './lib/util';\n\nexport const doubled = utilValue * 2;\n",
  );
  writeFileSync(join(ciImage, 'b.txt'), 'MFTOKEN in ci-image\n');
}

mkdirSync(join(rmb, 'src'), { recursive: true });
writeFileSync(join(rmb, 'src', 'index.ts'), 'export const rmb = 1;\n');
writeFileSync(join(rmb, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n');
writeFileSync(join(rmb, 'a.txt'), 'MFTOKEN in rmb\n');
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', ...args], { cwd });
git(rmb, 'init', '-q', '-b', 'main');
git(rmb, 'add', '-A');
git(rmb, 'commit', '-q', '-m', 'init');
writeFileSync(join(rmb, 'src', 'index.ts'), 'export const rmb = 2;\n');
writeCiImage();
mkdirSync(apiContracts, { recursive: true });
writeFileSync(join(apiContracts, 'c.txt'), 'MFTOKEN in api-contracts\n');

// ── page helpers ────────────────────────────────────────────────────────────

const section = (page, label) => page.locator(`.files-section[aria-label="${label}"]`);
const rowIn = (page, label, name) =>
  section(page, label).locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name}$`) }),
  });

/** [name, tag] per section bar, in DOM order. */
const bars = (page) =>
  page.$$eval('.files-section > .files__bar', (els) =>
    els.map((b) => [
      b.querySelector('.files__root-name')?.textContent ?? '',
      b.querySelector('.files__tag')?.textContent ?? '',
    ]),
  );

async function waitBars(page, want, what) {
  const ok = await page
    .waitForFunction(
      (w) => {
        const got = [...document.querySelectorAll('.files-section > .files__bar')].map((b) => [
          b.querySelector('.files__root-name')?.textContent ?? '',
          b.querySelector('.files__tag')?.textContent ?? '',
        ]);
        return JSON.stringify(got) === JSON.stringify(w);
      },
      want,
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(
    ok,
    `${what}: bars should be ${JSON.stringify(want)}, got ${JSON.stringify(await bars(page))}`,
  );
}

const sessionOf = (page, sid) =>
  page.evaluate((id) => (window.__sessions || []).find((s) => s.id === id) ?? null, sid);

// ── phases ──────────────────────────────────────────────────────────────────

async function phaseSections({ page, log, sid }) {
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await waitBars(
    page,
    [
      ['rmb', 'Home'],
      ['ci-image', 'Attached'],
    ],
    'AC1/AC2 initial',
  );
  log('two sections, rmb Home then ci-image Attached ✓');

  // D13: a home-repo change at src/index.ts dots rmb's row, never ci-image's same-named one.
  await rowIn(page, 'rmb', 'src').first().click();
  await rowIn(page, 'ci-image', 'src').first().click();
  const rmbIndex = rowIn(page, 'rmb', 'index.ts').first();
  const ciIndex = rowIn(page, 'ci-image', 'index.ts').first();
  await rmbIndex.waitFor({ state: 'attached', timeout: 15000 });
  await ciIndex.waitFor({ state: 'attached', timeout: 15000 });
  await rmbIndex.locator('.filerow__dot').waitFor({ state: 'attached', timeout: 20000 });
  assert(
    (await ciIndex.locator('.filerow__dot').count()) === 0,
    'D13: ci-image/src/index.ts must carry no dot from the rmb repo',
  );
  log('git dot on rmb/src/index.ts only ✓');

  // D3: the chevron collapses the section to its bar.
  await section(page, 'ci-image').locator('button[aria-label="Collapse ci-image"]').click();
  await section(page, 'ci-image')
    .locator('.files-section__tree')
    .waitFor({ state: 'detached', timeout: 5000 });
  assert(
    (await section(page, 'ci-image').locator('.filerow').count()) === 0,
    'a collapsed section shows its bar only',
  );
  await section(page, 'ci-image').locator('button[aria-label="Expand ci-image"]').click();
  await rowIn(page, 'ci-image', 'src').first().waitFor({ state: 'attached', timeout: 5000 });
  assert(
    (await rowIn(page, 'ci-image', 'index.ts').count()) === 0,
    'D3: re-expanding shows the top level only (subfolders were collapsed with the section)',
  );
  log('collapse → bar only; expand → top level ✓');

  // AC8: a terminal cd moves session.cwd but not the Files sections.
  await page.evaluate(
    ({ s, sub }) => {
      window.agentDeck.post({ type: 'term:input', sessionId: s, data: `cd "${sub}"\r` });
    },
    { s: sid, sub: join(rmb, 'src') },
  );
  const moved = await page
    .waitForFunction(
      (id) => {
        const s = (window.__sessions || []).find((x) => x.id === id);
        return !!s?.cwd && /[\\/]src$/i.test(s.cwd);
      },
      sid,
      { timeout: 20000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(
    moved,
    `cd should move session.cwd, got ${JSON.stringify((await sessionOf(page, sid))?.cwd)}`,
  );
  await page.waitForTimeout(500);
  await waitBars(
    page,
    [
      ['rmb', 'Home'],
      ['ci-image', 'Attached'],
    ],
    'AC8 after cd',
  );
  log('cd moved cwd; sections unchanged ✓');
}

runScenario('mf-files', async ({ app, page, log }) => {
  const sid = await openSession(page, {
    path: rmb,
    roots: [ciImage],
    agentId: 'shell:powershell',
  });
  log('session', sid);
  const ctx = { app, page, log, sid };
  await phaseSections(ctx);
});
