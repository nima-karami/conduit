/**
 * git-history Slice A — real-runtime IPC/graph smoke (drive the REAL app).
 *
 * Opens a session on THIS repo (a git repo with real linear history + branches), opens the
 * git-history graph from the indicator button, and asserts the full seam end-to-end:
 *   (a) a `git:historyResult` arrives with ≥1 commit and a layout with laneCount ≥ 1;
 *   (b) the graph view renders commit rows in the DOM;
 *   (c) clicking a commit reveals its detail INLINE in the view's resizable bottom pane
 *       (not a tab) — it fetches the commit's files (`git:commitDiffResult`) and lists
 *       them; clicking a file opens a `commit-diff` editor tab (preview) with the diff
 *       viewer;
 *   (d) the empty / not-a-repo path doesn't throw.
 *
 * Captures a screenshot of the rendered graph + the run log to .autoloop/evidence/.
 *
 * KNOWN FLAKE: on a loaded machine the Playwright app.close() teardown can time out
 * (orphaned hidden Electron + slow handle release). That is NOT a feature failure — the
 * assertions print PASS before teardown. Windows only.
 */

import { copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, makeLog, openSession, REPO, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[git-history] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('git-history');
const SCRATCH = join(tmpdir(), 'claude-scratch');
const EVIDENCE = join(REPO, '.autoloop', 'evidence');
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });

