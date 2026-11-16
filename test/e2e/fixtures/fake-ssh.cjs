#!/usr/bin/env node
// CommonJS on purpose: spawned by path from e2e and unit tests, and the e2e fixtures glob is cjs.
// Test-only stand-in for the system ssh. It takes the ssh argv that sshArgv builds, runs the
// POSIX-quoted remote command locally with stdio inherited, and so needs no shell or sshd.

const { spawn } = require('node:child_process');

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

const argv = process.argv.slice(2);
const dashdash = argv.indexOf('--');
if (dashdash < 0 || argv.length !== dashdash + 3) {
  process.stderr.write('fake-ssh: expected options, --, target, remote command\n');
  process.exit(2);
}

let remote;
try {
  remote = parseRemote(argv[dashdash + 2]);
} catch (error) {
  process.stderr.write(`fake-ssh: ${error.message}\n`);
  process.exit(2);
}

const [command, ...args] = remote;
const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
process.stderr.write(`fake-ssh: pid ${child.pid}\n`);

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
