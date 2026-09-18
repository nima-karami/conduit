/**
 * preview-transport — the conduit-preview: scheme, end to end in the real app.
 *
 * This is the ONLY thing that proves the transport works at all: unit tests cover the
 * decision logic, but nothing below the IPC seam proves a `<webview>` guest can actually
 * be fed by `ses.protocol.handle` on a privileged scheme.
 *
 * It answers the three unknowns that would invalidate the viewer slice if wrong:
 *   1. does a privileged-scheme session handler feed a guest at all?
 *   2. do RELATIVE subresources resolve? (the entire justification for the URL shape)
 *   3. does `corsEnabled:false` + `supportFetchAPI:true` break a SAME-ORIGIN fetch?
 *      (Chromium refuses non-http(s) schemes absent from the CORS-enabled list — a known
 *       sharp edge; if it bites, the privilege set has to change before anything is built
 *       on top of it.)
 *
 * …and pins the two security properties the design rests on, which are otherwise claims
 * rather than controls:
 *   4. a page in workspace root A CANNOT read root B — one opaque token per root means one
 *      web origin per root, so the browser refuses before our handler is consulted. This is
 *      the whole reason the URL host is a token and not the volume (see ADR 0005).
 *   5. a remote resource load is cancelled.
 *
 * Assertions about page content are made INSIDE the guest, via the main process
 * (`webContents.getAllWebContents()` -> `executeJavaScript`). Asserting from the host DOM
 * would pass against a guest that rendered nothing.
 *
 * Windows-only, matching the suite.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[preview-transport] SKIP — suite is Windows-only');
  process.exit(0);
}

/** A page that exercises relative CSS, relative JS, a same-origin fetch, a cross-root
 *  fetch and a remote fetch, recording each outcome on `window.__probe` for the assertions
 *  below. Every result is a settled string, never a pending promise. */
