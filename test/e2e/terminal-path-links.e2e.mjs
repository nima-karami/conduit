/**
 * Real-app smoke for the path-links v1 host resolver (`resolvePathToken`). Drives the IPC the
 * terminal link provider uses, against the Conduit repo, asserting:
 *   - rule 1 (exact relative): `webview/app.tsx` → exactly that file.
 *   - rule 2 (suffix search): the bare filename `protocol.ts` → ≥1 candidate, all ending in it.
 *   - a bogus token → 0 candidates (renders as plain text).
 *
 * The pure resolver is covered in test/unit/path-resolve.test.ts and the matcher in
 * test/unit/terminal-links.test.ts. The actual click→dropdown gesture is canvas-bound and
 * remains needs-human-smoke (documented in terminal-links.e2e.mjs).
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */
import { assert, openSession, REPO, runScenario } from './harness.mjs';

runScenario('terminal-path-links', async ({ page, log }) => {
  const sid = await openSession(page, { path: REPO });

  const resolve = (tokens) =>
    page.evaluate(
      ({ s, toks }) =>
        new Promise((resolve) => {
          window.agentDeck.subscribe((m) => {
            if (m.type === 'resolvePathTokenResult' && m.sessionId === s) resolve(m.results);
          });
          window.agentDeck.post({ type: 'resolvePathToken', sessionId: s, tokens: toks });
        }),
      { s: sid, toks: tokens },
    );

  const [exact, suffix, bogus] = await resolve([
    'webview/app.tsx',
    'protocol.ts',
    'zzz-does-not-exist.ts',
  ]);
  log('exact:', JSON.stringify(exact));
  log('suffix:', JSON.stringify(suffix.candidates.map((c) => c.relPath)));
  log('bogus:', JSON.stringify(bogus));

  // rule 1 — exact relative resolves to the one file.
  assert(
    exact.candidates.length === 1,
    `webview/app.tsx → 1 candidate, got ${exact.candidates.length}`,
  );
  assert(
    exact.candidates[0].relPath === 'webview/app.tsx' && exact.candidates[0].isDir === false,
    `exact candidate should be webview/app.tsx (file), got ${JSON.stringify(exact.candidates[0])}`,
  );

  // rule 2 — bare filename suffix search finds it; every candidate ends with the token.
  assert(
    suffix.candidates.length >= 1,
    `protocol.ts → >=1 candidate, got ${suffix.candidates.length}`,
  );
  assert(
    suffix.candidates.every(
      (c) => c.relPath === 'protocol.ts' || c.relPath.endsWith('/protocol.ts'),
    ),
    `every suffix candidate should end with protocol.ts, got ${JSON.stringify(suffix.candidates.map((c) => c.relPath))}`,
  );

  // no match → plain text.
  assert(
    bogus.candidates.length === 0,
    `bogus token → 0 candidates, got ${bogus.candidates.length}`,
  );
});
