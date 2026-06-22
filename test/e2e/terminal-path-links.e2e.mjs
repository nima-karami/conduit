/**
 * Real-app smoke for the broadened terminal path matcher (MVP: bare project-relative paths
 * with a separator, e.g. `webview/app.tsx`). The matcher resolves such a token against the
 * session cwd; the link provider then renders it only if the host confirms it exists. This
 * drives the real host FS boundary the feature relies on: the exact absolute path the matcher
 * produces for a real repo-relative token resolves as an existing FILE, while a bogus one
 * resolves as missing (so only real files would ever become links).
 *
 * The pure matcher itself is covered exhaustively in test/unit/terminal-links.test.ts; the
 * link-provider wiring (pathExists → xterm link) is unchanged from the shipped D11 feature.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */
import { assert, openSession, REPO, runScenario } from './harness.mjs';

runScenario('terminal-path-links', async ({ page, log }) => {
  await openSession(page, { path: REPO });

  const root = REPO.replace(/\\/g, '/');
  const real = `${root}/webview/app.tsx`; // matcher output for the bare-relative `webview/app.tsx`
  const bogus = `${root}/nope/does-not-exist.ts`;

  const check = (path) =>
    page.evaluate(
      (p) =>
        new Promise((resolve) => {
          window.agentDeck.subscribe((m) => {
            if (m.type === 'pathExistsResult' && m.path === p)
              resolve({ exists: m.exists, isDir: m.isDir });
          });
          window.agentDeck.post({ type: 'pathExists', path: p });
        }),
      path,
    );

  const r1 = await check(real);
  const r2 = await check(bogus);
  log('real:', JSON.stringify(r1), '| bogus:', JSON.stringify(r2));

  assert(
    r1.exists === true && r1.isDir === false,
    `a real repo-relative file should resolve as an existing file: ${real} → ${JSON.stringify(r1)}`,
  );
  assert(r2.exists === false, `a bogus path should resolve as missing: ${bogus}`);
});