const pageHtml = (crossRootUrl) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Preview Transport</title>
<link rel="stylesheet" href="./assets/style.css"></head>
<body>
<h1 id="h">rendered</h1>
<script src="./assets/app.js"></script>
<script>
window.__probe = { sameOrigin: 'pending', crossRoot: 'pending', remote: 'pending' };
fetch('./assets/data.json').then(r => r.json()).then(j => {
  window.__probe.sameOrigin = 'ok:' + j.marker;
}).catch(e => { window.__probe.sameOrigin = 'fail:' + e.message; });
fetch(${JSON.stringify(crossRootUrl)}).then(r => r.text()).then(t => {
  window.__probe.crossRoot = 'READ:' + t.slice(0, 20);
}).catch(e => { window.__probe.crossRoot = 'blocked'; });
fetch('https://example.invalid/beacon').then(() => {
  window.__probe.remote = 'REACHED';
}).catch(() => { window.__probe.remote = 'blocked'; });
</script>
</body></html>
`;

function makeRoot(label, crossRootUrl) {
  const root = mkdtempSync(join(tmpdir(), `conduit-pt-${label}-`));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'style.css'), '#h{color:rgb(1,2,3)}\n');
  writeFileSync(join(root, 'assets', 'app.js'), "document.body.dataset.scripted='yes';\n");
  writeFileSync(join(root, 'assets', 'data.json'), JSON.stringify({ marker: label }));
  writeFileSync(join(root, 'secret.txt'), `TOPSECRET-${label}\n`);
  writeFileSync(join(root, 'report.html'), pageHtml(crossRootUrl ?? 'about:blank'));
  return root;
}

/** Ask the host whether a path can be previewed, and for its URL. */
const canPreview = (page, path) =>
  page.evaluate(
    (p) =>
      new Promise((resolve) => {
        const requestId = `pt-${Math.random().toString(36).slice(2)}`;
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

/** Read the guest's own DOM through the main process. */
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

runScenario('preview-transport', async ({ app, page, log }) => {
  const rootB = makeRoot('bravo', null);
  // Root A's page tries to read root B — resolved once B's token is known, below.
  const rootA = makeRoot('alpha', null);

  await openSession(page, { path: rootB.replace(/\\/g, '/') });
  await openSession(page, { path: rootA.replace(/\\/g, '/') });

  // Root B's secret, as a preview URL — the cross-root target.
  const bSecret = await canPreview(page, join(rootB, 'secret.txt').replace(/\\/g, '/'));
  assert(
    bSecret.ok === true,
    `root B secret should be previewable by the host: ${JSON.stringify(bSecret)}`,
  );
  log(`root B token URL: ${bSecret.url}`);

  // Rewrite root A's page now that we know B's URL.
  writeFileSync(join(rootA, 'report.html'), pageHtml(bSecret.url));

  const a = await canPreview(page, join(rootA, 'report.html').replace(/\\/g, '/'));
  assert(a.ok === true, `root A report.html should be previewable: ${JSON.stringify(a)}`);
  assert(
    a.url.startsWith('conduit-preview://') && !a.url.includes(rootA.replace(/\\/g, '/')),
    `URL must be token-shaped and must NOT leak the absolute path, got ${a.url}`,
  );
  log(`root A token URL: ${a.url}`);

  const aToken = new URL(a.url).host;
  const bToken = new URL(bSecret.url).host;
  assert(aToken !== bToken, `each root must get its own token (both were ${aToken})`);
  log(`distinct tokens per root: ${aToken} vs ${bToken} ✓`);

  // Unknown 4: mount the guest with NO src, then assign it — the precheck design depends on
  // a guest created lazily on first src assignment, not refused at DOM insertion by
  // will-attach-webview seeing an empty src.
  await page.evaluate((url) => {
    const el = document.createElement('webview');
    el.id = 'pt-guest';
    el.setAttribute('partition', 'conduit-preview');
    el.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;z-index:99999';
    document.body.appendChild(el);
    setTimeout(() => {
      el.setAttribute('src', url);
    }, 250);
  }, a.url);

  await page.waitForTimeout(6000);

  const probe = await inGuest(
    app,
    `({
       title: document.title,
       heading: document.querySelector('#h') ? document.querySelector('#h').textContent : null,
       color: document.querySelector('#h') ? getComputedStyle(document.querySelector('#h')).color : null,
       scripted: document.body.dataset.scripted || null,
       probe: window.__probe || null,
       origin: location.origin,
     })`,
  );
  log(`guest probe: ${JSON.stringify(probe)}`);

  assert(!probe.error, `guest should be reachable: ${probe.error}`);

  // 1 — the handler feeds the guest at all.
  assert(probe.title === 'Preview Transport', `document loaded (title), got ${probe.title}`);
  assert(probe.heading === 'rendered', `body rendered, got ${probe.heading}`);
  log('the privileged-scheme session handler feeds a <webview> guest ✓');

  // 4 (deferred src) — proven by the fact that anything loaded at all.
  log('a guest created with no src, then assigned one, attaches and loads ✓');

  // 2 — relative subresources resolve.
  assert(probe.color === 'rgb(1, 2, 3)', `relative ./assets/style.css applied, got ${probe.color}`);
  assert(probe.scripted === 'yes', `relative ./assets/app.js ran, got ${probe.scripted}`);
  log('relative CSS and JS resolve against the token URL, no <base> needed ✓');

  // 3 — same-origin fetch under corsEnabled:false + supportFetchAPI:true.
  assert(
    probe.probe?.sameOrigin === 'ok:alpha',
    `same-origin fetch must work (corsEnabled:false is the sharp edge here), got ${probe.probe?.sameOrigin}`,
  );
  log('same-origin fetch works under the chosen privilege set ✓');

  // 5 — CROSS-ROOT ISOLATION. The reason the URL host is a per-root token (ADR 0005).
  assert(
    probe.probe.crossRoot === 'blocked',
    `a page in root A must NOT read root B — got ${probe.probe.crossRoot}`,
  );
  log('cross-root read refused: one token per root really is one origin per root ✓');

  // 6 — the network block.
  assert(
    probe.probe.remote === 'blocked',
    `a remote fetch must be cancelled, got ${probe.probe.remote}`,
  );
  log('remote resource load cancelled ✓');

  log(
    'PASS — transport, relative resolution, same-origin fetch, cross-root isolation, network block',
  );
});
