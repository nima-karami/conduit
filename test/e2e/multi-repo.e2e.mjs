/**
 * Multi-repo awareness (real-app smoke). Crosses the host/IPC boundary (detection runs
 * host-side; the active-repo state rides the `state` broadcast), so it must drive the REAL
 * app, not the mock preview. Verifies, against the real renderer + host, that a folder
 * containing two git repos:
 *  - shows the repo picker listing both;
 *  - picking a repo pins it and re-scopes the host's active repo (asserted via bridge state);
 *  - **Changes follow the active repo** — the renderer re-requests the project scoped to the
 *    pinned repo, so the change list shows that repo's dirty file and not the other's;
 *  - **History follows the active repo** — git:history resolves against the pinned repo, so
 *    its commit subjects appear and the other repo's don't;
 *  - a pin survives an auto-follow trigger (a `repo:context` for another repo is ignored).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openChangesTab, openSession, runScenario } from './harness.mjs';

const PER_REPO_TITLE = 'Works on one repo. Right-click a repo header, or switch to Active repo.';

function makeRepo(dir, file, committed, working, subject) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, file), committed);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', subject], { cwd: dir });
  writeFileSync(join(dir, file), working); // leave an uncommitted change
}

runScenario('multi-repo', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-multirepo-'));
  // Distinct dirty file + commit subject per repo so Changes/History are attributable.
  makeRepo(join(root, 'repo-a'), 'a.txt', 'a1\n', 'a2\n', 'alpha-commit');
  makeRepo(join(root, 'repo-b'), 'b.txt', 'b1\n', 'b2\n', 'beta-commit');

  // Capture the latest project (Changes) + history results for assertions. Subscribe BEFORE the
  // session opens: auto-follow already makes repo-a active on open, so pinning it changes no
  // scope and requests nothing new — the repo-a project is the one that arrives during the open.
  // (This passed only while an idle repo's fsChanged loop kept re-sending the project; 763cd6c.)
  await page.evaluate(() => {
    window.__proj = null;
    window.__hist = null;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'project') window.__proj = m;
      if (m.type === 'git:historyResult') window.__hist = m;
    });
  });

  const sid = await openSession(page, { path: root.replace(/\\/g, '/') });

  // Detection runs host-side after open; wait for the two repos to land on the session state.
  await page.waitForFunction(
    (id) => ((window.__sessions || []).find((x) => x.id === id)?.repos?.length ?? 0) >= 2,
    sid,
    { timeout: 20000 },
  );
  log('two sub-repos detected ✓');

  // The reply to the re-request the repo set triggers carries every repo, in display order, each
  // listing only its own dirty file.
  await page.waitForFunction(() => (window.__proj?.repoChanges?.length ?? 0) === 2, null, {
    timeout: 20000,
  });
  const perRepo = await page.evaluate(() =>
    window.__proj.repoChanges.map((r) => ({
      root: r.root.replace(/\\/g, '/'),
      name: r.name,
      paths: r.changes.map((c) => c.path),
    })),
  );
  assert(
    perRepo[0].root.endsWith('/repo-a') && perRepo[1].root.endsWith('/repo-b'),
    `repoChanges in display order (repo-a, repo-b): ${JSON.stringify(perRepo)}`,
  );
  assert(
    perRepo[0].name === 'repo-a' && perRepo[1].name === 'repo-b',
    `repoChanges names are the repo basenames: ${JSON.stringify(perRepo)}`,
  );
  assert(
    JSON.stringify(perRepo[0].paths) === '["a.txt"]' &&
      JSON.stringify(perRepo[1].paths) === '["b.txt"]',
    `each repo lists only its own file: ${JSON.stringify(perRepo)}`,
  );
  log('project.repoChanges lists repo-a (a.txt) then repo-b (b.txt) ✓');

  // The All view (the default): one head per repo in display order, each list holding only its
  // own repo's file (docs/specs/2026-09-23-mf-changes.md §2.2).
  await openChangesTab(page);
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.repo-head').length === 2 &&
      document.querySelectorAll('.repo-head__list .change').length === 2,
    null,
    { timeout: 15000 },
  );
  const heads = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.repo-head'), (h) => {
      const list = h.nextElementSibling?.classList.contains('repo-head__list')
        ? h.nextElementSibling
        : null;
      return {
        name: h.querySelector('.repo-head__name')?.textContent ?? '',
        files: list ? Array.from(list.querySelectorAll('.change__file'), (f) => f.textContent) : [],
      };
    }),
  );
  assert(
    JSON.stringify(heads) ===
      JSON.stringify([
        { name: 'repo-a', files: ['a.txt'] },
        { name: 'repo-b', files: ['b.txt'] },
      ]),
    `All view: repo-a then repo-b, each listing only its own file: ${JSON.stringify(heads)}`,
  );
  log('All view: two repo heads in display order, each with only its own file ✓');

  // The header ··· holds the View radio pair; the per-repo bulk items are listed disabled (L11).
  await page.click('.changes__kebab');
  await page.waitForSelector('.ctxmenu [role="menuitemradio"]', {
    state: 'visible',
    timeout: 5000,
  });
  const kebab = await page.evaluate(() => {
    const menu = document.querySelector('.ctxmenu');
    const item = (label) =>
      Array.from(menu?.querySelectorAll('.ctxmenu__item') ?? []).find(
        (b) => b.textContent?.trim() === label,
      );
    const state = (label) => {
      const b = item(label);
      return b
        ? {
            disabled: b.disabled && b.getAttribute('aria-disabled') === 'true',
            title: b.parentElement?.getAttribute('title') ?? '',
          }
        : null;
    };
    return {
      radios: Array.from(menu?.querySelectorAll('[role="menuitemradio"]') ?? [], (r) => ({
        label: r.textContent?.trim(),
        checked: r.getAttribute('aria-checked'),
      })),
      stageAll: state('Stage all'),
      perRepo: ['Stash changes', 'Pop stash', 'Discard all changes'].map(state),
    };
  });
  assert(
    JSON.stringify(kebab.radios) ===
      JSON.stringify([
        { label: 'All repos', checked: 'true' },
        { label: 'Active repo', checked: 'false' },
      ]),
    `header ··· shows the View radio pair, All checked: ${JSON.stringify(kebab.radios)}`,
  );
  assert(kebab.stageAll && !kebab.stageAll.disabled, 'All view: Stage all fans out, enabled');
  assert(
    kebab.perRepo.every((x) => x?.disabled && x.title === PER_REPO_TITLE),
    `All view: Stash / Pop / Discard all disabled with the per-repo title: ${JSON.stringify(kebab.perRepo)}`,
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });
  log('header ··· : 2 menuitemradio; Stash / Pop / Discard disabled with the per-repo title ✓');

  const picker = page.locator('.repo-picker__trigger');
  await picker.waitFor({ state: 'visible', timeout: 10000 });

  // The picker lists both repos.
  await picker.click();
  await page.locator('.repo-picker-menu').waitFor({ state: 'visible', timeout: 10000 });
  const names = await page.locator('.repo-picker-menu__name').allInnerTexts();
  assert(
    names.some((n) => n.includes('repo-a')),
    'menu lists repo-a',
  );
  assert(
    names.some((n) => n.includes('repo-b')),
    'menu lists repo-b',
  );
  await page.keyboard.press('Escape');
  log('picker lists repo-a + repo-b ✓');

  // The picker and the branch chip are two triggers in one band and must read as one fixture.
  // The picker's wrapper had no height, so the trigger's `height: 100%` resolved against an
  // auto-height parent and shrink-wrapped its text — 19px beside a 37px branch chip.
  const chips = await page.evaluate(() => {
    const box = (s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        h: Math.round(r.height),
        top: Math.round(r.top),
        radius: cs.borderTopLeftRadius,
        border: cs.borderTopWidth,
      };
    };
    return { picker: box('.repo-picker__trigger'), branch: box('.git-indicator__branch') };
  });
  assert(chips.picker && chips.branch, 'both the repo picker and the branch chip should render');
  assert(
    chips.picker.h === chips.branch.h && chips.picker.top === chips.branch.top,
    `picker and branch chip must share the band's height and baseline — picker ${JSON.stringify(
      chips.picker,
    )} vs branch ${JSON.stringify(chips.branch)}`,
  );
  assert(
    chips.picker.radius === chips.branch.radius && chips.picker.border === chips.branch.border,
    `picker and branch chip must wear the same field treatment — picker ${JSON.stringify(
      chips.picker,
    )} vs branch ${JSON.stringify(chips.branch)}`,
  );
  log(`picker and branch chip match: ${chips.picker.h}px, radius ${chips.picker.radius} ✓`);

  // Pin a repo via the picker, then assert BOTH Changes and History re-scope to it.
  const expectActiveRepo = async (name, file, otherFile, subject, otherSubject) => {
    await picker.click();
    await page.locator('.repo-picker-menu').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('.repo-picker-menu__row', { hasText: name }).first().click();

    // 1) Host state pins + re-scopes the active repo.
    await page.waitForFunction(
      ({ id, n }) => {
        const s = (window.__sessions || []).find((x) => x.id === id);
        return (
          !!s && s.repoPinned === true && (s.activeRepoRoot || '').replace(/\\/g, '/').endsWith(n)
        );
      },
      { id: sid, n: name },
      { timeout: 10000 },
    );

    // 2) Changes follow: the renderer auto-re-requests the project scoped to the pinned repo.
    await page.waitForFunction(
      ({ f, of }) => {
        const paths = (window.__proj?.changes || []).map((c) => c.path);
        return paths.includes(f) && !paths.includes(of);
      },
      { f: file, of: otherFile },
      { timeout: 10000 },
    );

    // 3) History follows: git:history resolves against the pinned repo (host gitRoot).
    await page.evaluate(
      (id) => window.agentDeck.post({ type: 'git:history', sessionId: id, requestId: Date.now() }),
      sid,
    );
    await page.waitForFunction(
      ({ subj, other }) => {
        const subs = (window.__hist?.commits || []).map((c) => c.subject);
        return subs.includes(subj) && !subs.includes(other);
      },
      { subj: subject, other: otherSubject },
      { timeout: 10000 },
    );
  };

  await expectActiveRepo('repo-a', 'a.txt', 'b.txt', 'alpha-commit', 'beta-commit');
  log('repo-a active → Changes show a.txt, History shows alpha-commit ✓');

  // Stage a.txt through the Changes UI. This is the path the fix repaired: the git action
  // must run in the ACTIVE repo (repo-a), not the opened parent, and the post-action refresh
  // must stay scoped to repo-a. If it ran in the parent, a.txt would never become staged.
  await page.locator('.rtab', { hasText: 'Changes' }).click();
  // The row actions are pointer-events:none until the row is hovered (they overlay the diff-stat,
  // so an ungated overlay would make Discard hittable with nothing drawn). Playwright hit-tests
  // the click point BEFORE moving the mouse, so clicking cold resolves to the row text underneath
  // and never lands — hover the row first, the way a real pointer reaches the button.
  const changeRow = page.locator('.change', { hasText: 'a.txt' });
  await changeRow.hover();
  await changeRow.getByRole('button', { name: 'Stage' }).click();
  await page.waitForFunction(
    () => (window.__proj?.changes || []).some((c) => c.path === 'a.txt' && c.staged === true),
    null,
    { timeout: 10000 },
  );
  log('staged a.txt via the Changes UI → action ran in repo-a, refresh stayed scoped ✓');

  await expectActiveRepo('repo-b', 'b.txt', 'a.txt', 'beta-commit', 'alpha-commit');
  log('repo-b active → Changes + History flipped to repo-b ✓');

  // The active list and repo-b's entry in the same reply are one computation, so they match.
  await page.waitForFunction(
    () => {
      const p = window.__proj;
      const b = p?.repoChanges?.find((r) => r.root.replace(/\\/g, '/').endsWith('/repo-b'));
      return (
        !!b &&
        p.repoChanges.length === 2 &&
        JSON.stringify(p.changes) === JSON.stringify(b.changes) &&
        p.changes.some((c) => c.path === 'b.txt')
      );
    },
    null,
    { timeout: 10000 },
  );
  log('pinned repo-b: project.changes equals its repoChanges entry ✓');

  // A pin survives an auto-follow trigger: a repo:context for repo-a must be ignored while pinned.
  await page.evaluate(
    ({ id, p }) => window.agentDeck.post({ type: 'repo:context', sessionId: id, path: p }),
    { id: sid, p: join(root, 'repo-a', 'a.txt').replace(/\\/g, '/') },
  );
  await page.waitForTimeout(400);
  const stillB = await page.evaluate((id) => {
    const s = (window.__sessions || []).find((x) => x.id === id);
    return (
      !!s &&
      s.repoPinned === true &&
      (s.activeRepoRoot || '').replace(/\\/g, '/').endsWith('repo-b')
    );
  }, sid);
  assert(stillB, 'pin holds across an auto-follow trigger (repo:context ignored while pinned)');

  // The git band (repo picker) must stay visible over the git-scoped History view, so the
  // active repo is visible — and still switchable — while History is open.
  await page.locator('.git-indicator__history').first().click();
  await page.locator('.gh').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('.repo-picker__trigger').waitFor({ state: 'visible', timeout: 5000 });
  log('repo picker stays visible over the History view ✓');

  log('PASS ✓ multi-repo: picker, pin, Changes + History both follow the active repo');
});
