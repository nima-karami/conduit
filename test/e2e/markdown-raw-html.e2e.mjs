/**
 * Markdown raw-HTML rendering + sanitization (real-app smoke).
 *
 * The rendered markdown view now renders embedded HTML (rehype-raw) after sanitizing it
 * (rehype-sanitize). Verifies, against the REAL renderer, that:
 *  - safe README-style HTML renders (a centered <div> with an <img>, a <details>);
 *  - a REMOTE raw-HTML <img> goes through the same click-to-load privacy gate a markdown
 *    image does, rather than auto-fetching (see webview/md-links.ts remoteImageHost);
 *  - dangerous HTML is stripped (<script> doesn't execute; onerror handler removed);
 *  - math (KaTeX) and code highlighting still work (sanitize runs before them). The fixture
 *    writes math with TWO dollars on purpose: single-dollar text math is deliberately off so a
 *    lone $ stays currency (webview/md-math.ts). Don't "fix" it back to one.
 *
 * Opens a crafted .md as the project root so it's one click in the Files tab.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

// A 1x1 transparent PNG: a `data:` source renders eagerly (the sanitize schema allow-lists the
// `data:` protocol on src), so it proves the raw-HTML <img> reaches the DOM as a real image.
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SAMPLE = `# Raw HTML test

<div align="center" id="hero">
  <img src="${PIXEL}" alt="thelogo" width="80" height="80" />
</div>

<img src="https://example.com/logo.png" alt="theremote" width="80" height="80" />

<details><summary>toggle me</summary>hidden detail text</details>

<script>window.__xssRan = true;</script>

<img src="bad" onerror="window.__xssOnerror = true" alt="bad" />

Math $$a^2+b^2=c^2$$ then a fenced block:

\`\`\`js
const answer = 41 + 1;
\`\`\`
`;

runScenario('markdown-raw-html', async ({ page, log }) => {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-md-'));
  writeFileSync(join(dir, 'sample.md'), SAMPLE);

  await openSession(page, { path: dir.replace(/\\/g, '/') });
  await page.locator('.rtab', { hasText: 'Files' }).click();

  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: /^sample\.md$/ }),
  });
  await row.first().waitFor({ state: 'attached', timeout: 20000 });
  await row.first().click();
  await page.locator('.markdown').first().waitFor({ state: 'visible', timeout: 20000 });
  log('sample.md rendered ✓');

  const r = await page.evaluate(() => {
    const md = document.querySelector('.markdown');
    return {
      // safe HTML rendered
      img: !!md?.querySelector('img[alt="thelogo"]'),
      centered: !!md?.querySelector('div[align="center"], #hero'),
      details: !!md?.querySelector('details'),
      // a remote raw-HTML <img> is gated, not fetched
      remoteImg: !!md?.querySelector('img[alt="theremote"]'),
      remoteGate: md?.querySelector('.markdown-img-load')?.textContent ?? null,
      // dangerous HTML stripped
      scriptEl: !!md?.querySelector('script'),
      xssRan: !!window.__xssRan,
      xssOnerror: !!window.__xssOnerror,
      onerrorAttr: !!md?.querySelector('[onerror]'),
      // trusted enrichers still work (sanitize ran before them)
      katex: !!md?.querySelector('.katex'),
      hljs: !!md?.querySelector('code .hljs, code [class*="hljs-"], .hljs'),
    };
  });
  log('probe:', JSON.stringify(r));

  assert(r.img, 'embedded <img> from raw HTML should render');
  assert(r.details, 'embedded <details> from raw HTML should render');
  assert(!r.remoteImg, 'a REMOTE raw-HTML <img> must not auto-fetch');
  assert(
    /example\.com/.test(r.remoteGate ?? ''),
    `a remote raw-HTML <img> should offer the click-to-load chip; got ${JSON.stringify(r.remoteGate)}`,
  );
  assert(!r.scriptEl, '<script> must be stripped (no script element)');
  assert(!r.xssRan, '<script> must NOT execute');
  assert(!r.xssOnerror && !r.onerrorAttr, 'onerror handler must be stripped');
  assert(r.katex, 'KaTeX math must still render after sanitize');
  assert(r.hljs, 'code highlighting must still work after sanitize');
  log('PASS ✓ raw HTML renders, remote images gated, XSS stripped, math + highlight intact');
});
