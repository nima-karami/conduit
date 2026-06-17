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

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  launchApp,
  loadPlaywright,
  makeLog,
  openSession,
  REPO,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[paste] SKIP — this test targets Windows ConPTY bracketed paste.');
  process.exit(0);
}

// A PowerShell reader: enables ENABLE_VIRTUAL_TERMINAL_INPUT (so ConPTY forwards the
// bracketed-paste markers) + ESC[?2004h (so xterm brackets the paste), reads stdin,
// and reports whether the ESC[200~/ESC[201~ markers arrived.
const READER_SCRIPT = `$ErrorActionPreference = 'Stop'
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
`;

const DUMP = join(mkdtempSync(join(tmpdir(), 'conduit-dump-')), 'd.txt');
writeFileSync(DUMP, '');
const payload = `${Array.from({ length: 25 }, (_, i) => `line-${i}-${'x'.repeat(20)}`).join('\n')}ZZEND`;
const log = makeLog('paste');

// Ensure Playwright is loadable before we do anything expensive.
loadPlaywright();

const { createRequire } = await import('node:module');
const _require = createRequire(import.meta.url);

// Pre-compile the Add-Type C# assembly in a separate PowerShell process running
// in PARALLEL with the Electron launch.  The reader script then uses
// -ReferencedAssemblies to load the pre-compiled DLL — no inline compilation.
// This avoids the 30-90s csc.exe cold-start under in-suite load.
const preCompileDir = mkdtempSync(join(tmpdir(), 'conduit-ktype-'));
const kDll = join(preCompileDir, 'K.dll');
const preCompileScript = `
Add-Type -OutputAssembly "${kDll.replace(/\\/g, '\\\\')}" @"
using System;
using System.Runtime.InteropServices;
public static class K {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr h, out uint m);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr h, uint m);
}
"@
Write-Output "COMPILED"
`;
const preCompilePath = join(preCompileDir, 'compile.ps1');
writeFileSync(preCompilePath, preCompileScript);

// Kick off compilation now (runs in background while Electron launches).
log('pre-compiling K.dll in background...');
const compileProc = spawn(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', preCompilePath],
  { stdio: 'pipe' },
);

// Wait for compilation to finish (with generous timeout; runs in parallel with
// Electron launch so the wall-clock cost is near zero on a warm machine).
const compileDone = new Promise((resolve) => {
  compileProc.on('close', (code) => resolve(code));
});

// Update reader to load the pre-compiled assembly instead of compiling inline.
const READER_SCRIPT_PRECOMPILED = (dll) => `$ErrorActionPreference = 'Stop'
Add-Type -Path "${dll.replace(/\\/g, '\\\\')}"
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
`;

let launched;
try {
  // Launch Electron in parallel with the Add-Type compilation.
  launched = await launchApp();
  const { app, page } = launched;

  await tapBridge(page);

  // Wait for initial terminal output before launching the reader.
  const sid = await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });
  await page.waitForFunction(() => window.__cap.length > 0, null, { timeout: 20000 });

  // Wait for the pre-compilation to finish (it started above, in parallel).
  log('waiting for K.dll compilation to complete...');
  const compileExit = await compileDone;
  log(`K.dll compilation exited with code ${compileExit}`);

  // Choose the reader script: use the pre-compiled DLL if available, otherwise
  // fall back to the inline Add-Type version (for solo runs on a cold machine).
  const usePrecompiled = compileExit === 0 && existsSync(kDll);
  const readerContent = usePrecompiled ? READER_SCRIPT_PRECOMPILED(kDll) : READER_SCRIPT;
  log(usePrecompiled ? 'using pre-compiled K.dll' : 'falling back to inline Add-Type');

  // Launch the bracketed-paste reader.
  const readerDir = mkdtempSync(join(tmpdir(), 'conduit-paste-'));
  const readerPath = join(readerDir, 'reader.ps1');
  writeFileSync(readerPath, readerContent);

  await page.evaluate(
    ({ sid: s, reader, dump }) => {
      window.__cap = '';
      window.agentDeck.post({
        type: 'term:input',
        sessionId: s,
        data: `set "DUMP=${dump}" && powershell -NoProfile -ExecutionPolicy Bypass -File "${reader}"\r`,
      });
    },
    { sid, reader: readerPath.replace(/\\/g, '/'), dump: DUMP.replace(/\\/g, '/') },
  );
  // READY arrives once the reader starts (after DLL load + ESC[?2004h).
  // When the pre-compiled DLL is used, this is near-instant (<1s).
  // If we fell back to inline Add-Type, allow up to 120s for csc.exe under load.
  await page.waitForFunction(() => window.__cap.includes('READY'), null, { timeout: 120000 });
  await page.waitForTimeout(900); // let xterm process ESC[?2004h

  // Real Ctrl+V — exercises the terminal-pane handler → xterm.paste() (bracketed).
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), payload);
  // Use the visible termpane (there may be multiple if the app auto-opened a session
  // from the REPO argument; pick the one that's actually visible/active).
  await page.click('.termpane:visible');
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+V');
  log('pressed Ctrl+V (25-line paste)');
  await page.waitForTimeout(2500);
  await launched.cleanup();

  const result = existsSync(DUMP) ? readFileSync(DUMP, 'utf8').trim() : '(no dump)';
  log(`child received: ${result}`);

  assert(
    /has200=True/.test(result) && /has201=True/.test(result),
    `paste was not bracketed — a multi-line paste would garble in a TUI. Got: ${result}`,
  );

  log('PASS ✓ Ctrl+V delivered a bracketed paste (ESC[200~ … ESC[201~) intact');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    log('FAIL ✗', e.message);
    process.exit(1);
  }
  console.error('[paste] ERROR:', e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  process.exit(2);
}
