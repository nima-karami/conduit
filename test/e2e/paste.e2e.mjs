// End-to-end regression test for terminal paste (Windows / ConPTY).
//
// Guards the fix in webview/components/terminal-pane.tsx: because the app removes
// the native Edit menu (Menu.setApplicationMenu(null)), Ctrl+V has no accelerator,
// so the terminal handles it itself and routes through xterm's paste() — which
// applies BRACKETED-paste mode. Without that, a multi-line paste reaches a TUI
// (e.g. Claude Code) as N separate lines and gets garbled.
//
// This launches the REAL built app, runs a bracketed-paste-aware reader in a real
// shell (it enables ESC[?2004h so xterm brackets, and ENABLE_VIRTUAL_TERMINAL_INPUT
// so ConPTY forwards the markers), presses a real Ctrl+V, and asserts the child
// received the paste wrapped in ESC[200~ … ESC[201~.
//
// NOT part of `npm run verify` (needs a real Electron GUI; CI is headless Linux).
// Windows only. Run locally:  npm run build && node test/e2e/paste.e2e.mjs
// Requires Playwright (a devDependency, or present in the npx cache).

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(here, '..', '..');
const require = createRequire(import.meta.url);

if (process.platform !== 'win32') {
  console.log('[paste-e2e] SKIP — this test targets Windows ConPTY bracketed paste.');
  process.exit(0);
}

function loadPlaywright() {
  const candidates = [join(REPO, 'node_modules', 'playwright', 'index.js')];
  for (const root of [
    join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx'),
    join(homedir(), '.npm', '_npx'),
  ].filter(Boolean)) {
    try {
      for (const d of readdirSync(root)) {
        candidates.push(join(root, d, 'node_modules', 'playwright', 'index.js'));
      }
    } catch {}
  }
  for (const p of candidates) if (existsSync(p)) return require(p);
  throw new Error('Playwright not found — `npm i -D playwright` or run `npx playwright` once.');
}

// A PowerShell reader: enables ENABLE_VIRTUAL_TERMINAL_INPUT (so ConPTY forwards the
// bracketed-paste markers) + ESC[?2004h (so xterm brackets the paste), reads stdin,
// and reports whether the ESC[200~/ESC[201~ markers arrived.
const READER = join(mkdtempSync(join(tmpdir(), 'conduit-paste-')), 'reader.ps1');
writeFileSync(
  READER,
  `$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class K {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr h, out uint m);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr h, uint m);
}
"@
$h = [K]::GetStdHandle(-10)
[uint32]$m = 0
[void][K]::GetConsoleMode($h, [ref]$m)
$new = ($m -bor 0x0200) -band (-bnot 0x0002) -band (-bnot 0x0004) -band (-bnot 0x0001)
[void][K]::SetConsoleMode($h, $new)
$esc = [char]27
[Console]::Out.Write("$esc[?2004h")
[Console]::Out.WriteLine("READY")
$in  = [Console]::OpenStandardInput()
$buf = New-Object byte[] 8192
$acc = New-Object System.Collections.Generic.List[byte]
while ($true) {
  $n = $in.Read($buf, 0, $buf.Length)
  if ($n -le 0) { break }
  for ($i = 0; $i -lt $n; $i++) { $acc.Add($buf[$i]) }
  $s = -join ($acc.ToArray() | ForEach-Object { [char]$_ })
  if ($s.Contains("$esc[201~") -or $s.Contains("ZZEND")) { break }
}
$s = -join ($acc.ToArray() | ForEach-Object { [char]$_ })
"has200=$($s.Contains("$esc[200~")) has201=$($s.Contains("$esc[201~"))" | Out-File $env:DUMP -Encoding ascii
`,
);

const DUMP = join(mkdtempSync(join(tmpdir(), 'conduit-dump-')), 'd.txt');
writeFileSync(DUMP, '');
const payload = `${Array.from({ length: 25 }, (_, i) => `line-${i}-${'x'.repeat(20)}`).join('\n')}ZZEND`;
const log = (...a) => console.log('[paste-e2e]', ...a);
const { _electron } = loadPlaywright();
const electronPath = require('electron');

let app;
try {
  const ud = mkdtempSync(join(tmpdir(), 'conduit-ud-'));
  app = await _electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${ud}`, REPO],
    cwd: REPO,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await page.evaluate(() => {
    window.__cap = '';
    window.__sessions = [];
    window.agentDeck.subscribe((m) => {
      if (m.type === 'term:data') window.__cap += m.data;
      if (m.type === 'state') window.__sessions = m.sessions || [];
    });
  });
  await page.evaluate(
    (repo) => window.agentDeck.post({ type: 'openRepo', path: repo, agentId: 'shell:cmd' }),
    REPO.replace(/\\/g, '/'),
  );
  await page.waitForSelector('.termpane', { timeout: 25000 });
  const sid = await page
    .waitForFunction(() => window.__sessions[window.__sessions.length - 1]?.id || null, null, {
      timeout: 20000,
    })
    .then((h) => h.jsonValue());
  await page.waitForFunction(() => window.__cap.length > 0, null, { timeout: 20000 });

  await page.evaluate(
    ({ sid, reader, dump }) => {
      window.__cap = '';
      window.agentDeck.post({
        type: 'term:input',
        sessionId: sid,
        data: `set "DUMP=${dump}" && powershell -NoProfile -ExecutionPolicy Bypass -File "${reader}"\r`,
      });
    },
    { sid, reader: READER.replace(/\\/g, '/'), dump: DUMP.replace(/\\/g, '/') },
  );
  await page.waitForFunction(() => window.__cap.includes('READY'), null, { timeout: 15000 });
  await page.waitForTimeout(900); // let xterm process ESC[?2004h

  // Real Ctrl+V — exercises the terminal-pane handler → xterm.paste() (bracketed).
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), payload);
  await page.click('.termpane');
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+V');
  log(`pressed Ctrl+V (25-line paste)`);
  await page.waitForTimeout(2500);
  await app.close();

  const result = existsSync(DUMP) ? readFileSync(DUMP, 'utf8').trim() : '(no dump)';
  const pass = /has200=True/.test(result) && /has201=True/.test(result);
  log(`child received: ${result}`);
  if (pass) {
    log('PASS ✓ Ctrl+V delivered a bracketed paste (ESC[200~ … ESC[201~) intact');
    process.exit(0);
  }
  log('FAIL ✗ paste was not bracketed — a multi-line paste would garble in a TUI');
  process.exit(1);
} catch (e) {
  console.error('[paste-e2e] ERROR:', e?.message || e);
  try {
    await app?.close();
  } catch {}
  process.exit(2);
}
