/**
 * OSC 8 hyperlinks in the terminal open in the real browser — no scare dialog, no dead click.
 *
 * Conduit registers its own regex `linkProvider` (URLs, paths, commit hashes) in
 * terminal-pane.tsx, but an OSC 8 hyperlink — the escape-sequence kind Claude Code and most
 * modern CLIs emit, where a label hides the URL — is matched by xterm's OWN built-in provider
 * and never reaches that one. With no `linkHandler` on the Terminal, xterm fell back to its
 * default handler, which:
 *   1. shows `confirm("Do you want to navigate to …? WARNING: This link could potentially be
 *      dangerous")`, and
 *   2. on OK calls `window.open()` with NO url — which the host's setWindowOpenHandler sees as
 *      about:blank, refuses (it is not an EXTERNAL_SCHEME), and denies, so `window.open`
 *      returns null and the addon gives up.
 * The user got a scary warning and a link that never opened. This pins the fix.
 *
 * The link is written straight into the live xterm via `window.__terms` rather than echoed
 * through the shell: the PTY is not what is under test here, and emitting raw ESC through
 * cmd.exe is quoting theatre. The click is a REAL mouse click at the link's cell, so the whole
 * xterm hit-test → link provider → handler path runs exactly as it does for a user.
 *
 * Windows only, real app — see CLAUDE.md (run alone on a quiet machine).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, getSpyCalls, openSession, runScenario, spyMain } from './harness.mjs';

const URL_UNDER_TEST = 'https://example.com/conduit-osc8-probe';
const LABEL = 'CLICK-ME-OSC8';

runScenario('terminal-osc8-link', async ({ app, page, log }) => {
  await spyMain(app, [{ api: 'openExternal' }]);

  // Must exist BEFORE the pane mounts — terminal-pane only publishes into an already-created
  // registry (its test-observability hook is a no-op in production).
  await page.evaluate(() => {
    window.__terms = {};
    window.__confirms = [];
    window.__opens = [];
    window.confirm = (msg) => {
      window.__confirms.push(String(msg));
      // Answer OK: the old default handler only reached its broken window.open() after a yes,
      // so returning true is what lets this scenario observe the dead click rather than stop
      // one step short of it.
      return true;
    };
    const realOpen = window.open.bind(window);
    window.open = (...args) => {
      window.__opens.push(args.map(String));
      return realOpen(...args);
    };
  });

  const workDir = mkdtempSync(join(tmpdir(), 'conduit-osc8-'));
  const sid = await openSession(page, { path: workDir.replace(/\\/g, '/') });
  log('session running:', sid);
  await page.waitForFunction((id) => !!window.__terms?.[id], sid, { timeout: 20000 });

  // Let the shell finish printing its prompt BEFORE writing the link: output arriving after
  // the row is measured scrolls the link out from under the click.
  await page.waitForFunction((dir) => (window.__cap || '').includes(`${dir}>`), workDir, {
    timeout: 30000,
  });
  await page.waitForTimeout(500);

  // Write the hyperlink on its own fresh row and report where it landed.
  const cell = await page.evaluate(
    ({ id, url, label }) => {
      const term = window.__terms[id];
      const ESC = String.fromCharCode(27);
      const BEL = String.fromCharCode(7);
      return new Promise((resolve) => {
        term.write(`\r\n${ESC}]8;;${url}${BEL}${label}${ESC}]8;;${BEL}\r\n`, () => {
          const buf = term.buffer.active;
          let row = -1;
          for (let y = 0; y < buf.length; y++) {
            if (buf.getLine(y)?.translateToString(true).includes(label)) row = y;
          }
          // Off the term itself, not a document query: every session keeps its pane mounted
          // (hidden) so the PTY survives, and the first .xterm-screen in the document is
          // routinely a hidden one, which measures 0x0.
          const screen = term.element.querySelector('.xterm-screen');
          const r = screen.getBoundingClientRect();
          resolve({
            row,
            viewportY: buf.viewportY,
            cols: term.cols,
            rows: term.rows,
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          });
        });
      });
    },
    { id: sid, url: URL_UNDER_TEST, label: LABEL },
  );
  assert(cell.row >= 0, 'the OSC 8 label never made it into the terminal buffer');
  assert(
    cell.rect.w > 0 && cell.rect.h > 0,
    `the measured terminal is not on screen (${cell.rect.w}x${cell.rect.h}) — clicking it would prove nothing`,
  );

  const cellW = cell.rect.w / cell.cols;
  const cellH = cell.rect.h / cell.rows;
  const screenRow = cell.row - cell.viewportY;
  assert(
    screenRow >= 0 && screenRow < cell.rows,
    `the link row scrolled out of the viewport (row ${cell.row}, viewportY ${cell.viewportY})`,
  );
  // Middle of the label, comfortably inside the link's cells.
  const x = cell.rect.x + (LABEL.length / 2) * cellW;
  const y = cell.rect.y + (screenRow + 0.5) * cellH;
  log(
    `link row ${cell.row} (screen ${screenRow}), cell ${cellW.toFixed(1)}x${cellH.toFixed(1)}, click at ${x.toFixed(0)},${y.toFixed(0)}`,
  );

  // Hover first: xterm resolves links on hover, and the click must land on a live link.
  await page.mouse.move(x, y);
  await page.waitForTimeout(400);
  await page.mouse.click(x, y);
  await page.waitForTimeout(1200);

  const confirms = await page.evaluate(() => window.__confirms);
  const opens = await page.evaluate(() => window.__opens);
  const calls = await getSpyCalls(app);
  const external = calls.filter((c) => c.api === 'openExternal');

  assert(
    confirms.length === 0,
    `no confirm() may be shown for an OSC 8 link, got: ${JSON.stringify(confirms)}`,
  );
  assert(
    opens.length === 0,
    `the handler must not route through window.open, got: ${JSON.stringify(opens)}`,
  );
  assert(
    external.length === 1,
    `the host must be asked to open exactly one external url, got ${external.length}: ${JSON.stringify(external)}`,
  );
  assert(
    external[0].args[0] === URL_UNDER_TEST,
    `the host must receive the link's real url, got ${JSON.stringify(external[0].args[0])}`,
  );
  log(`clicked an OSC 8 link → host opened ${external[0].args[0]}, no dialog ✓`);
});
