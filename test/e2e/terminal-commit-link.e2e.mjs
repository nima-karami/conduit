/**
 * Real-app smoke for terminal commit-hash links (crosses host git validation — a mock can't run
 * git). Seeds a throwaway repo with a known commit, opens a session there, and asserts:
 *   - host `validateCommits` resolves a real short sha AND the full sha → the full 40-char oid,
 *     and a bogus hex token / an over-short token → null (the real gate; renderer never links it).
 *   - clicking the rendered commit link (real xterm link activate via a mouse click over the sha
 *     cells) opens the Review tab scoped to that commit (the breadcrumb shows the short sha).
 *
 * The pure detector + host parser are covered in test/unit/commit-links.test.ts and
 * test/unit/commit-token.test.ts.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function seedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-commitlink-'));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@conduit.local'], dir);
  git(['config', 'user.name', 'Conduit Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'file.txt'), 'hello commit link\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'seed commit for link test'], dir);
  const full = git(['rev-parse', 'HEAD'], dir);
  return { dir, full };
}

runScenario('terminal-commit-link', async ({ page, log }) => {
  const { dir, full } = seedRepo();
  const short = full.slice(0, 8);
  log('seeded', dir, 'HEAD', full);

  // Expose live xterm terminals + link providers so we can locate the rendered sha and invoke
  // the real commit link our provider builds (no-op in production).
  await page.evaluate(() => {
    window.__terms = {};
    window.__termLinkProviders = {};
  });

  const sid = await openSession(page, { path: dir });

  // 1) Host validation is the real gate — drive the IPC directly.
  const validate = (tokens) =>
    page.evaluate(
      ({ s, toks }) =>
        new Promise((resolve) => {
          window.agentDeck.subscribe((m) => {
            if (m.type === 'validateCommitsResult' && m.sessionId === s) resolve(m.results);
          });
          window.agentDeck.post({ type: 'validateCommits', sessionId: s, tokens: toks });
          // Resolve all-null if no reply arrives — so a build WITHOUT the host handler fails the
          // assertions fast instead of hanging (discrimination), matching validate-failed → plain.
          setTimeout(() => resolve(toks.map((token) => ({ token, commit: null }))), 3000);
        }),
      { s: sid, toks: tokens },
    );

  // Retry until the active repo is detected for the freshly-opened session (cwd/repo can lag
  // openSession on a loaded machine — see [[conduit-smoke-env-flakiness]]).
  let results = [];
  let byTok = {};
  for (let i = 0; i < 12; i++) {
    results = await validate([short, full, 'deadbeef9', 'abc12']);
    byTok = Object.fromEntries(results.map((r) => [r.token, r.commit]));
    if (byTok[full] === full) break;
    await page.waitForTimeout(500);
  }
  log('validate:', JSON.stringify(results));

  assert(byTok[short] === full, `short sha ${short} → full ${full}, got ${byTok[short]}`);
  assert(byTok[full] === full, `full sha → itself, got ${byTok[full]}`);
  assert(byTok.deadbeef9 === null, `bogus hex → null, got ${byTok.deadbeef9}`);
  assert(byTok.abc12 === null, `too-short token → null, got ${byTok.abc12}`);

  // 2) Routing — render the full sha in the terminal, then activate the REAL xterm link our
  // provider builds for it (clicking xterm's canvas links in the hidden harness is unreliable;
  // terminal-path-links.e2e.mjs avoids it for the same reason, and the spec sanctions invoking
  // the same link the click uses). This still exercises the whole renderer path: detect →
  // host validateCommits → path-precedence filter → link.activate → onOpenCommitReview.
  await page.evaluate(
    ({ s, sha }) =>
      new Promise((resolve) => {
        window.__terms[s].write(`\r\nCommitted as ${sha}\r\n`, resolve);
      }),
    { s: sid, sha: full },
  );

  // Poll until the rendered sha is in the buffer (terminal output is async).
  const found = await page
    .waitForFunction(
      ({ s, probe }) => {
        const term = window.__terms[s];
        if (!term) return false;
        const buf = term.buffer.active;
        for (let y = 0; y < buf.length; y++) {
          const line = buf.getLine(y);
          if (line?.translateToString(true).includes(probe)) return true;
        }
        return false;
      },
      { s: sid, probe: full.slice(0, 12) },
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!found) {
    const dump = await page.evaluate((s) => {
      const buf = window.__terms[s]?.buffer.active;
      if (!buf) return 'no term';
      const rows = [];
      for (let y = Math.max(0, buf.length - 8); y < buf.length; y++) {
        rows.push(buf.getLine(y)?.translateToString(true) ?? '');
      }
      return rows.join(' | ');
    }, sid);
    log('buffer tail:', dump);
  }
  assert(found, 'rendered sha never appeared in the terminal buffer');
  await page.waitForTimeout(300); // let the validate round-trip warm the renderer cache

  // Activate the link, retrying ONLY a transient "sha not in buffer": the sha was confirmed
  // present above, so a single miss right after is a render-timing flake under machine load
  // ([[conduit-smoke-env-flakiness]]), not a bug. Real errors (no provider / no commit link /
  // provideLinks timeout) break out and fail fast.
  let routed = { error: 'not attempted' };
  for (let attempt = 0; attempt < 6; attempt++) {
    routed = await page.evaluate(
      ({ s, sha }) =>
        new Promise((resolve) => {
          const term = window.__terms[s];
          const buf = term.buffer.active;
          const probe = sha.slice(0, 12);
          let row = -1;
          for (let y = 0; y < buf.length; y++) {
            const line = buf.getLine(y);
            if (line?.translateToString(true).includes(probe)) {
              row = y;
              break;
            }
          }
          if (row < 0) return resolve({ error: 'sha not in buffer' });
          const provider = window.__termLinkProviders[s];
          if (!provider) return resolve({ error: 'no link provider' });
          let done = false;
          // The provider does getLine(bufferLineNumber - 1), so pass the absolute row + 1.
          provider.provideLinks(row + 1, (links) => {
            if (done) return;
            done = true;
            const found = (links || []).find((l) => l.text === sha);
            if (!found) return resolve({ error: 'no commit link', count: (links || []).length });
            found.activate(new MouseEvent('click'), found.text);
            resolve({ ok: true });
          });
          setTimeout(() => {
            if (!done) {
              done = true;
              resolve({ error: 'provideLinks timeout' });
            }
          }, 4000);
        }),
      { s: sid, sha: full },
    );
    if (routed.ok || routed.error !== 'sha not in buffer') break;
    await page.waitForTimeout(400);
  }
  log('routed:', JSON.stringify(routed));
  assert(routed.ok === true, `commit link should activate, got ${JSON.stringify(routed)}`);

  await page.waitForSelector('.review', { state: 'attached', timeout: 8000 });
  const label = await page.textContent('.review__source');
  log('review source label:', label);
  assert(
    !!label && label.includes(full.slice(0, 7)),
    `Review breadcrumb should show commit ${full.slice(0, 7)}, got "${label}"`,
  );
});
