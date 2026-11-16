#!/usr/bin/env node
// CommonJS on purpose: spawned by path from e2e and unit tests, and the e2e fixtures glob is cjs.
// Test-only stand-in for the system ssh. It takes the ssh argv that sshArgv builds, runs the
// POSIX-quoted remote command locally with stdio inherited, and so needs no shell or sshd.

const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');

const failText = process.env.FAKE_SSH_FAIL;
if (failText !== undefined) {
  process.stderr.write(`${failText}\n`);
  process.exit(255);
}

// Parses exactly what posixQuote produces: single-quoted segments, with `'\''` as an escaped quote.
function parseRemote(text) {
  const out = [];
  let current = '';
  let inToken = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) throw new Error('unterminated quote');
      current += text.slice(i + 1, close);
      inToken = true;
      i = close + 1;
    } else if (c === '\\') {
      current += text[i + 1] ?? '';
      inToken = true;
      i += 2;
    } else if (c === ' ') {
      if (inToken) out.push(current);
      current = '';
      inToken = false;
      i += 1;
    } else {
      current += c;
      inToken = true;
      i += 1;
    }
  }
  if (inToken) out.push(current);
  return out;
}

// A remote string that is not a POSIX-quoted argv (the bootstrap's sh scripts, or a plain command
// line) runs through the platform shell, as sshd does. Requoting the parse proves it is exact.
function posixArgvOf(text) {
  let parsed;
  try {
    parsed = parseRemote(text);
  } catch {
    return null;
  }
  const requoted = parsed.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  return requoted === text && parsed.length > 0 ? parsed : null;
}

const argv = process.argv.slice(2);
const dashdash = argv.indexOf('--');
if (dashdash < 0 || argv.length !== dashdash + 3) {
  process.stderr.write('fake-ssh: expected options, --, target, remote command\n');
  process.exit(2);
}

const remoteText = argv[dashdash + 2];
const posixArgv = posixArgvOf(remoteText);
// A scenario that needs a remote with none of this machine's CLIs points HOME at an empty dir: the
// probe reads ~/.local/bin, where the installers put them.
const remoteEnv =
  process.env.FAKE_SSH_HOME === undefined
    ? process.env
    : { ...process.env, HOME: process.env.FAKE_SSH_HOME };
const child = posixArgv
  ? spawn(posixArgv[0], posixArgv.slice(1), {
      stdio: 'inherit',
      windowsHide: true,
      env: remoteEnv,
    })
  : process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', `"${remoteText}"`], {
        stdio: 'inherit',
        windowsHide: true,
        windowsVerbatimArguments: true,
        env: remoteEnv,
      })
    : spawn('/bin/sh', ['-c', remoteText], {
        stdio: 'inherit',
        windowsHide: true,
        env: remoteEnv,
      });
const pidLine = `fake-ssh: pid ${child.pid}\n`;
process.stderr.write(pidLine);
// A scenario reads child pids from this file, so it needs no shell to redirect stderr.
if (process.env.FAKE_SSH_STDERR_LOG) appendFileSync(process.env.FAKE_SSH_STDERR_LOG, pidLine);

// Signals to the stand-in reach the command it runs, so a test that kills the ssh child does not
// leave the remote command orphaned.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  process.stderr.write(`fake-ssh: ${error.message}\n`);
  process.exit(127);
});
child.on('exit', (code) => process.exit(code ?? 1));
