/**
 * mcp-open-diff — open_diff end to end (spec docs/specs/2026-11-05-open-diff.md).
 * The tool accepts a unified diff as patch text or a .diff/.patch file path and shows it in the
 * existing Review view, without applying anything to disk or reading full files.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeTab, assertLanded, hearLive, parkKeyboard } from './conduit-mcp-app-helpers.mjs';
import {
  callTool,
  fakeAgentProfile,
  openFake,
  sessions,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, phase, removeDir, runScenario } from './harness.mjs';

const errCode = (r) => r?.error?.code;
const errMsg = (r) => r?.error?.message ?? '';
const REVIEW = 'review:@review';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const waitActiveTab = async (page, id) =>
  assert(
    await until(async () => (await activeTab(page)) === id, 10_000),
    `active tab is ${await activeTab(page)}, not ${id}`,
  );

const sourceLabel = (page) =>
  page.evaluate(
    () =>
      document.querySelector('.review .review__source .gh__reffilter-label')?.textContent ?? null,
  );

const cardPaths = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.rcard[data-root=""]')).map((c) =>
      c.getAttribute('data-path'),
    ),
  );

const PATCH_TWO_FILES = `diff --git a/foo.txt b/foo.txt
index 1111111..2222222 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,3 +1,3 @@
 alpha
-beta
+gamma
 delta
diff --git a/bar.txt b/bar.txt
index 3333333..4444444 100644
--- a/bar.txt
+++ b/bar.txt
@@ -1,2 +1,3 @@
 one
 two
+three
`;

const PATCH_RENAME = `diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
index 1111111..2222222 100644
--- a/old.txt
+++ b/new.txt
@@ -1,2 +1,2 @@
 hello
-world
+friend
`;

await runScenario(
  'mcp-open-diff',
  async ({ page, log }) => {
    await tapMcp(page);
    const root = mkdtempSync(join(tmpdir(), 'conduit-mcp-open-diff-'));
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const a = await openFake(page, home);

    phase('patch text opens in review');
    await hearLive(page);
    await parkKeyboard(page, 'terminal');
    const opened = await callTool(page, a.sessionId, 'open_diff', { patch: PATCH_TWO_FILES });
    assert(
      same(opened, { opened: 'review', source: { kind: 'patch' } }),
      `open_diff: ${JSON.stringify(opened)}`,
    );
    await waitActiveTab(page, REVIEW);
    await assertLanded(page, '.review', `${a.handle} opened Review`, 'terminal → open_diff');
    assert(
      await until(async () => (await sourceLabel(page)).startsWith('Diff from'), 10_000),
      `Review shows "${await sourceLabel(page)}", not a diff-from label`,
    );
    assert(
      await until(async () => (await cardPaths(page)).length >= 2, 10_000),
      `Review never showed both files: ${JSON.stringify(await cardPaths(page))}`,
    );
    const paths = await cardPaths(page);
    assert(paths.includes('foo.txt'), `foo.txt missing from ${JSON.stringify(paths)}`);
    assert(paths.includes('bar.txt'), `bar.txt missing from ${JSON.stringify(paths)}`);
    log('open_diff with patch text lands in Review and shows both files ✓');

    phase('custom title');
    const titled = await callTool(page, a.sessionId, 'open_diff', {
      patch: PATCH_TWO_FILES,
      title: 'My diff',
    });
    assert(titled?.opened === 'review', `titled: ${JSON.stringify(titled)}`);
    assert(
      await until(async () => (await sourceLabel(page)) === 'My diff', 10_000),
      `Review shows "${await sourceLabel(page)}", not "My diff"`,
    );
    log('open_diff title is shown in the Review source label ✓');

    phase('patch file path');
    const patchFile = join(home, 'changes.diff');
    writeFileSync(patchFile, PATCH_TWO_FILES);
    const fromFile = await callTool(page, a.sessionId, 'open_diff', { patch_file: 'changes.diff' });
    assert(
      same(fromFile, { opened: 'review', source: { kind: 'patch' } }),
      `patch_file: ${JSON.stringify(fromFile)}`,
    );
    await waitActiveTab(page, REVIEW);
    assert(
      await until(async () => (await cardPaths(page)).includes('foo.txt'), 10_000),
      `patch_file never rendered: ${JSON.stringify(await cardPaths(page))}`,
    );
    log('open_diff with patch_file reads the .diff and shows it ✓');

    phase('invalid input');
    const notDiff = await callTool(page, a.sessionId, 'open_diff', { patch: 'this is not a diff' });
    assert(errCode(notDiff) === 'invalid_input', `non-diff: ${JSON.stringify(notDiff)}`);
    assert(errMsg(notDiff).includes('unified diff'), `non-diff message: ${errMsg(notDiff)}`);

    const neither = await callTool(page, a.sessionId, 'open_diff', {});
    assert(errCode(neither) === 'invalid_args', `neither: ${JSON.stringify(neither)}`);

    const both = await callTool(page, a.sessionId, 'open_diff', {
      patch: PATCH_TWO_FILES,
      patch_file: 'changes.diff',
    });
    assert(errCode(both) === 'invalid_args', `both: ${JSON.stringify(both)}`);

    writeFileSync(join(home, 'notes.txt'), PATCH_TWO_FILES);
    const wrongExt = await callTool(page, a.sessionId, 'open_diff', { patch_file: 'notes.txt' });
    assert(errCode(wrongExt) === 'invalid_args', `wrong ext: ${JSON.stringify(wrongExt)}`);
    log('invalid inputs are refused with the right error codes ✓');

    phase('rename preserved');
    const renamed = await callTool(page, a.sessionId, 'open_diff', { patch: PATCH_RENAME });
    assert(renamed?.opened === 'review', `rename: ${JSON.stringify(renamed)}`);
    await waitActiveTab(page, REVIEW);
    assert(
      await until(async () => (await cardPaths(page)).includes('new.txt'), 10_000),
      `rename target missing: ${JSON.stringify(await cardPaths(page))}`,
    );
    const renameBadge = await page.evaluate(
      () =>
        document.querySelector('.rcard[data-root=""][data-path="new.txt"] .change__kind')
          ?.textContent ?? null,
    );
    assert(renameBadge?.includes('R'), `expected R badge, got ${renameBadge}`);
    log('rename diffs show the new path with a rename badge ✓');

    phase('cleanup');
    for (const s of await sessions(page)) {
      await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
    }
    assert(
      await until(async () => (await sessions(page)).length === 0, 15_000),
      'sessions survived kill',
    );
    await removeDir(root, { budgetMs: 10_000 });
  },
  { userDataDir: fakeAgentProfile('open-diff') },
);
