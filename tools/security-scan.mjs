// Local SAST runner (best-effort). Semgrep has no native Windows build, so locally
// we use it via PATH (Linux/macOS/WSL) or the official Docker image, and otherwise
// skip with a notice. The AUTHORITATIVE security gate runs in CI (.github/workflows
// /verify.yml), where Semgrep runs natively on Linux. This keeps `npm run verify`
// unblocked on a Windows dev box while still guaranteeing the gate on every push/PR.
import { spawnSync } from 'node:child_process';

const RULESETS = ['p/javascript', 'p/typescript', 'p/react'];
const EXCLUDES = ['node_modules', 'out', 'dist', 'designs'];
const configArgs = RULESETS.flatMap((r) => ['--config', r]);
const excludeArgs = EXCLUDES.flatMap((e) => ['--exclude', e]);

const has = (cmd, args = ['--version']) => {
  const r = spawnSync(cmd, args, { stdio: 'ignore', shell: process.platform === 'win32' });
  return r.status === 0;
};

const run = (cmd, args) => {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  return r.status ?? 1;
};

let code;
if (has('semgrep')) {
  code = run('semgrep', ['scan', ...configArgs, ...excludeArgs, '--error']);
} else if (has('docker', ['info'])) {
  const mount = `${process.cwd()}:/src`;
  code = run('docker', [
    'run',
    '--rm',
    '-v',
    mount,
    '-w',
    '/src',
    'semgrep/semgrep',
    'semgrep',
    'scan',
    ...configArgs,
    ...excludeArgs,
    '--error',
  ]);
} else {
  console.log(
    '⚠ Semgrep skipped locally: no `semgrep` on PATH and Docker is unavailable.\n' +
      '  The security gate runs in CI (.github/workflows/verify.yml). To scan locally,\n' +
      '  start Docker Desktop, or `pipx install semgrep` (Linux/macOS/WSL).',
  );
  code = 0;
}
process.exit(code);
