/**
 * feat-link-cwd — a terminal's link/commit resolution keys off ITS cwd repo, NOT the pinned
 * active repo (real-app smoke; crosses host git validation, which a mock can't run).
 *
 * Setup: a NON-repo parent holds two sibling repos, repo-a (commit "alpha", file a-only.txt) and
 * repo-b (commit "beta", file b-only.txt). Open a PowerShell session at the parent, PIN repo-b via
 * the repo picker, then `cd` the terminal INTO repo-a. Now pinned repo (repo-b) ≠ cwd repo (repo-a).
 *
 * Asserts, against the real renderer + host:
 *   - validateCommits resolves repo-a's commit (cwd) and returns null for repo-b's commit (pinned) —
 *     proving it roots off cwd, not the pin — and its `root` reply ends with repo-a.
 *   - resolvePathToken finds a-only.txt (in cwd repo) and NOT b-only.txt (only in the pinned repo).
 *   - clicking the rendered repo-a commit opens Review scoped to repo-a (its file a-only.txt shows),
 *     even though repo-b is pinned — the compounding openReviewForCommit fix.
 *
 * PowerShell-only (needs OSC 9;9 cwd injection to move cwd); SKIPs if no pwsh/powershell agent.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeRepo(dir, file, subject) {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 't@t'], dir);
  git(['config', 'user.name', 't'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, file), `${subject}\n`);
  git(['add', '-A'], dir);
  git(['commit', '-qm', subject], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

const endsWith = (p, tail) => !!p && p.replace(/\\/g, '/').toLowerCase().endsWith(tail);

runScenario('link-cwd', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-linkcwd-'));
  const repoA = join(root, 'repo-a');
  const repoB = join(root, 'repo-b');
  const alpha = makeRepo(repoA, 'a-only.txt', 'alpha');
  const beta = makeRepo(repoB, 'b-only.txt', 'beta');
  log('seeded', root, 'alpha', alpha, 'beta', beta);

  await page.evaluate(() => {
    window.__terms = {};
    window.__termLinkProviders = {};
    window.__agentsList = [];
    window.agentDeck.subscribe((m) => {
      if (m.type === 'state' && m.agents) window.__agentsList = m.agents.map((a) => a.id);
    });
    window.agentDeck.post({ type: 'ready' });
  });
  await page.waitForTimeout(800);
  const agentIds = await page.evaluate(() => window.__agentsList || []);
  const psAgent = agentIds.find((id) => id === 'shell:pwsh' || id === 'shell:powershell');
  if (!psAgent) {
    log('SKIP — no PowerShell shell: agent (needs cwd injection to move cwd)');
    return;
  }
  log('using agent', psAgent);

  await page.evaluate(() =>
    window.agentDeck.post({ type: 'updateSettings', settings: { trackCwd: true } }),
  );
  await page.waitForTimeout(300);

  const sid = await openSession(page, { path: root.replace(/\\/g, '/'), agentId: psAgent });
  log('session', sid);

  // Two sibling repos detected under the non-repo parent.
  await page.waitForFunction(
    (id) => ((window.__sessions || []).find((x) => x.id === id)?.repos?.length ?? 0) >= 2,
    sid,
    { timeout: 20000 },
  );

  // Pin repo-b (the UI-pinned active repo) — deliberately NOT the repo we cd into.
  await page.evaluate(
    ({ id, r }) => window.agentDeck.post({ type: 'repo:pin', sessionId: id, repoRoot: r }),
    { id: sid, r: repoB.replace(/\\/g, '/') },
  );
  await page.waitForFunction(
    (id) => {
      const s = (window.__sessions || []).find((x) => x.id === id);
      return (
        !!s &&
        s.repoPinned === true &&
        (s.activeRepoRoot || '').replace(/\\/g, '/').endsWith('repo-b')
      );
    },
    sid,
    { timeout: 10000 },
  );
  log('pinned repo-b ✓');

  // cd the terminal INTO repo-a so its live cwd repo diverges from the pin.
  await page.waitForFunction(() => (window.__cap || '').length > 0, null, { timeout: 20000 });
  await page.evaluate(
    ({ id, dir }) => {
      window.__cap = '';
      window.agentDeck.post({ type: 'term:input', sessionId: id, data: `cd "${dir}"\r` });
    },
    { id: sid, dir: repoA },
  );
  await page.waitForFunction(
    (id) => {
      const s = (window.__sessions || []).find((x) => x.id === id);
      return !!s && (s.cwd || '').replace(/\\/g, '/').toLowerCase().endsWith('repo-a');
    },
    sid,
    { timeout: 15000 },
  );
  log('cwd moved into repo-a ✓ (pin still repo-b)');

  // 1) validateCommits keys off the cwd repo (repo-a), NOT the pinned repo (repo-b).
  const validate = (tokens) =>
    page.evaluate(
      ({ s, toks }) =>
        new Promise((resolve) => {
          window.agentDeck.subscribe((m) => {
            if (m.type === 'validateCommitsResult' && m.sessionId === s)
              resolve({ results: m.results, root: m.root });
          });
          window.agentDeck.post({ type: 'validateCommits', sessionId: s, tokens: toks });
          setTimeout(
            () => resolve({ results: toks.map((t) => ({ token: t, commit: null })) }),
            3000,
          );
        }),
      { s: sid, toks: tokens },
    );

  let reply = { results: [], root: undefined };
  let byTok = {};
  for (let i = 0; i < 12; i++) {
    reply = await validate([alpha, beta, alpha.slice(0, 8)]);
    byTok = Object.fromEntries(reply.results.map((r) => [r.token, r.commit]));
    if (byTok[alpha] === alpha) break;
    await page.waitForTimeout(500);
  }
  log('validate', JSON.stringify(reply));
  assert(byTok[alpha] === alpha, `repo-a (cwd) commit should resolve, got ${byTok[alpha]}`);
  assert(byTok[alpha.slice(0, 8)] === alpha, `repo-a short sha should resolve to full oid`);
  assert(
    byTok[beta] === null,
    `repo-b (PINNED) commit must NOT resolve against cwd repo, got ${byTok[beta]}`,
  );
  assert(
    endsWith(reply.root, 'repo-a'),
    `validate root should be the cwd repo (repo-a), got ${reply.root}`,
  );
  log('validateCommits keys off cwd repo, not the pin ✓');

  // 2) resolvePathToken likewise keys off the cwd repo.
  const resolvePaths = (tokens) =>
    page.evaluate(
      ({ s, toks }) =>
        new Promise((resolve) => {
          window.agentDeck.subscribe((m) => {
            if (m.type === 'resolvePathTokenResult' && m.sessionId === s) resolve(m.results);
          });
          window.agentDeck.post({ type: 'resolvePathToken', sessionId: s, tokens: toks });
          setTimeout(() => resolve([]), 3000);
        }),
      { s: sid, toks: tokens },
    );
  const pathRes = await resolvePaths(['a-only.txt', 'b-only.txt']);
  const cand = Object.fromEntries(pathRes.map((r) => [r.token, r.candidates.length]));
  log('resolvePathToken', JSON.stringify(pathRes));
  assert(
    (cand['a-only.txt'] ?? 0) >= 1,
    `a-only.txt (cwd repo) should resolve, got ${cand['a-only.txt']}`,
  );
  assert(
    (cand['b-only.txt'] ?? 0) === 0,
    `b-only.txt (pinned repo only) must NOT resolve, got ${cand['b-only.txt']}`,
  );
  log('resolvePathToken keys off cwd repo ✓');

  // 3) Compounding fix: clicking repo-a's commit opens Review scoped to repo-a (shows a-only.txt),
  //    even though repo-b is pinned.
  await page.evaluate(
    ({ s, sha }) => new Promise((r) => window.__terms[s].write(`\r\nBuilt ${sha}\r\n`, r)),
    { s: sid, sha: alpha },
  );
  const probe = alpha.slice(0, 12);
  await page.waitForFunction(
    ({ s, p }) => {
      const buf = window.__terms[s]?.buffer.active;
      if (!buf) return false;
      for (let y = 0; y < buf.length; y++)
        if (buf.getLine(y)?.translateToString(true).includes(p)) return true;
      return false;
    },
    { s: sid, p: probe },
    { timeout: 8000 },
  );
  await page.waitForTimeout(300);

  let routed = { error: 'not attempted' };
  for (let attempt = 0; attempt < 6; attempt++) {
    routed = await page.evaluate(
      ({ s, sha }) =>
        new Promise((resolve) => {
          const buf = window.__terms[s].buffer.active;
          const p = sha.slice(0, 12);
          let row = -1;
          for (let y = 0; y < buf.length; y++)
            if (buf.getLine(y)?.translateToString(true).includes(p)) {
              row = y;
              break;
            }
          if (row < 0) return resolve({ error: 'sha not in buffer' });
          const provider = window.__termLinkProviders[s];
          if (!provider) return resolve({ error: 'no link provider' });
          let done = false;
          provider.provideLinks(row + 1, (links) => {
            if (done) return;
            done = true;
            const link = (links || []).find((l) => l.text === sha);
            if (!link) return resolve({ error: 'no commit link' });
            link.activate(new MouseEvent('click'), link.text);
            resolve({ ok: true });
          });
          setTimeout(() => {
            if (!done) {
              done = true;
              resolve({ error: 'provideLinks timeout' });
            }
          }, 4000);
        }),
      { s: sid, sha: alpha },
    );
    if (routed.ok || routed.error !== 'sha not in buffer') break;
    await page.waitForTimeout(400);
  }
  log('routed', JSON.stringify(routed));
  assert(routed.ok === true, `commit link should activate, got ${JSON.stringify(routed)}`);

  await page.waitForSelector('.review', { state: 'attached', timeout: 8000 });
  const label = await page.textContent('.gitband__source');
  assert(
    !!label && label.includes(alpha.slice(0, 7)),
    `Review breadcrumb should show ${alpha.slice(0, 7)}, got "${label}"`,
  );
  // The review must show repo-a's file (diff read from repo-a), NOT repo-b's — the compounding fix.
  const showsA = await page
    .waitForFunction(
      () => (document.querySelector('.review')?.textContent || '').includes('a-only.txt'),
      null,
      {
        timeout: 8000,
      },
    )
    .then(() => true)
    .catch(() => false);
  assert(
    showsA,
    'Review opened from a terminal commit must show the cwd repo (repo-a) file a-only.txt',
  );
  log('terminal commit → Review scoped to cwd repo ✓');
});
