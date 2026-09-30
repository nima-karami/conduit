/**
 * preview-origin — a page previewed from root A cannot read open root B through A's own origin.
 *
 * preview-transport proves the browser refuses a CROSS-origin read of B. This covers the
 * same-origin paths the browser cannot refuse, where only the host's per-token confinement
 * stands between A's page and B's files: a directory junction inside A pointing at B, and an
 * encoded-separator segment that climbs from A into its sibling B.
 *
 * Windows-only, matching the suite. A junction needs no admin rights.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  assert,
  closeApp,
  finishScenario,
  openSession,
  removeDir,
  runScenario,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[preview-origin] SKIP — suite is Windows-only');
  await finishScenario(0);
}

const pageHtml = (siblingSegment) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Preview Origin</title></head>
<body>
<script>
window.__probe = { own: 'pending', viaJunction: 'pending', viaSegment: 'pending' };
const read = (key, url) => fetch(url)
  .then((r) => r.ok ? r.text().then((t) => 'READ:' + t.slice(0, 20)) : 'status:' + r.status)
  .catch(() => 'blocked')
  .then((v) => { window.__probe[key] = v; });
read('own', './own.txt');
read('viaJunction', './blink/secret.txt');
read('viaSegment', ${JSON.stringify(`./${siblingSegment}`)});
</script>
</body></html>
`;

const canPreview = (page, path) =>
  page.evaluate(
    (p) =>
      new Promise((resolve) => {
        const requestId = `po-${Math.random().toString(36).slice(2)}`;
        const off = window.agentDeck.subscribe((m) => {
          if (m.type === 'html:canPreviewResult' && m.requestId === requestId) {
            off?.();
            resolve(m.result);
          }
        });
        window.agentDeck.post({ type: 'html:canPreview', requestId, path: p });
        setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 10000);
      }),
    path,
  );

const inGuest = (app, expr) =>
  app.evaluate(async ({ webContents }, src) => {
    const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview');
    if (!guest) return { error: 'no guest webContents' };
    try {
      return await guest.executeJavaScript(src);
    } catch (e) {
      return { error: String(e) };
    }
  }, expr);

runScenario('preview-origin', async ({ app, page, log }) => {
  const parent = mkdtempSync(join(tmpdir(), 'conduit-po-'));
  const junction = join(parent, 'alpha', 'blink');
  let passed = false;
  try {
    const rootA = join(parent, 'alpha');
    const rootB = join(parent, 'bravo');
    mkdirSync(rootA);
    mkdirSync(rootB);
    writeFileSync(join(rootB, 'secret.txt'), 'TOPSECRET-bravo\n');
    writeFileSync(join(rootA, 'own.txt'), 'own-alpha\n');
    symlinkSync(rootB, join(rootA, 'blink'), 'junction');
    writeFileSync(
      join(rootA, 'report.html'),
      pageHtml(
        `..${encodeURIComponent('/')}${basename(rootB)}${encodeURIComponent('/')}secret.txt`,
      ),
    );

    await openSession(page, { path: rootB.replace(/\\/g, '/') });
    await openSession(page, { path: rootA.replace(/\\/g, '/') });

    const direct = await canPreview(page, join(rootB, 'secret.txt').replace(/\\/g, '/'));
    assert(direct.ok === true, `B's own file stays previewable: ${JSON.stringify(direct)}`);

    const a = await canPreview(page, join(rootA, 'report.html').replace(/\\/g, '/'));
    assert(a.ok === true, `root A report.html should be previewable: ${JSON.stringify(a)}`);

    await page.evaluate((url) => {
      const el = document.createElement('webview');
      el.id = 'po-guest';
      el.setAttribute('partition', 'conduit-preview');
      el.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;z-index:99999';
      document.body.appendChild(el);
      setTimeout(() => el.setAttribute('src', url), 250);
    }, a.url);

    let probe;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(250);
      probe = await inGuest(app, 'window.__probe || null');
      if (probe && !probe.error && !Object.values(probe).includes('pending')) break;
    }
    log(`guest probe: ${JSON.stringify(probe)}`);
    assert(probe && !probe.error, `guest should be reachable: ${JSON.stringify(probe)}`);

    assert(probe.own === 'READ:own-alpha\n', `A's own file must load, got ${probe.own}`);
    assert(
      !String(probe.viaJunction).startsWith('READ:'),
      `A's page must NOT read B through a junction, got ${probe.viaJunction}`,
    );
    assert(
      !String(probe.viaSegment).startsWith('READ:'),
      `A's page must NOT read B through an encoded-separator segment, got ${probe.viaSegment}`,
    );
    log('same-origin reads of B through A are refused by the host ✓');

    const linked = await canPreview(page, join(rootA, 'blink', 'secret.txt').replace(/\\/g, '/'));
    assert(
      linked.ok === false && linked.reason === 'blocked',
      `the precheck must refuse B's file reached through A's junction: ${JSON.stringify(linked)}`,
    );
    log('precheck refuses a path in A that resolves into B ✓');
    log('PASS — one origin per root holds against junction and encoded-segment reads');
    passed = true;
  } finally {
    // The sessions pin both roots on Windows until the app is gone.
    await closeApp(app, page);
    const removeTemp = async () => {
      // Unlink the junction itself first: a recursive delete must never walk through it into B.
      rmSync(junction, { force: true });
      await removeDir(parent);
    };
    // On a failure path, a leftover temp dir must not mask the assertion that failed.
    await removeTemp().catch((e) => {
      if (passed) throw e;
    });
  }
});
