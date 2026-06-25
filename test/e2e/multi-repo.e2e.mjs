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
import { assert, openSession, runScenario } from './harness.mjs';

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

  const sid = await openSession(page, { path: root.replace(/\\/g, '/') });

  // Capture the latest project (Changes) + history results for assertions.
  await page.evaluate(() => {
    window.__proj = null;
    window.__hist = null;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'project') window.__proj = m;
      if (m.type === 'git:historyResult') window.__hist = m;
    });
  });

  // Detection runs host-side after open; wait for the two repos to land on the session state.
  await page.waitForFunction(
    (id) => ((window.__sessions || []).find((x) => x.id === id)?.repos?.length ?? 0) >= 2,
    sid,
    { timeout: 20000 },
  );
  log('two sub-repos detected ✓');

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
  await page
    .locator('.change', { hasText: 'a.txt' })
    .getByRole('button', { name: 'Stage' })
    .click();
  await page.waitForFunction(
    () => (window.__proj?.changes || []).some((c) => c.path === 'a.txt' && c.staged === true),
    null,
    { timeout: 10000 },
  );
  log('staged a.txt via the Changes UI → action ran in repo-a, refresh stayed scoped ✓');

  await expectActiveRepo('repo-b', 'b.txt', 'a.txt', 'beta-commit', 'alpha-commit');
  log('repo-b active → Changes + History flipped to repo-b ✓');

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

  log('PASS ✓ multi-repo: picker, pin, Changes + History both follow the active repo');
});
