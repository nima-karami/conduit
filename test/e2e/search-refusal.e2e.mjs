/**
 * The host refuses a search the renderer has no business asking for (search-scope review r1, the
 * guard; r2 SF4, this scenario): `contentSearch` and `searchFiles` for a root outside the
 * session, with no or an unknown `sessionId`, or with a scope that is not an index scope. The
 * renderer is never load-bearing, so the messages are posted raw over the bridge.
 *
 * contentSearch answers a refusal with an inline error and no results; searchFiles answers it
 * with nothing at all. A valid ask of each kind runs first and last, so a refusal can't pass by
 * the host not answering anything.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, removeDir, runScenario, tapBridge } from './harness.mjs';

const NEEDLE = 'REFUSAL_NEEDLE_7';
const REFUSED = 'Search refused';
/** How long a refused searchFiles gets to (wrongly) answer after the closing valid ask has. */
const QUIET_MS = 1500;

const slash = (p) => p.replace(/\\/g, '/');

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    windowsHide: true,
    stdio: 'pipe',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });

const post = (page, msg) => page.evaluate((m) => window.agentDeck.post(m), msg);

async function contentReply(page, requestId) {
  try {
    await page.waitForFunction(
      (id) => window.__searchReplies.some((m) => m.requestId === id),
      requestId,
      { timeout: 15000 },
    );
  } catch (e) {
    if (e?.name !== 'TimeoutError') throw e;
    assert(false, `contentSearch ${requestId} got no reply at all`);
  }
  return page.evaluate((id) => window.__searchReplies.find((m) => m.requestId === id), requestId);
}

const fileReplies = (page) =>
  page.evaluate(() => window.__searchReplies.filter((m) => m.type === 'searchResults'));

runScenario('search-refusal', async ({ app, page, log }) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'conduit-search-refusal-')));
  const ws = join(root, 'ws');
  const other = join(root, 'other');
  try {
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src', 'a.ts'), `export const a = '${NEEDLE}';\n`);
    git(ws, 'init', '-q', '-b', 'main');
    git(ws, 'config', 'user.email', 'test@example.com');
    git(ws, 'config', 'user.name', 'Test');
    git(ws, 'config', 'commit.gpgsign', 'false');
    git(ws, 'add', '-A');
    git(ws, 'commit', '-qm', 'seed');
    mkdirSync(other);
    writeFileSync(join(other, 'secret.txt'), `${NEEDLE}\n`);

    const sid = await openSession(page, { path: slash(ws) });
    await tapBridge(page);
    await page.evaluate(() => {
      window.__searchReplies = [];
      window.agentDeck.subscribe((m) => {
        if (m.type === 'contentSearchResults' || m.type === 'searchResults')
          window.__searchReplies.push(m);
      });
    });
    const wsRoot = slash(ws);
    const query = { text: NEEDLE };

    await post(page, {
      type: 'contentSearch',
      sessionId: sid,
      requestId: 9001,
      root: wsRoot,
      query,
    });
    const ok = await contentReply(page, 9001);
    assert(
      !ok.error && ok.results.some((f) => f.rel === 'src/a.ts'),
      `a valid contentSearch answers with its hit (got ${JSON.stringify(ok)})`,
    );

    const refusals = [
      ['a root outside the session', { sessionId: sid, root: slash(other) }],
      ['no sessionId', { root: wsRoot }],
      ['an unknown sessionId', { sessionId: 'no-such-session', root: wsRoot }],
      ['a bad scope', { sessionId: sid, root: wsRoot, scope: 'bogus' }],
    ];
    let requestId = 9100;
    for (const [what, fields] of refusals) {
      requestId += 1;
      await post(page, { type: 'contentSearch', requestId, query, ...fields });
      const r = await contentReply(page, requestId);
      assert(
        typeof r.error === 'string' && r.error.startsWith(REFUSED) && r.results.length === 0,
        `contentSearch with ${what} is refused with no results (got ${JSON.stringify(r)})`,
      );
    }
    log('contentSearch: outside root, no/unknown sessionId, bad scope all refused ✓');

    await post(page, { type: 'searchFiles', sessionId: sid, root: wsRoot, query: '' });
    await page.waitForFunction(
      () => window.__searchReplies.some((m) => m.type === 'searchResults'),
      null,
      { timeout: 15000 },
    );
    const before = (await fileReplies(page)).length;
    for (const [, fields] of refusals)
      await post(page, { type: 'searchFiles', query: '', ...fields });
    await post(page, { type: 'searchFiles', sessionId: sid, root: wsRoot, query: '', fresh: true });
    await page.waitForFunction(
      (n) => window.__searchReplies.filter((m) => m.type === 'searchResults').length > n,
      before,
      { timeout: 15000 },
    );
    await page.waitForTimeout(QUIET_MS);
    const after = (await fileReplies(page)).slice(before);
    assert(
      after.length === 1 && after[0].root === wsRoot,
      `refused searchFiles asks answer nothing; only the closing valid ask does (got ${JSON.stringify(
        after.map((m) => ({ root: m.root, n: m.results.length })),
      )})`,
    );
    log('searchFiles: the same four refused with no searchResults ✓');
  } finally {
    await closeApp(app, page);
    await removeDir(root);
  }
});
