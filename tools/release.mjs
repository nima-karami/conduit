import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { findReleaseTreeProof } from '../test/e2e/ci-full-proof.mjs';

const UNRELEASED = /^## \[Unreleased\][^\S\r\n]*\r?\n/m;
const SECTION = /^## \[/m;
const BULLET = /^[-*+]\s+\S/m;
const STATUS_VERSION = /^(> \*\*Status:\*\*[^\n]*?\(`v)(\d+\.\d+\.\d+)(`\))/m;

export function nextReleaseVersion(current, bump) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(current);
  if (!match || !['patch', 'minor', 'major'].includes(bump))
    throw new Error('Expected a stable version and a patch, minor or major bump');
  const [, major, minor, patch] = match;
  if (bump === 'major') return `${BigInt(major) + 1n}.0.0`;
  return bump === 'minor'
    ? `${major}.${BigInt(minor) + 1n}.0`
    : `${major}.${minor}.${BigInt(patch) + 1n}`;
}

function splitSection(text) {
  const end = text.search(SECTION);
  return end === -1 ? [text, ''] : [text.slice(0, end), text.slice(end)];
}

export function releaseChangelog(changelog, version, date) {
  const header = UNRELEASED.exec(changelog);
  if (!header) throw new Error('CHANGELOG.md needs an Unreleased heading');
  const end = header.index + header[0].length;
  const [notes, older] = splitSection(changelog.slice(end));
  const prefix = `${changelog.slice(0, header.index)}## [Unreleased]\n\n`;
  const title = `## [${version}]`;
  if (changelog.split(/\r?\n/).some((line) => line === title || line.startsWith(`${title} `))) {
    if (notes.trim() || !older.startsWith(`${title} — `)) {
      throw new Error(
        `Resolve the existing ${version} section and Unreleased before preparing the release`,
      );
    }
    const [planned, remainder] = splitSection(older.slice(older.indexOf('\n') + 1));
    if (!BULLET.test(planned)) throw new Error(`Add release notes to CHANGELOG.md for ${version}`);
    return `${prefix}${title} — ${date}\n${planned}${remainder}`;
  }
  if (!BULLET.test(notes))
    throw new Error('Add at least one release note under Unreleased in CHANGELOG.md');
  return `${prefix}${title} — ${date}\n\n${notes.trim()}\n\n${older}`;
}

export function releaseReadme(readme, current, version) {
  const status = STATUS_VERSION.exec(readme);
  if (status?.[2] !== current) throw new Error(`README.md status must show v${current}`);
  return readme.replace(
    STATUS_VERSION,
    (_match, prefix, _version, suffix) => `${prefix}${version}${suffix}`,
  );
}

const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();

function requireCleanTree() {
  if (git('status', '--porcelain')) throw new Error('Commit or stash working tree changes first');
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function prepareRelease(pkg, bump, allowNonMain) {
  if (!allowNonMain) {
    git('fetch', 'origin', 'main');
    if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
      throw new Error('Prepare from origin/main or pass --allow-non-main');
    }
  }
  const current = pkg.version;
  const next = nextReleaseVersion(current, bump);
  const date = new Date().toISOString().slice(0, 10);
  const readme = releaseReadme(readFileSync('README.md', 'utf8'), current, next);
  const changelog = releaseChangelog(readFileSync('CHANGELOG.md', 'utf8'), next, date);
  const lock = readJson('package-lock.json');
  if (lock.version !== current || lock.packages?.['']?.version !== current) {
    throw new Error('package-lock.json version must match package.json');
  }
  const updates = {
    'README.md': readme,
    'CHANGELOG.md': changelog,
    'package.json': `${JSON.stringify({ ...pkg, version: next }, null, 2)}\n`,
    'package-lock.json': `${JSON.stringify(
      {
        ...lock,
        version: next,
        packages: { ...lock.packages, '': { ...lock.packages[''], version: next } },
      },
      null,
      2,
    )}\n`,
  };
  const branch = `release/v${next}`;
  git('switch', '-c', branch);
  for (const [file, text] of Object.entries(updates)) writeFileSync(file, text);
  git('add', '--', ...Object.keys(updates));
  git('commit', '-m', `release: v${next}`);
  console.log(
    `Prepared ${branch} at ${git('rev-parse', '--short', 'HEAD')}. Run npm run e2e:remote -- --full on this tree.`,
  );
}

function tagRelease(version) {
  if (git('branch', '--show-current') !== 'main') throw new Error('Tag from the main branch');
  const tag = `v${version}`;
  const branch = `release/${tag}`;
  const sha = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', `${sha}^{tree}`);
  const prepared = git('rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
  if (
    git('merge-base', sha, prepared) !== prepared ||
    git('rev-parse', `${prepared}^{tree}`) !== tree
  ) {
    throw new Error(`Fast-forward main to ${branch} before tagging`);
  }
  const repo = execFileSync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    {
      encoding: 'utf8',
    },
  ).trim();
  const proof = findReleaseTreeProof(repo, tree);
  if (!proof)
    throw new Error(
      `No passing full e2e proof for tree ${tree}. Run npm run e2e:remote -- --full before tagging.`,
    );
  git('tag', '-a', tag, sha, '-m', `Conduit ${tag}`);
  console.log(`Created local tag ${tag} at ${sha} using ${proof.html_url}`);
}

function main([action = 'patch', ...extra]) {
  const allowNonMain = extra.length === 1 && extra[0] === '--allow-non-main' && action !== 'tag';
  if ((extra.length && !allowNonMain) || !['patch', 'minor', 'major', 'tag'].includes(action)) {
    throw new Error(
      'Usage: npm run release -- patch|minor|major [--allow-non-main] or npm run release -- tag',
    );
  }
  requireCleanTree();
  const pkg = readJson('package.json');
  if (action === 'tag') tagRelease(pkg.version);
  else prepareRelease(pkg, action, allowNonMain);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[release] ${error.message}`);
    process.exitCode = 1;
  }
}
