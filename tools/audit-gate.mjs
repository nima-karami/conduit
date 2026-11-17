// The `npm run audit` gate: fail on any high or critical advisory, except an owner-approved,
// dev-only, expiring exception in audit-exceptions.json. Rules live in tools/audit-policy.mjs.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { judgeAudit } from './audit-policy.mjs';

function auditJson(args) {
  try {
    return JSON.parse(execSync(`npm audit --json ${args.join(' ')}`, { encoding: 'utf8' }));
  } catch (err) {
    // npm audit exits non-zero whenever it finds anything; its JSON is still on stdout.
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

const allowlist = JSON.parse(readFileSync('audit-exceptions.json', 'utf8')).exceptions;
const latest = {};
for (const entry of allowlist) {
  latest[entry.package] = execSync(`npm view ${entry.package} version`, {
    encoding: 'utf8',
  }).trim();
}

const { failures, allowed } = judgeAudit({
  full: auditJson([]),
  prod: auditJson(['--omit=dev']),
  allowlist,
  latest,
  today: new Date().toISOString().slice(0, 10),
});

for (const line of allowed) console.log(`⚠ allowed by exception: ${line}`);
if (failures.length > 0) {
  for (const line of failures) console.error(`✖ ${line}`);
  process.exit(1);
}
console.log('audit: no high or critical advisories outside approved exceptions');
