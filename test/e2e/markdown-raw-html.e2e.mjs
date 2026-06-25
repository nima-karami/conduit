/**
 * Markdown raw-HTML rendering + sanitization (real-app smoke).
 *
 * The rendered markdown view now renders embedded HTML (rehype-raw) after sanitizing it
 * (rehype-sanitize). Verifies, against the REAL renderer, that:
 *  - safe README-style HTML renders (a centered <div> with an <img>, a <details>);
 *  - dangerous HTML is stripped (<script> doesn't execute; onerror handler removed);
 *  - math (KaTeX) and code highlighting still work (sanitize runs before them).
 *
 * Opens a crafted .md as the project root so it's one click in the Files tab.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const SAMPLE = `# Raw HTML test

<div align="center" id="hero">
  <img src="https://example.com/logo.png" alt="thelogo" width="80" height="80" />
</div>

<details><summary>toggle me</summary>hidden detail text</details>

<script>window.__xssRan = true;</script>

<img src="bad" onerror="window.__xssOnerror = true" alt="bad" />

Inline math $a^2+b^2=c^2$ then a fenced block:

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
  assert(!r.scriptEl, '<script> must be stripped (no script element)');
  assert(!r.xssRan, '<script> must NOT execute');
  assert(!r.xssOnerror && !r.onerrorAttr, 'onerror handler must be stripped');
  assert(r.katex, 'KaTeX math must still render after sanitize');
  assert(r.hljs, 'code highlighting must still work after sanitize');
  log('PASS ✓ raw HTML renders, XSS stripped, math + highlight intact');
});
