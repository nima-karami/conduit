/**
 * Kitty keyboard protocol: after a program pushes `\x1b[>1u`, modified keys must reach the PTY as
 * CSI u sequences (Ctrl+Enter → `\x1b[13;5u`), not plain `\r`.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  openSession,
  runScenario,
  tapBridge,
  typeLine,
  writeToTerminal,
} from './harness.mjs';

const work = mkdtempSync(join(tmpdir(), 'conduit-kitty-keys-'));
const probeScript = join(work, 'probe.mjs');
writeFileSync(
  probeScript,
  `process.stdout.write('\\x1b[>1u');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (d) => {
  process.stdout.write(Buffer.from(d).toString('hex') + '\\n');
});
`,
);

await runScenario('terminal-kitty-keys', async ({ app, page, log }) => {
  await page.evaluate(() => {
    window.__terms = {};
  });
  await tapBridge(page);

  const sid = await openSession(page, { path: work.replace(/\\/g, '/') });
  await page.locator(`.session[data-sessionid="${sid}"]`).click();
  await page.waitForSelector(`.session--active[data-sessionid="${sid}"]`, { timeout: 5000 });
  await page.waitForFunction((id) => !!window.__terms?.[id], sid, { timeout: 20000 });
  await page.waitForFunction((id) => (window.__terms?.[id]?.element?.offsetWidth ?? 0) > 0, sid, {
    timeout: 20000,
  });

  await page.evaluate((id) => {
    window.__ptyIn = [];
    window.__terms[id].onData((d) => window.__ptyIn.push(d));
  }, sid);

  await page.waitForFunction(
    (id) => {
      const buf = window.__terms[id].buffer.active;
      for (let i = 0; i < buf.length; i++) {
        if (/>\s*$/.test(buf.getLine(i)?.translateToString(true) ?? '')) return true;
      }
      return false;
    },
    sid,
    { timeout: 20000 },
  );

  await page.evaluate((id) => window.__terms[id].focus(), sid);
  await typeLine(page, sid, `node "${probeScript.replace(/\\/g, '/')}"`);

  await page.waitForFunction((id) => (window.__capBy?.[id] ?? '').includes('\x1b[>1u'), sid, {
    timeout: 20000,
  });
  log('probe pushed kitty keyboard and entered raw mode');

  const drainPtyIn = () => page.evaluate(() => window.__ptyIn.splice(0).join(''));
  const pressCtrlEnter = async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['control'] });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['control'] });
    });
    await page.waitForFunction(() => window.__ptyIn.length > 0);
  };

  await drainPtyIn();
  await pressCtrlEnter();
  const kittyBytes = await drainPtyIn();
  assert(
    kittyBytes === '\x1b[13;5u',
    `Ctrl+Enter with kitty mode should send \\x1b[13;5u, got ${JSON.stringify(kittyBytes)}`,
  );
  log('PASS: Ctrl+Enter encoded as kitty sequence ✓');

  await writeToTerminal(page, sid, '\x1b[<u');
  await drainPtyIn();
  await pressCtrlEnter();
  const legacyBytes = await drainPtyIn();
  assert(
    legacyBytes === '\r',
    `Ctrl+Enter after pop should send legacy CR, got ${JSON.stringify(legacyBytes)}`,
  );
  log('PASS: after pop, Ctrl+Enter sends legacy \\r ✓');
});
