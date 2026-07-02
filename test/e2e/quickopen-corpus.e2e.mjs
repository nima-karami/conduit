/**
 * Quick-open (Mod+P) corpus source (real-app smoke).
 *
 * The omni-bar file corpus is served by the `searchFiles` IPC, now backed by the shared
 * project index (`git ls-files --cached --others --exclude-standard`) instead of the
 * bounded BFS `walkFiles`. This seeds a git repo with >4000 files plus a git-ignored tree,
 * posts `searchFiles`, and asserts the reply:
 *   - returns MORE than walkFiles' 4000-entry cap (a late file that the cap would have
 *     dropped is present), and
 *   - excludes the git-ignored file (which the old fixed IGNORED set would have surfaced).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario, tapBridge } from './harness.mjs';

const FILE_COUNT = 4100; // walkFiles' DEFAULT_CAP is 4000 — comfortably past it

function seedRepo() {
  const root = mkdtempSync(join(tmpdir(), 'quickopen-corpus-'));
  const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(root, '.gitignore'), 'vendor/\n');
  mkdirSync(join(root, 'src'));
  for (let i = 0; i < FILE_COUNT; i++) {
    writeFileSync(join(root, 'src', `file${String(i).padStart(4, '0')}.ts`), '');
  }
  mkdirSync(join(root, 'vendor'));
  writeFileSync(join(root, 'vendor', 'ignored.js'), '// git-ignored');
  return root;
}

runScenario('quickopen-corpus', async ({ page, log }) => {
  const root = seedRepo();
  log(`seeded ${FILE_COUNT} files + a git-ignored vendor tree at`, root);
  await openSession(page, { path: root });
  await tapBridge(page);

  const res = await page.evaluate(
    (r) =>
      new Promise((resolve) => {
        window.agentDeck.subscribe((m) => {
          if (m.type === 'searchResults' && m.root === r) resolve(m);
        });
        window.agentDeck.post({ type: 'searchFiles', root: r, query: '' });
      }),
    root.replace(/\\/g, '/'),
  );

  const rels = res.results.map((h) => h.rel);
  assert(
    rels.length > 4000,
    `expected >4000 results (uncapped git index), got ${rels.length} — 4000-cap BFS would truncate`,
  );
  log(`corpus size ${rels.length} (> 4000 cap) ✓`);

  assert(
    rels.includes(`src/file${String(FILE_COUNT - 1).padStart(4, '0')}.ts`),
    'a late file the 4000-cap BFS would drop should be present',
  );
  log('late file present ✓');

  assert(
    !rels.some((r) => r.startsWith('vendor/')),
    'git-ignored vendor/ files must not appear in the quick-open corpus',
  );
  log('git-ignored tree excluded ✓');
});
