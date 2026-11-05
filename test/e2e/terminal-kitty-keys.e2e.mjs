/**
 * Kitty keyboard protocol: after a program pushes `\x1b[>1u`, modified keys must reach the PTY as
 * CSI u sequences (Ctrl+Enter → `\x1b[13;5u`), not plain `\r`.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario, typeLine, writeToTerminal } from './harness.mjs';

delete process.env.CONDUIT_E2E;

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

await runScenario('terminal-kitty-keys', async ({ page, log }) => {
  await page.evaluate(() => {
    window.__terms = {};
  });
  const sid = await openSession(page, { path: work.replace(/\\/g, '/') });
  await page.waitForFunction((id) => !!window.__terms?.[id], sid, { timeout: 20000 });

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

  await page.waitForFunction((id) => (window.__capBy?.[id] ?? '').includes('1b5b3e31u'), sid, {
    timeout: 20000,
  });
  log('probe pushed kitty keyboard and entered raw mode');

  const drainPtyIn = () => page.evaluate(() => window.__ptyIn.splice(0).join(''));

  await drainPtyIn();
  await page.keyboard.press('Control+Enter');
  const kittyBytes = await drainPtyIn();
  assert(
    kittyBytes.includes('1b5b31333b3575'),
    `Ctrl+Enter with kitty mode should send \\x1b[13;5u, got ${JSON.stringify(kittyBytes)}`,
  );
  log('PASS: Ctrl+Enter encoded as kitty sequence ✓');

  await writeToTerminal(page, sid, '\x1b[<u');
  await drainPtyIn();
  await page.keyboard.press('Control+Enter');
  const legacyBytes = await drainPtyIn();
  assert(
    legacyBytes.includes('\r') || legacyBytes.includes('0d'),
    `Ctrl+Enter after pop should send legacy CR, got ${JSON.stringify(legacyBytes)}`,
  );
  log('PASS: after pop, Ctrl+Enter sends legacy \\r ✓');
});
