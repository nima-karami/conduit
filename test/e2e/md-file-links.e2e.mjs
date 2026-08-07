/**
 * Rendered markdown: a `file:///` link opens the file, and YAML frontmatter renders as a card.
 *
 * Two bugs that both came down to rehype-sanitize running between the markdown pipeline and
 * our own components, and both are invisible to unit tests:
 *
 *  - sanitize keeps an `href` only for its protocol allow-list (http/https/irc/ircs/mailto/
 *    xmpp), so BOTH local-file forms lost their target before MarkdownLink could classify
 *    them — `file:///c:/…` (scheme `file`) and `C:/…` (drive letter parses as a scheme).
 *    Every absolute file link rendered inert. resolveMdLink unit tests passed throughout,
 *    because they never go through sanitize.
 *  - the frontmatter card is built by a REMARK plugin, so its `markdown-frontmatter*`
 *    classNames were also sanitize input and were stripped, leaving a skill file's `name:`
 *    and `description:` as one unstyled run of text.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[md-file-links] SKIP — suite is Windows-only');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'conduit-mdlink-'));
writeFileSync(
  join(dir, 'target.md'),
  ['---', 'name: target-doc', 'description: opened through a file URL', '---', '', '# Target'].join(
    '\n',
  ),
);
// `file:///C:/…` — exactly what an agent or VS Code's "copy as link" emits.
const fileUrl = `file:///${join(dir, 'target.md').split('\\').join('/')}`;
writeFileSync(join(dir, 'index.md'), `# Index\n\n[open target](${fileUrl})\n`);

runScenario('md-file-links', async ({ page, log }) => {
  await openSession(page, { path: dir });
  await page.locator('.rtab', { hasText: 'Files' }).click();

  const openRow = async (name) => {
    const row = page.locator('.filerow', {
      has: page.locator('.filerow__name', { hasText: new RegExp(`^${name}$`) }),
    });
    await row.first().waitFor({ state: 'attached', timeout: 20000 });
    await row.first().click();
  };

  await openRow('index\\.md');
  const link = page.locator('.markdown a', { hasText: 'open target' }).first();
  await link.waitFor({ state: 'attached', timeout: 15000 });

  // A file link renders with NO href — the click handler owns it. An inert `file:` link kept
  // an empty href instead, which is the shape this guards against.
  assert(
    (await link.getAttribute('href')) === null,
    'a file:// link should be treated as a file link (no href), not left inert',
  );

  await link.click({ force: true });

  const opened = await page
    .waitForFunction(
      () => (document.querySelector('.markdown')?.textContent || '').includes('Target'),
      null,
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(opened, 'clicking a file:// link should open that document');
  log('PASS: file:// link opens the target document ✓');

  // The frontmatter card must survive sanitize WITH its classes — without them the card still
  // exists, so assert on the class, not on the text.
  await page
    .locator('.markdown-frontmatter')
    .first()
    .waitFor({ state: 'attached', timeout: 10000 });
  const keys = await page.locator('.markdown-frontmatter__key').allTextContents();
  assert(
    keys.includes('name') && keys.includes('description'),
    `frontmatter keys should render as labelled rows, got ${JSON.stringify(keys)}`,
  );
  log('PASS: frontmatter renders as a card with its classes intact ✓');
});
