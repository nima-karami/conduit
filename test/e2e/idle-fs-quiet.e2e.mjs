/**
 * idle-fs-quiet — an idle project must not keep reporting itself changed. Conduit's own read-only
 * git calls (`git status` refreshes the index's stat cache and rewrites `.git/index`) used to wake
 * the project watcher, which re-ran `git status`, which rewrote the index: a self-sustaining
 * `fsChanged` loop (~2.8/s) that every feature hanging work off `fsChanged` multiplied. The
 * scenario watches the repo from outside the app too, so a failure names the paths being written.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

const SETTLE_MS = 4000;
const WINDOW_MS = 10000;
// A handful covers a stray trailing refresh from the session opening; the loop produced ~28.
const MAX_IDLE_EVENTS = 2;

runScenario('idle-fs-quiet', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-idle-fs-'));
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'e2e@conduit.test');
  git(root, 'config', 'user.name', 'e2e');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  // A dirty tree, staged and unstaged, so the app has real status/numstat work to do.
  writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
  git(root, 'add', 'a.ts');
  writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.waitForTimeout(SETTLE_MS);

  const written = new Map();
  const outside = watch(root, { recursive: true }, (_e, f) => {
    const k = String(f ?? '').replace(/\\/g, '/');
    written.set(k, (written.get(k) ?? 0) + 1);
  });
  await page.evaluate(() => {
    window.__fsChanged = 0;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'fsChanged') window.__fsChanged += 1;
    });
  });
  await page.waitForTimeout(WINDOW_MS);
  const count = await page.evaluate(() => window.__fsChanged);
  outside.close();

  const paths = JSON.stringify(Object.fromEntries(written));
  log(`idle ${WINDOW_MS / 1000}s: fsChanged=${count}; paths written in the repo: ${paths}`);
  assert(
    count <= MAX_IDLE_EVENTS,
    `an idle project emitted ${count} fsChanged in ${WINDOW_MS / 1000}s; paths: ${paths}`,
  );
});
