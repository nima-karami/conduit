/**
 * Repo re-scan on project refresh (real-app smoke). Crosses the host/IPC boundary: a repo
 * (or git worktree) created on disk while the session is already open must be picked up
 * without a restart. The host previously re-detected sub-repos only on open and via the
 * fs-watch — and the single live watch follows the ACTIVE session's cwd, so a repo created
 * while another session is focused (or, in the bug report, as a sibling of the cwd) was never
 * seen, leaving the repo picker stale until restart.
 *
 * Isolation: a SECOND session is opened so it becomes active — the live fs-watch follows it,
 * NOT the first session's folder. repo-c is then created under the first session's root while
 * unwatched, so the fs-watch never fires for it. Only the focus/cwd `requestProject` re-scan
 * (the fix) can recover it. Without the fix this scenario fails (repo-c never lands on state).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

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
  makeRepo(join(root, 'repo-a'));
  makeRepo(join(root, 'repo-b'));
  const openedPath = root.replace(/\\/g, '/');

  const sid1 = await openSession(page, { path: openedPath });
  await page.waitForFunction(
    (id) => ((window.__sessions || []).find((x) => x.id === id)?.repos?.length ?? 0) >= 2,
    sid1,
    { timeout: 20000 },
  );
  assert((await repoNames(page, sid1)).length === 2, 'starts with exactly the two seeded repos');
  log('two repos detected on open ✓');

  // Open a SECOND session elsewhere — it becomes active, so the single live fs-watch follows
  // it, not `root`. (sibling temp dir: neither contains the other.)
  const other = mkdtempSync(join(tmpdir(), 'conduit-other-'));
  await openSession(page, { path: other.replace(/\\/g, '/') });
  await page.waitForTimeout(600); // let the watch re-point to the second session

  // Create a third repo under the FIRST session's root while it is unwatched.
  makeRepo(join(root, 'repo-c'));
  await page.waitForTimeout(800); // a stray fs-watch event would land here (there should be none)

  // Fire the refresh the renderer posts for the first session on focus/cwd-change. The fix
  // re-scans sub-repos for the session whose projectPath contains this path → recovers repo-c.
  await page.evaluate(
    (p) => window.agentDeck.post({ type: 'requestProject', path: p }),
    openedPath,
  );

  await page.waitForFunction(
    (id) => {
      const names = ((window.__sessions || []).find((x) => x.id === id)?.repos ?? []).map(
        (r) => r.name,
      );
      return names.includes('repo-c') && names.length >= 3;
    },
    sid1,
    { timeout: 15000 },
  );
  log('repo-c picked up after a project refresh (no restart) ✓');

  log('PASS ✓ repo-rescan: a repo added while open is detected on the next project refresh');
});
