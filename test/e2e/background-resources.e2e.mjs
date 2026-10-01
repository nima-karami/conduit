import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';

runScenario('background-resources', async ({ app, page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-resources-'));
  const folder = root.replace(/\\/g, '/');
  const head = join(root, '.git', 'HEAD');
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'seed.txt'), 'seed\n');
    git('add', '.');
    git('commit', '-qm', 'seed');
    await app.evaluate((_electron, target) => {
      const fs = process.getBuiltinModule('fs');
      const cp = process.getBuiltinModule('child_process');
      const watch = fs.watch;
      const exec = cp.execFile;
      globalThis.__resources = { handles: 0, calls: 0, commands: [] };
      fs.watch = function (file, ...args) {
        const watcher = watch.call(this, file, ...args);
        if (String(file).replace(/\\/g, '/') === `${target}/.git/HEAD`) {
          globalThis.__resources.handles++;
          watcher.once('close', () => globalThis.__resources.handles--);
        }
        return watcher;
      };
      cp.execFile = function (bin, args, options, ...rest) {
        if (bin === 'git' && String(options?.cwd).replace(/\\/g, '/') === target) {
          globalThis.__resources.calls++;
          globalThis.__resources.commands.push(args);
        }
        return exec.call(this, bin, args, options, ...rest);
      };
    }, folder);
    const ids = [];
    for (let i = 0; i < 8; i++) {
      ids.push(await openSession(page, { path: folder }));
      await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
    }
    await page.evaluate(
      (shown) => window.agentDeck.post({ type: 'visible', ids: shown }),
      [ids[6], ids[7]],
    );
    await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    assert(
      (await app.evaluate(() => globalThis.__resources.handles)) === 1,
      'one shared HEAD watcher for eight sessions',
    );
    await app.evaluate(() => {
      globalThis.__resources.calls = 0;
      globalThis.__resources.commands = [];
    });
    writeFileSync(head, readFileSync(head, 'utf8'));
    await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    const calls = await app.evaluate(() => globalThis.__resources.calls);
    assert(
      calls > 0 && calls <= 8,
      `split-visible shared root refresh is bounded: ${calls} git commands`,
    );
    await page.evaluate(() => window.agentDeck.post({ type: 'visible', ids: [] }));
    await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    await app.evaluate(() => {
      globalThis.__resources.calls = 0;
    });
    writeFileSync(head, readFileSync(head, 'utf8'));
    await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)));
    assert(
      (await app.evaluate(() => globalThis.__resources.calls)) === 0,
      `hidden sessions defer Git interrogation: ${JSON.stringify(await app.evaluate(() => globalThis.__resources.commands))}`,
    );
    const marker = `BACKGROUND_${Date.now()}`;
    await page.evaluate(
      ({ id, marker }) =>
        window.agentDeck.post({ type: 'term:input', sessionId: id, data: `echo ${marker}\r` }),
      { id: ids[0], marker },
    );
    await page.waitForFunction(
      ({ id, marker }) => window.__capBy?.[id]?.includes(marker),
      { id: ids[0], marker },
      { timeout: 10000 },
    );
    await page.evaluate((id) => window.agentDeck.post({ type: 'visible', ids: [id] }), ids[0]);
    await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    assert(
      (await app.evaluate(() => globalThis.__resources.calls)) > 0,
      'returning to a hidden session refreshes Git',
    );
    await page.evaluate((root) => {
      window.__resourceSearch = undefined;
      window.agentDeck.subscribe((m) => {
        if (m.type === 'contentSearchResults' && m.requestId === 98765) window.__resourceSearch = m;
      });
      window.agentDeck.post({
        type: 'contentSearch',
        root,
        requestId: 98765,
        query: { text: 'se+d', regex: true, caseSensitive: false, wholeWord: false },
      });
    }, folder);
    await page.waitForFunction(() => window.__resourceSearch !== undefined, null, {
      timeout: 10000,
    });
    const search = await page.evaluate(() => window.__resourceSearch);
    assert(
      !search.error && search.results.length > 0,
      'packaged regex worker returns file matches',
    );
    log(
      `eight sessions, one watcher, ${calls} Git commands for shared split demand; background output and wake verified`,
    );
  } finally {
    await closeApp(app, page);
    await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
