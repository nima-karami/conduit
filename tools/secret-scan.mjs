// Local secret scanner (best-effort), mirroring tools/security-scan.mjs. gitleaks
// HAS a native Windows build, so we prefer it on PATH; otherwise we fall back to
// the official Docker image, and otherwise skip with a notice. The AUTHORITATIVE
// secret gate runs in CI (.github/workflows/verify.yml), where gitleaks scans the
// full git history at a pinned version. Locally we scan the working tree (`dir`),
// which is fast and needs no git, keeping `npm run verify` unblocked everywhere.
import { has, run } from './scan-helpers.mjs';

// `gitleaks dir .` scans the working tree without needing git history; `--redact`
// keeps any finding out of logs; non-zero exit on a leak is the default.
let code;
if (has('gitleaks', ['version'])) {
  code = run('gitleaks', ['dir', '.', '--redact', '--no-banner']);
} else if (has('docker', ['info'])) {
  const mount = `${process.cwd()}:/repo`;
  code = run('docker', [
    'run',
    '--rm',
    '-v',
    mount,
    '-w',
    '/repo',
    'ghcr.io/gitleaks/gitleaks:v8.30.1',
    'dir',
    '/repo',
    '--redact',
    '--no-banner',
  ]);
} else {
  console.log(
    '⚠ gitleaks skipped locally: no `gitleaks` on PATH and Docker is unavailable.\n' +
      '  The secret gate runs in CI (.github/workflows/verify.yml). To scan locally,\n' +
      '  install gitleaks (https://github.com/gitleaks/gitleaks) or start Docker Desktop.',
  );
  code = 0;
}
process.exit(code);