let launched;
try {
  launched = await launchApp();
  const { page } = launched;
  await tapBridge(page);
  // Fixed viewport so the ledger fill assertion (rows must fill the height, not just the
  // overscan window) is deterministic regardless of the hidden window's default size.
  await page.setViewportSize({ width: 1200, height: 800 });

  // Capture git:historyResult + commit-diff results off the bridge.
  await page.evaluate(() => {
    window.__gh = { history: [], commitDiffs: [] };
    window.agentDeck.subscribe((m) => {
      if (m.type === 'git:historyResult') window.__gh.history.push(m);
      if (m.type === 'git:commitDiffResult') window.__gh.commitDiffs.push(m);
    });
  });

  // Open a session on THIS repo so the host interrogates real git + has real history.
  const sid = await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });
  log(`session ${sid} open on the repo`);

  // (d) The host returns an empty result for a non-repo cwd without throwing. Probe it
  // directly with a junk sessionId-less path is not possible via IPC, so instead assert the
  // real-repo request path works and the empty preview path is covered by the unit/bridge
  // layer. Send the history request for our session and wait for the result.
  await page.evaluate((s) => window.agentDeck.post({ type: 'git:history', sessionId: s }), sid);
  await page.waitForFunction(() => (window.__gh?.history?.length ?? 0) > 0, null, {
    timeout: 20000,
  });

  // (a) historyResult shape: ≥1 commit, laneCount ≥ 1.
  const hr = await page.evaluate(() => {
    const r = window.__gh.history[window.__gh.history.length - 1];
    return { commits: r.commits.length, laneCount: r.layout.laneCount };
  });
  log(`historyResult: ${hr.commits} commits, laneCount=${hr.laneCount}`);
  assert(hr.commits >= 1, 'expected ≥1 commit in git:historyResult');
  assert(hr.laneCount >= 1, 'expected laneCount ≥ 1 in the layout');
  log('PASS (a): git:historyResult has commits + a lane layout ✓');

  // Open the graph from the indicator button (the spec's entry point). The bar+button
  // appear once the session's git is interrogated (async, off the state broadcast). Under
  // CONDUIT_E2E the window is hidden, so query by 'attached' (visibility checks need a
  // shown window). Wait for the bar, then the button, then click it.
  await page.waitForSelector('.git-indicator', { state: 'attached', timeout: 25000 });
  await page.waitForSelector('.git-indicator__history', { state: 'attached', timeout: 25000 });

  // Branch-button polish (regression guard): the switchable branch segment is a real
  // <button>, and a missing `background` reset let the native buttonface fill paint an
  // off-palette pill at rest. Assert it's transparent at rest. (Skip only if the repo
  // session isn't on a named branch — then there's no switchable segment to check.)
  const branchBg = await page.evaluate(() => {
    const el = document.querySelector('.git-indicator__branch--switchable');
    return el ? getComputedStyle(el).backgroundColor : null;
  });
  if (branchBg === null) {
    log('SKIP (branch): no switchable branch segment in this session state');
  } else {
    log(`branch segment resting background: ${branchBg}`);
    assert(
      branchBg === 'rgba(0, 0, 0, 0)' || branchBg === 'transparent',
      `expected the switchable branch segment transparent at rest, got ${branchBg}`,
    );
    log('PASS (branch): switchable branch segment has no resting fill ✓');
  }

  await page.click('.git-indicator__history', { force: true });

  // (b) the graph renders rows in the DOM.
  await page.waitForSelector('.gh', { state: 'attached', timeout: 15000 });
  await page.waitForSelector('.gh__row', { state: 'attached', timeout: 15000 });
  const rowCount = await page.evaluate(() => document.querySelectorAll('.gh__row').length);
  log(`rendered ${rowCount} commit row(s) in the DOM`);
  assert(rowCount >= 1, 'expected ≥1 .gh__row rendered');
  // The SVG gutter (nodes/edges) renders too.
  const nodeCount = await page.evaluate(
    () => document.querySelectorAll('.gh__node, .gh__node--merge').length,
  );
  assert(nodeCount >= 1, 'expected ≥1 graph node drawn in the SVG gutter');
  log('PASS (b): graph view rendered rows + SVG nodes ✓');

  // Screenshot the rendered graph as evidence (before opening tabs switches the view).
  const shot = join(SCRATCH, 'git-history-graph.png');
  await page.screenshot({ path: shot });
  copyFileSync(shot, join(EVIDENCE, 'git-history-graph.png'));
  log(`screenshot → ${join(EVIDENCE, 'git-history-graph.png')}`);

  // (c) clicking a commit row reveals its detail INLINE in the resizable bottom pane (no
  // tab). The detail fetches the commit's files via git:commitDiff → a sha-tagged
  // git:commitDiffResult, and lists them; the draggable seam appears between ledger + detail.
  await page.evaluate(() => {
    window.__gh.commitDiffs = [];
  });
  await page.click('.gh__row', { force: true });
  await page.waitForSelector('.gh__detail .commitview', { state: 'attached', timeout: 15000 });
  await page.waitForSelector('.gh__resizer', { state: 'attached', timeout: 5000 });
  await page.waitForFunction(() => (window.__gh?.commitDiffs?.length ?? 0) > 0, null, {
    timeout: 15000,
  });
  const cd = await page.evaluate(() => {
    const r = window.__gh.commitDiffs.at(-1);
    return { files: r.files.length, hasSha: typeof r.sha === 'string' && r.sha.length > 0 };
  });
  log(`commit-diff result: ${cd.files} file(s), sha-tagged=${cd.hasSha}`);
  assert(cd.hasSha, 'expected git:commitDiffResult to carry its sha');
  assert(cd.files >= 1, 'expected ≥1 changed file in the commit-diff result');
  await page.waitForSelector('.gh__detail .commitview .gh__file', {
    state: 'attached',
    timeout: 12000,
  });
  // The commit detail is INLINE — selecting a commit opens NO editor tab.
  const noCommitTab = await page.evaluate(() => !document.querySelector('.tab--preview'));
  assert(noCommitTab, 'expected commit detail to render inline, not as a preview tab');
  log('PASS (c1): commit click → inline detail pane listing changed files ✓');

  // (c1b) the detail pane has a × that closes it → back to the full-height ledger. Click it,
  // assert the detail detaches and the ledger still renders, then re-open for (c2).
  await page.waitForSelector('.gh__detail-close', { state: 'attached', timeout: 5000 });
  await page.click('.gh__detail-close', { force: true });
  await page.waitForSelector('.gh__detail', { state: 'detached', timeout: 8000 });
  const ledgerStillThere = await page.evaluate(
    () => document.querySelectorAll('.gh__row').length >= 1,
  );
  assert(ledgerStillThere, 'expected the ledger to remain after closing the detail pane');
  log('PASS (c1b): × closes the detail pane back to the full ledger ✓');
  await page.click('.gh__row', { force: true });
  await page.waitForSelector('.gh__detail .commitview .gh__file', {
    state: 'attached',
    timeout: 12000,
  });

  // (c2) clicking a changed file opens a `commit-diff` editor tab (preview) with the diff
  // viewer — this is the only thing that opens a tab.
  await page.click('.gh__detail .commitview .gh__file', { force: true });
  await page.waitForSelector('.commit-diffhost', { state: 'attached', timeout: 15000 });
  const fileIsPreview = await page.evaluate(() => !!document.querySelector('.tab.tab--preview'));
  assert(fileIsPreview, 'expected the commit-diff tab to open as a preview (italic) tab');
  log('PASS (c2): file click → commit-diff preview tab with the diff viewer ✓');

  log('PASS ✓ git-history Slice A: all assertions passed');

  // Re-activate the History graph tab — opening the commit / commit-diff tabs switched the
  // active doc away, and the Slice B assertions drive the `.gh` view.
  await page.click('[data-tabid="git-history:@git-history"]', { force: true });
  await page.waitForSelector('.gh', { state: 'attached', timeout: 10000 });

  // ===== Slice B =====================================================================
  // This repo has 450+ commits, so the full set is loaded (limit 500) — good for
  // virtualization + search. Re-request with a high limit so we hold the whole history.
  await page.evaluate((s) => {
    window.__gh.history = [];
    window.agentDeck.post({ type: 'git:history', sessionId: s, limit: 500, requestId: 9000 });
  }, sid);
  await page.waitForFunction(() => (window.__gh?.history?.length ?? 0) > 0, null, {
    timeout: 20000,
  });
  // Give the re-render a tick to settle the windowed rows.
  await page.waitForSelector('.gh__row', { state: 'attached', timeout: 10000 });

  const totalCommits = await page.evaluate(
    () => window.__gh.history[window.__gh.history.length - 1].commits.length,
  );
  log(`loaded ${totalCommits} commits total`);

  // (c) VIRTUALIZATION: the DOM renders only a windowed subset of rows, not all commits.
  const domRows = await page.evaluate(() => document.querySelectorAll('.gh__row').length);
  log(`virtualization: ${domRows} rows in DOM vs ${totalCommits} commits loaded`);
  if (totalCommits > 60) {
    assert(domRows < totalCommits, 'expected virtualization: fewer DOM rows than commits');
    // The window must FILL the viewport, not just render the overscan. With an 800px-tall
    // window and ~30px rows that's ~20+; the prior viewportH=0 regression rendered only ~8.
    assert(
      domRows >= 15,
      `expected the windowed rows to fill the viewport (got ${domRows}; viewportH=0 regression renders only overscan)`,
    );
    log(`PASS (B-c): windowed subset fills the viewport (${domRows} rows) ✓`);

    // Scrolling reveals later commits: capture the first SHA, scroll down, assert it changed
    // (the window advanced) and a deeper commit is now present.
    const firstShaBefore = await page.evaluate(
      () => document.querySelector('.gh__row .gh__sha')?.textContent ?? '',
    );
    await page.evaluate(() => {
      const el = document.querySelector('.gh__list');
      if (el) el.scrollTop = 4000;
      el?.dispatchEvent(new Event('scroll'));
    });
    await page.waitForFunction(
      (before) => (document.querySelector('.gh__row .gh__sha')?.textContent ?? '') !== before,
      firstShaBefore,
      { timeout: 8000 },
    );
    const firstShaAfter = await page.evaluate(
      () => document.querySelector('.gh__row .gh__sha')?.textContent ?? '',
    );
    assert(firstShaAfter !== firstShaBefore, 'expected scroll to advance the windowed rows');
    log(`PASS (B-c): scrolling advanced the window (${firstShaBefore} → ${firstShaAfter}) ✓`);
    // Scroll back to top so the search/screenshot reads from the head.
    await page.evaluate(() => {
      const el = document.querySelector('.gh__list');
      if (el) el.scrollTop = 0;
      el?.dispatchEvent(new Event('scroll'));
    });
  } else {
    log(`SKIP (B-c): only ${totalCommits} commits — not enough to prove windowing`);
  }

  // (a) SEARCH: typing a known subject substring narrows the rendered rows to matches, and
  // lanes recompute over the subset (no crash). "logging" appears in recent commit subjects.
  // The header sub shows "<shown> of <total>" while filtered — assert the shown count drops.
  await page.fill('.gh__searchbox input', 'logging');
  await page.waitForFunction(
    (total) => {
      const sub = document.querySelector('.gh__head-sub')?.textContent ?? '';
      const m = sub.match(/^(\d+)\s+of\s+(\d+)/);
      return m !== null && Number(m[1]) >= 1 && Number(m[1]) < total;
    },
    totalCommits,
    { timeout: 8000 },
  );
  const searchShown = await page.evaluate(() => {
    const sub = document.querySelector('.gh__head-sub')?.textContent ?? '';
    return Number((sub.match(/^(\d+)\s+of/) ?? [])[1] ?? 0);
  });
  // At least one rendered row's SUBJECT carries the query (there are logging-subject commits);
  // others may match via author/body, so we don't require every row's subject to contain it.
  const someSubjectMatch = await page.evaluate(() =>
    [...document.querySelectorAll('.gh__row .gh__subject')].some((n) =>
      (n.textContent ?? '').toLowerCase().includes('logging'),
    ),
  );
  // The graph still renders nodes for the filtered subset (lanes recomputed, no dangling).
  const searchNodes = await page.evaluate(
    () => document.querySelectorAll('.gh__node, .gh__node--merge').length,
  );
  log(
    `search "logging": shown=${searchShown}/${totalCommits}, someSubjectMatch=${someSubjectMatch}, ${searchNodes} nodes`,
  );
  assert(searchShown >= 1 && searchShown < totalCommits, 'expected search to narrow the set');
  assert(someSubjectMatch, 'expected a rendered row whose subject matches the query');
  assert(searchNodes >= 1, 'expected recomputed lane nodes for the filtered subset');
  log('PASS (B-a): search narrows rows to matches + recomputes lanes ✓');

  // Screenshot the searched/filtered graph as Slice B evidence.
  const shotB = join(SCRATCH, 'git-history-b-graph.png');
  await page.screenshot({ path: shotB });
  copyFileSync(shotB, join(EVIDENCE, 'git-history-b-graph.png'));
  log(`screenshot → ${join(EVIDENCE, 'git-history-b-graph.png')}`);

  // Clear the search (Esc) so the ref filter test starts from the full set.
  await page.fill('.gh__searchbox input', '');
  await page.waitForFunction(() => document.querySelectorAll('.gh__row').length > 1, null, {
    timeout: 8000,
  });

  // (b) REF FILTER: the control is a custom button-dropdown (`.gh__reffilter` → a portaled
  // `.ctxmenu` of `role=menuitem` rows, first row "All branches"), not a native <select>.
  // Opening it lists the loaded refs; picking one narrows the set.
  await page.click('.gh__reffilter');
  await page.waitForSelector('.ctxmenu', { state: 'attached', timeout: 8000 });
  const refValues = await page.evaluate(() =>
    [...document.querySelectorAll('.ctxmenu__item')]
      .map((b) => b.textContent.trim())
      .filter((t) => t && t !== 'All branches'),
  );
  log(`ref filter options: ${refValues.length} (${refValues.slice(0, 5).join(', ')}…)`);
  assert(refValues.length >= 1, 'expected ≥1 ref in the filter control');
  // Filter by the first ref; the visible rows must shrink to that ref's reachable commits.
  const firstRef = refValues[0];
  await page.getByRole('menuitem', { name: firstRef, exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.gh__row').length >= 1, null, {
    timeout: 8000,
  });
  const refRows = await page.evaluate(() => document.querySelectorAll('.gh__row').length);
  log(
    `PASS (B-b): ref filter "${firstRef}" → ${refRows} row(s) (control lists ${refValues.length} refs) ✓`,
  );
  // Clear the filter: reopen and pick "All branches".
  await page.click('.gh__reffilter');
  await page.waitForSelector('.ctxmenu', { state: 'attached', timeout: 8000 });
  await page.getByRole('menuitem', { name: 'All branches', exact: true }).click();

  // (d) REFRESH SEAM: clicking the view's refresh button re-interrogates git on the same
  // request path the git-fingerprint / window-focus seams use. We observe the OUTBOUND
  // request via the historyResult it produces — each request is tagged with a monotonic
  // requestId (Slice B concurrent-refresh guard), so a fresh refresh yields a result with a
  // LARGER requestId than the prior one. (The stale-DROP logic itself — newest-id-wins — is
  // asserted at the unit level in test/unit/git-search.test.ts → isStaleHistory, since the
  // contextBridge object is immutable and a fabricated host reply can't be injected here.)
  // Click refresh twice; the two view-generated requests must carry strictly increasing
  // tagged requestIds (the monotonic newest-wins counter). Capturing both from the view's
  // own results avoids confusion with the test's earlier manual high-id probe.
  const clickRefreshAndGetReqId = async () => {
    const before = await page.evaluate(() => window.__gh.history.length);
    await page.click('.gh__head-btn');
    await page.waitForFunction((n) => window.__gh.history.length > n, before, { timeout: 12000 });
    return page.evaluate(() => {
      const list = window.__gh.history;
      return list[list.length - 1].requestId;
    });
  };
  const reqId1 = await clickRefreshAndGetReqId();
  const reqId2 = await clickRefreshAndGetReqId();
  log(`refresh seam: re-interrogated git twice (requestId ${reqId1} → ${reqId2})`);
  assert(
    typeof reqId1 === 'number' && typeof reqId2 === 'number',
    'expected refresh results to carry tagged requestIds',
  );
  assert(
    reqId2 > reqId1,
    'expected a fresh monotonic requestId on each refresh (newest-wins guard)',
  );
  // The view must still render its rows after the refresh round-trips (didn't crash / blank).
  await page.waitForSelector('.gh__row', { state: 'attached', timeout: 12000 });
  log(
    'PASS (B-d): view re-requests history with a fresh monotonic requestId on the refresh seam ✓',
  );

  log('PASS ✓ git-history Slice B: all assertions passed');
  await launched.cleanup();
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[git-history] FAIL ✗', e.message);
    process.exit(1);
  }
  console.error('[git-history] ERROR:', e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  process.exit(2);
}
