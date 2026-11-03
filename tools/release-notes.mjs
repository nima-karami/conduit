import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const [rawVersion, changelogPath = 'CHANGELOG.md', outputPath = 'build/release-notes.md'] =
  process.argv.slice(2);
if (!rawVersion)
  throw new Error('Usage: node tools/release-notes.mjs <version> [changelog] [output]');
const version = rawVersion.replace(/^v/, '');
const scratchRoot = join(tmpdir(), 'conduit-release-notes');
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, 'release-notes-'));
try {
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  await esbuild.build({
    absWorkingDir: projectRoot,
    entryPoints: ['src/changelog.ts', 'src/git-exec.ts'],
    outdir: scratch,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const require = createRequire(import.meta.url);
  const { changelogSection } = require(join(scratch, 'changelog.js'));
  const section = changelogSection(readFileSync(resolve(changelogPath), 'utf8'), version);
  if (!section) throw new Error(`CHANGELOG.md has no non-empty section for ${version}`);

  const { runGitBin } = require(join(scratch, 'git-exec.js'));
  const tag = rawVersion.startsWith('v') ? rawVersion : `v${version}`;
  const gitResult = await runGitBin('git', ['describe', '--tags', '--abbrev=0', `${tag}^`], {
    cwd: process.cwd(),
    timeoutMs: 5000,
  });
  if (!gitResult.ok) {
    const detail = gitResult.timedOut
      ? 'timed out after 5000 ms'
      : gitResult.notFound
        ? 'git was not found on PATH'
        : gitResult.stderr.trim() || `exited with code ${gitResult.code}`;
    throw new Error(`Could not find the previous release tag for ${tag}: ${detail}`);
  }
  const previousTag = gitResult.stdout.trim();
  const fullChangelog = `\n\n[Full changelog](https://github.com/nima-karami/conduit/compare/${previousTag}...${tag})\n`;
  const output = resolve(outputPath);
  mkdirSync(resolve(output, '..'), { recursive: true });
  writeFileSync(output, `${section}${fullChangelog}`, 'utf8');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
