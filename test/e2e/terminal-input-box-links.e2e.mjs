/**
 * An agent CLI's live input box and the prompts it echoes into history are not linked; the agent's
 * output is, even when it starts with a markdown quote (docs/specs/2026-10-27-input-box-links.md).
 *
 * A Claude Code screen is written straight into the live xterm — the box is two full-width `─`
 * rules around the `❯` input rows, with the cursor parked inside, exactly as the captured screens
 * in test/unit/fixtures/conduit-mcp/screens/ show it. The shape rule needs no agent identity, so a
 * plain cmd session carries it and no real CLI is involved. Links are read through the live
 * provider (`window.__termLinkProviders`), as terminal-path-links-v2 does.
 *
 * Windows only, real app.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario, writeToTerminal } from './harness.mjs';
import { openPalette, paletteRow } from './middle-click-surfaces-helpers.mjs';

const OUT_URL = 'https://example.com/agent-output-link';
const TYPED_URL = 'https://example.com/typed-input-link';
const WRAP_URL = 'https://example.com/second-input-row';
const HINT_URL = 'https://example.com/placeholder-link';
const ECHO_URL = 'https://example.com/echoed-prompt-link';
const ECHO2_URL = 'https://example.com/echoed-second-row';
const QUOTE_URL = 'https://example.com/quoted-output-link';

runScenario('terminal-input-box-links', async ({ page, log }) => {
  await page.evaluate(() => {
    window.__terms = {};
    window.__termLinkProviders = {};
  });
  const workDir = mkdtempSync(join(tmpdir(), 'conduit-inbox-'));
  mkdirSync(join(workDir, 'src'));
  for (const f of ['out-file.ts', 'box-file.ts', 'echo-file.ts']) {
    writeFileSync(join(workDir, 'src', f), 'export {};\n');
  }
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

  // ── 1. typed input across two rows, cursor parked in the box. Above it: a submitted prompt
  //       echoed on Claude's background (fixtures/input-box-links/claude-echo-draft) and agent
  //       output starting with a markdown quote ──────────────────────────────────────────
  await writeToTerminal(
    page,
    sid,
    `${ESC}[2J${ESC}[H${ESC}[48;2;55;55;55m❯ fetch ${ECHO_URL} and${ESC}[K\r\n` +
      `  ${ECHO2_URL}${ESC}[K${ESC}[49m\r\n\r\n> see ${QUOTE_URL}\r\n` +
      `● Docs are at ${OUT_URL} for details\r\n\r\n${rule}\r\n` +
      `❯ open ${TYPED_URL} please\r\n  and ${WRAP_URL}\r\n${rule}\r\n` +
      `  ⏵⏵ auto mode on ${HINT_URL}${ESC}[3A${ESC}[20G`,
  );
  const out = await linksOn('agent-output-link');
  const typed = await linksOn('typed-input-link');
  const wrap = await linksOn('second-input-row');
  const footer = await linksOn('auto mode on');
  const echo = await linksOn('echoed-prompt-link');
  const echo2 = await linksOn('echoed-second-row');
  const quote = await linksOn('quoted-output-link');
  log('typed:', JSON.stringify({ out, typed, wrap, footer, echo, echo2, quote }));
  assert(
    out.links.length === 1 && out.links[0] === OUT_URL,
    `output URL should link: ${JSON.stringify(out)}`,
  );
  assert(typed.links.length === 0, `typed input URL must not link: ${JSON.stringify(typed)}`);
  assert(wrap.links.length === 0, `second input row must not link: ${JSON.stringify(wrap)}`);
  assert(footer.links.length === 0, `box footer must not link: ${JSON.stringify(footer)}`);
  assert(echo.links.length === 0, `echoed prompt must not link: ${JSON.stringify(echo)}`);
  assert(echo2.links.length === 0, `echoed prompt row 2 must not link: ${JSON.stringify(echo2)}`);
  assert(
    quote.links.length === 1 && quote.links[0] === QUOTE_URL,
    `agent output starting with > should link: ${JSON.stringify(quote)}`,
  );

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

  // ── 4. keyboard path: Open Detected Link lists the output path, not the box's or the echo's ─
  await writeToTerminal(
    page,
    sid,
    `${ESC}[2J${ESC}[H${ESC}[48;2;55;55;55m❯ edit src/echo-file.ts${ESC}[K${ESC}[49m\r\n\r\n` +
      `● Changed src/out-file.ts\r\n\r\n${rule}\r\n❯ open src/box-file.ts\r\n${rule}\r\n` +
      `${ESC}[2A${ESC}[5G`,
  );
  await openPalette(page, '>Terminal: Open Detected Link');
  await paletteRow(page, 'Terminal: Open Detected Link…').waitFor({ timeout: 5000 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.pathpick', { state: 'visible', timeout: 10000 });
  const detected = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.pathpick [role="option"]')).map(
      (el) => el.textContent ?? '',
    ),
  );
  await page.keyboard.press('Escape');
  log('detected:', JSON.stringify(detected));
  assert(
    detected.some((t) => t.startsWith('src/out-file.ts')),
    `the output path should be offered: ${JSON.stringify(detected)}`,
  );
  assert(
    !detected.some((t) => t.includes('box-file') || t.includes('echo-file')),
    `no path from the box or an echoed prompt: ${JSON.stringify(detected)}`,
  );
});
