/**
 * Repo re-scan on project refresh (real-app smoke). Crosses the host/IPC boundary: a repo
 * (or git worktree) created on disk while the session is already open must be picked up
 * without a restart. The host previously re-detected sub-repos only on open and via the
 * fs-watch — and the single live watch follows the ACTIVE session's cwd, so a repo created
 * while another session is focused (or, in the bug report, as a sibling of the cwd) was never
 * seen, leaving the repo picker stale until restart.
 *
 * Isolation: the first session's root holds no repo, so it is not armed for repo tracking (a
 * hidden session stays watched only while it has registered repos). A SECOND session is then
 * opened so it becomes active and the window's watch follows it. repo-c is created under the
 * first session's root while that root is outside every watched folder, so no fs event can
 * report it. Only the focus/cwd `requestProject` re-scan can recover it.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openChangesTab, openSession, runScenario } from './harness.mjs';

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'f.txt'), 'x\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

const repoNames = (page, id) =>
  page.evaluate(
    (x) => ((window.__sessions || []).find((s) => s.id === x)?.repos ?? []).map((r) => r.name),
    id,
  );

runScenario('repo-rescan', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-rescan-'));
  writeFileSync(join(root, 'notes.txt'), 'not a repo\n');
  const openedPath = root.replace(/\\/g, '/');

  // Snapshots are pushed per session; a session hidden while its repo set changes is re-sent in
  // full when it is shown again, so the tap must outlive the second session.
  await page.evaluate(() => {
    window.__deltas = {};
    window.agentDeck.subscribe((m) => {
      if (m.type !== 'repoDelta') return;
      const next = m.full ? {} : { ...(window.__deltas[m.sessionId] ?? {}) };
      for (const [r, snap] of Object.entries(m.repos)) {
        if (snap.removed) delete next[r];
        else next[r] = snap;
      }
      window.__deltas[m.sessionId] = next;
    });
  });

  const sid1 = await openSession(page, { path: openedPath });
  await page.waitForFunction(
    (id) => (window.__sessions || []).find((x) => x.id === id)?.repos !== undefined,
    sid1,
    { timeout: 20000 },
  );
  // No repo to wait on, so give the open scan of a one-file folder time to finish; repo-c must
  // not exist yet when it runs.
  await page.waitForTimeout(800);
  assert((await repoNames(page, sid1)).length === 0, 'starts with no registered repo');
  log('no repo detected on open ✓');

  // Open a SECOND session elsewhere — it becomes active, so the single live fs-watch follows
  // it, not `root`. (sibling temp dir: neither contains the other.)
  const other = mkdtempSync(join(tmpdir(), 'conduit-other-'));
  await openSession(page, { path: other.replace(/\\/g, '/') });
  await page.waitForTimeout(600); // let the watch re-point to the second session

  // Create a repo under the FIRST session's root while it is outside every watched folder.
  makeRepo(join(root, 'repo-c'));
  await page.waitForTimeout(800); // a stray fs-watch event would land here (there should be none)

  // Fire the refresh the renderer posts for the first session on focus/cwd-change. The fix
  // re-scans sub-repos for the session whose home contains this path → recovers repo-c.
  await page.evaluate(
    (p) => window.agentDeck.post({ type: 'requestProject', path: p }),
    openedPath,
  );

  await page.waitForFunction(
    (id) => {
      const names = ((window.__sessions || []).find((x) => x.id === id)?.repos ?? []).map(
        (r) => r.name,
      );
      return names.includes('repo-c');
    },
    sid1,
    { timeout: 15000 },
  );
  log('repo-c picked up after a project refresh (no restart) ✓');

  // Showing the first session again pushes its snapshots; repo-c's must arrive with the others.
  await page.locator(`.session[data-sessionid="${sid1}"] .session__name`).first().click();
  const snapshotNames = () =>
    page.evaluate(
      (id) =>
        ((window.__sessions || []).find((x) => x.id === id)?.repos ?? [])
          .filter((r) => window.__deltas[id]?.[r.root] !== undefined)
          .map((r) => r.name),
      sid1,
    );
  await page
    .waitForFunction(
      (id) => {
        const repos = (window.__sessions || []).find((x) => x.id === id)?.repos ?? [];
        return (
          repos.length === 1 && repos.every((r) => window.__deltas[id]?.[r.root] !== undefined)
        );
      },
      sid1,
      { timeout: 15000 },
    )
    .catch(async (e) => {
      if (e?.name !== 'TimeoutError') throw e;
      assert(false, `repoDelta never covered repo-c: ${JSON.stringify(await snapshotNames())}`);
    });
  assert(
    JSON.stringify(await snapshotNames()) === '["repo-c"]',
    `the session's repoDelta snapshots include repo-c: ${JSON.stringify(await snapshotNames())}`,
  );
  log('repoDelta snapshot covers repo-c ✓');

  await openChangesTab(page);
  await page
    .waitForFunction(
      () =>
        Array.from(
          document.querySelectorAll('.repo-head .repo-head__name'),
          (n) => n.textContent,
        ).join(',') === 'repo-c',
      null,
      { timeout: 15000 },
    )
    .catch(async () => {
      const shown = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.repo-head .repo-head__name'), (n) => n.textContent),
      );
      assert(false, `All view shows a head for repo-c: ${JSON.stringify(shown)}`);
    });
  log("repo-c's head appears in the Changes tab's All view ✓");

  log('PASS ✓ repo-rescan: a repo added while open is detected on the next project refresh');
});
