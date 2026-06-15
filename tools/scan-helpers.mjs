// Shared spawn helpers for the best-effort local security scanners
// (security-scan.mjs = Semgrep, secret-scan.mjs = gitleaks). `shell: true` on
// Windows so PATH lookups resolve .cmd/.exe shims.
import { spawnSync } from 'node:child_process';

export const has = (cmd, args = ['--version']) => {
  const r = spawnSync(cmd, args, { stdio: 'ignore', shell: process.platform === 'win32' });
  return r.status === 0;
};

export const run = (cmd, args) => {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  return r.status ?? 1;
};
