/**
 * An agent CLI's live input box is not linked; the agent's output above it is
 * (docs/specs/2026-10-27-input-box-links.md).
 *
 * A Claude Code screen is written straight into the live xterm — the box is two full-width `─`
 * rules around the `❯` input rows, with the cursor parked inside, exactly as the captured screens
 * in test/unit/fixtures/conduit-mcp/screens/ show it. The shape rule needs no agent identity, so a
 * plain cmd session carries it and no real CLI is involved. Links are read through the live
 * provider (`window.__termLinkProviders`), as terminal-path-links-v2 does.
 *
 * Windows only, real app.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario, writeToTerminal } from './harness.mjs';

const OUT_URL = 'https://example.com/agent-output-link';
const TYPED_URL = 'https://example.com/typed-input-link';
const WRAP_URL = 'https://example.com/second-input-row';
const HINT_URL = 'https://example.com/placeholder-link';

runScenario('terminal-input-box-links', async ({ page, log }) => {
  await page.evaluate(() => {
    window.__terms = {};
    window.__termLinkProviders = {};
  });
  const workDir = mkdtempSync(join(tmpdir(), 'conduit-inbox-'));
  const sid = await openSession(page, { path: workDir.replace(/\\/g, '/') });
  await page.waitForFunction((id) => !!window.__termLinkProviders?.[id], sid, { timeout: 20000 });
  await page.waitForFunction((dir) => (window.__cap || '').includes(`${dir}>`), workDir, {
    timeout: 30000,
  });
  await page.waitForTimeout(500);

  const cols = await page.evaluate((id) => window.__terms[id].cols, sid);
  const rule = '─'.repeat(cols);
  const ESC = '\x1b';

  /** URL link texts the provider returns for the last row containing `needle`. */
  const linksOn = (needle) =>
    page.evaluate(
      ({ id, needle }) =>
        new Promise((resolve) => {
          const buf = window.__terms[id].buffer.active;
          let row = -1;
          for (let y = 0; y < buf.length; y++) {
            if (buf.getLine(y)?.translateToString(true).includes(needle)) row = y;
          }
          if (row < 0) return resolve({ row, links: null });
          window.__termLinkProviders[id].provideLinks(row + 1, (ls) =>
            resolve({ row, links: (ls ?? []).map((l) => l.text) }),
          );
        }),
      { id: sid, needle },
    );

  // ── 1. typed input across two rows, cursor parked in the box ────────────────────────
  await writeToTerminal(
    page,
    sid,
    `${ESC}[2J${ESC}[H● Docs are at ${OUT_URL} for details\r\n\r\n${rule}\r\n` +
      `❯ open ${TYPED_URL} please\r\n  and ${WRAP_URL}\r\n${rule}\r\n` +
      `  ⏵⏵ auto mode on ${HINT_URL}${ESC}[3A${ESC}[20G`,
  );
  const out = await linksOn('agent-output-link');
  const typed = await linksOn('typed-input-link');
  const wrap = await linksOn('second-input-row');
  const footer = await linksOn('auto mode on');
  log('typed:', JSON.stringify({ out, typed, wrap, footer }));
  assert(
    out.links.length === 1 && out.links[0] === OUT_URL,
    `output URL should link: ${JSON.stringify(out)}`,
  );
  assert(typed.links.length === 0, `typed input URL must not link: ${JSON.stringify(typed)}`);
  assert(wrap.links.length === 0, `second input row must not link: ${JSON.stringify(wrap)}`);
  assert(footer.links.length === 0, `box footer must not link: ${JSON.stringify(footer)}`);

  // ── 2. dim placeholder in an empty box ───────────────────────────────────────────────
  await writeToTerminal(
    page,
    sid,
    `${ESC}[2J${ESC}[H● Docs are at ${OUT_URL} for details\r\n\r\n${rule}\r\n` +
      `❯ ${ESC}[2mTry "fetch ${HINT_URL}"${ESC}[22m\r\n${rule}\r\n${ESC}[2A${ESC}[3G`,
  );
  const out2 = await linksOn('agent-output-link');
  const hint = await linksOn('placeholder-link');
  log('placeholder:', JSON.stringify({ out2, hint }));
  assert(out2.links.length === 1, `output URL should still link: ${JSON.stringify(out2)}`);
  assert(hint.links.length === 0, `placeholder URL must not link: ${JSON.stringify(hint)}`);

  // ── 3. the box is gone (cursor left it): its old rows are plain history again ────────
  await writeToTerminal(page, sid, `${ESC}[4B\r\nplain shell output\r\n`);
  const after = await linksOn('placeholder-link');
  log('after:', JSON.stringify(after));
  assert(after.links.length === 1, `a box the cursor left is history: ${JSON.stringify(after)}`);
});
