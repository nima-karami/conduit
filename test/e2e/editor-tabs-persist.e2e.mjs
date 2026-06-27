/**
 * editor-tabs-persist — restore open editor tabs across a real restart (FULL).
 *
 * Crosses renderer → host → docs.json → renderer, which the mock preview shell can't exercise.
 * Two launches share ONE user-data dir (like durability.e2e.mjs):
 *   1. Open a session in a temp git repo with a.txt/b.txt; pin a.txt (double-click) and leave
 *      b.txt as the active preview (single-click). Close the app (before-quit sync flush).
 *   2. Relaunch on the SAME user-data dir. Assert the session restored AND its tabs restored:
 *      a.txt permanent (not .tab--preview), b.txt present as .tab--preview and active.
 *
 * See docs/specs/2026-06-27-editor-tab-behavior.md §3.2/§3.3 (D2/D3/D5).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  closeApp,
  loadPlaywright,
  makeLog,
  openSession,
  REPO,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[editor-tabs-persist] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('editor-tabs-persist');

// A git repo so the explorer/session behave exactly like a real project.
const repo = mkdtempSync(join(tmpdir(), 'conduit-tabs-repo-'));
for (const f of ['a.txt', 'b.txt']) writeFileSync(join(repo, f), `${f}\n`);
try {
  execFileSync('git', ['init', '-q'], { cwd: repo });
} catch {
  /* git absent — the scenario still works without a repo */
}
const repoArg = repo.replace(/\\/g, '/');

// SHARED user-data dir across both launches so docs.json + sessions.json persist.
const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-tabs-ud-'));
const { _electron } = loadPlaywright();
const require = createRequire(import.meta.url);
const electronPath = require('electron');

async function launch() {
  // Launch against the conduit REPO (like durability/launchApp); the temp git repo is opened as
  // a session via openSession. Passing a foreign dir as the launch arg/cwd stalls window load.
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  return { app, page };
}

const tabInfo = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.tabbar [role="tab"]')).map((el) => ({
      title: el.querySelector('span')?.textContent ?? '',
      preview: el.classList.contains('tab--preview'),
      active: el.classList.contains('tab--active') || el.getAttribute('aria-selected') === 'true',
    })),
  );

let firstApp;
let secondApp;
try {
  // ── Launch 1: open tabs, pin a.txt, preview b.txt ────────────────────────────
  const first = await launch();
  firstApp = first.app;
  const { page: page1 } = first;

  const sid = await openSession(page1, { path: repoArg });
  assert(sid, 'no session id from openSession');
  log('launch 1: session', sid);

  await page1.click('.rtab:has-text("Files")');
  await page1.waitForSelector('.filerow__name', { timeout: 20000 });
  const row1 = (name) => page1.locator('.filerow', { hasText: name }).first();

  // Double-click a.txt → permanent tab.
  await row1('a.txt').dblclick();
  await page1.waitForFunction(
    () => {
      const t = document.querySelectorAll('.tabbar [role="tab"]');
      return t.length === 1 && !t[0].classList.contains('tab--preview');
    },
    null,
    { timeout: 10000 },
  );
  // Single-click b.txt → preview tab (active), beside the permanent a.txt.
  await row1('b.txt').click();
  await page1.waitForFunction(
    () => {
      const t = Array.from(document.querySelectorAll('.tabbar [role="tab"]'));
      return t.length === 2 && t.some((x) => x.querySelector('span')?.textContent === 'b.txt');
    },
    null,
    { timeout: 10000 },
  );
  const tabs1 = await tabInfo(page1);
  assert(tabs1.length === 2, `launch 1: expected 2 tabs, got ${tabs1.length}`);
  const a1 = tabs1.find((t) => t.title === 'a.txt');
  const b1 = tabs1.find((t) => t.title === 'b.txt');
  assert(a1 && !a1.preview, 'launch 1: a.txt should be permanent');
  assert(b1?.preview, 'launch 1: b.txt should be a preview tab');
  log('launch 1: a.txt permanent + b.txt preview ✓');

  // Let the debounced persistDocs land before closing.
  await page1.waitForTimeout(800);
  const docsPath = join(userDataDir, 'docs.json');
  assert(existsSync(docsPath), 'docs.json was not written');
  const savedDocs = JSON.parse(readFileSync(docsPath, 'utf8'));
  log('docs.json on disk:', JSON.stringify(savedDocs));
  assert(
    Array.isArray(savedDocs.docs) && savedDocs.docs.length === 2,
    `docs.json should hold 2 docs, got ${JSON.stringify(savedDocs.docs)}`,
  );

  await closeApp(firstApp, page1);
  firstApp = null;
  log('launch 1 closed ✓');

  // ── Launch 2: tabs restore for the restored session ──────────────────────────
  const second = await launch();
  secondApp = second.app;
  const { page: page2 } = second;
  await tapBridge(page2);

  // Wait for the session to restore (stale) — its tabs hang off it.
  await page2.waitForFunction((id) => (window.__sessions || []).some((s) => s.id === id), sid, {
    timeout: 45000,
  });
  // Launching the app against a folder also auto-opens a session for it, which becomes active —
  // so select our restored session (unique temp-repo name) to surface its tabs, exactly as a
  // user with several sessions would click the one they want.
  const repoName = repoArg.split('/').filter(Boolean).pop();
  await page2.waitForSelector(`.session:has-text("${repoName}")`, { timeout: 20000 });
  await page2.locator('.session', { hasText: repoName }).first().click();
  // The selected restored session's tabs should render in the strip.
  await page2.waitForFunction(
    () => document.querySelectorAll('.tabbar [role="tab"]').length === 2,
    null,
    { timeout: 20000 },
  );
  // b.txt was the active preview at quit → it should restore as the active tab. switchSession
  // resolves activeBySession a render after the session is selected, so wait for it to settle.
  await page2
    .waitForFunction(
      () => {
        const t = Array.from(document.querySelectorAll('.tabbar [role="tab"]'));
        const b = t.find((x) => x.querySelector('span')?.textContent === 'b.txt');
        return (
          !!b && (b.classList.contains('tab--active') || b.getAttribute('aria-selected') === 'true')
        );
      },
      null,
      { timeout: 10000 },
    )
    .catch(() => {
      throw new Error('b.txt did not become active');
    });
  const tabs2 = await tabInfo(page2);
  log('launch 2 tabs:', JSON.stringify(tabs2));
  assert(tabs2.length === 2, `launch 2: expected 2 restored tabs, got ${tabs2.length}`);
  const a2 = tabs2.find((t) => t.title === 'a.txt');
  const b2 = tabs2.find((t) => t.title === 'b.txt');
  assert(a2 && !a2.preview, 'launch 2: a.txt must restore as a permanent (non-preview) tab');
  assert(b2?.preview, 'launch 2: b.txt must restore as a preview tab');
  assert(b2?.active, 'launch 2: b.txt must restore as the ACTIVE tab');
  log('PASS: a.txt permanent + b.txt active preview restored across restart ✓');

  await closeApp(secondApp, page2);
  secondApp = null;

  log('PASS ✓ editor-tabs-persist: all assertions passed');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[editor-tabs-persist] FAIL ✗', e.message);
    process.exit(1);
  }
  console.error('[editor-tabs-persist] ERROR:', e?.message || e);
  try {
    if (firstApp) await firstApp.close();
  } catch {
    /* ignore */
  }
  try {
    if (secondApp) await secondApp.close();
  } catch {
    /* ignore */
  }
  process.exit(2);
}
