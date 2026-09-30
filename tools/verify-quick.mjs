/**
 * `npm run verify:quick` — the inner-loop check: Biome on the files changed since the merge-base
 * with origin/main (committed, uncommitted and untracked), both tsconfigs incrementally, and
 * `vitest --changed`. Not a gate: `npm run verify` is, unchanged (CLAUDE.md). Spec
 * docs/specs/archive/2026-09-29-remote-e2e-lean-loop.md §B6.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TSCONFIGS = ['tsconfig.json', 'tsconfig.webview.json'];
/** Each tool's JS entry, run with this node: no shell, so file names are passed as-is. */
const BIN = {
  biome: join('node_modules', '@biomejs', 'biome', 'bin', 'biome'),
  tsc: join('node_modules', 'typescript', 'bin', 'tsc'),
  vitest: join('node_modules', 'vitest', 'vitest.mjs'),
};

/**
 * The steps, in order. Build info lives under node_modules/.cache, which a worktree may share
 * through a junction, so its file name carries a hash of the checkout path.
 *
 * @param {{ files: string[], base: string, cwd: string }} o
 * @returns {{ name: string, tool: 'biome' | 'tsc' | 'vitest', args: string[] }[]}
 */
export function quickSteps({ files, base, cwd }) {
  const tag = createHash('sha256').update(cwd).digest('hex').slice(0, 8);
  const steps = [];
  if (files.length) {
    steps.push({
      name: `biome (${files.length} file(s))`,
      tool: 'biome',
      args: ['check', '--no-errors-on-unmatched', '--files-ignore-unknown=true', ...files],
    });
  }
  for (const cfg of TSCONFIGS) {
    steps.push({
      name: `tsc ${cfg}`,
      tool: 'tsc',
      args: [
        '-p',
        cfg,
        '--noEmit',
        '--incremental',
        '--tsBuildInfoFile',
        join('node_modules', '.cache', 'verify-quick', `${cfg}-${tag}.tsbuildinfo`),
      ],
    });
  }
  steps.push({ name: 'vitest --changed', tool: 'vitest', args: ['run', '--changed', base] });
  return steps;
}

function git(...args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.split('\n').filter(Boolean);
}

function main() {
  const [base] = git('merge-base', 'HEAD', 'origin/main');
  const files = [
    ...new Set([
      ...git('diff', '--name-only', '--diff-filter=d', base),
      ...git('ls-files', '--others', '--exclude-standard'),
    ]),
  ].sort();
  mkdirSync(join('node_modules', '.cache', 'verify-quick'), { recursive: true });
  console.log(`[verify:quick] ${files.length} changed file(s) since ${base.slice(0, 7)}`);
  let failed = 0;
  for (const step of quickSteps({ files, base, cwd: process.cwd() })) {
    const t = Date.now();
    const r = spawnSync(process.execPath, [BIN[step.tool], ...step.args], { stdio: 'inherit' });
    const s = ((Date.now() - t) / 1000).toFixed(1);
    console.log(`[verify:quick] ${r.status === 0 ? 'ok  ' : 'FAIL'} ${step.name} (${s}s)`);
    if (r.status !== 0) failed++;
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
