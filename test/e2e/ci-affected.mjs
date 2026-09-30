/**
 * `--affected`: which e2e scenarios a diff needs (spec docs/specs/2026-09-29-remote-e2e-lean-loop.md
 * §B2, rules in order). `e2e:remote` applies only the first two rules client-side; the `prepare` job
 * of .github/workflows/e2e.yml runs this file as a CLI, which applies all of them.
 *
 * CLI: `node test/e2e/ci-affected.mjs <base sha | ''> <coverage-map.json> <out.json>`.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FULL = [
  /^test\/e2e\//,
  /^electron\/main\.ts$/,
  /^electron\/preload\.ts$/,
  /^esbuild\.mjs$/,
  /^package(-lock)?\.json$/,
  /^\.github\/workflows\/e2e\.yml$/,
];
// Shipped or read by scenarios at runtime, whatever the extension (skills' SKILL.md, fixtures).
const NEVER_IRRELEVANT = [/^test\/e2e\//, /^resources\//];
const IRRELEVANT = [/^test\/unit\//, /^docs\//, /\.md$/i, /^designs\//, /^\.conduit\//];
const CODE = /\.tsx?$/;
export const MAP_SCHEMA = 2;

function isFullTrigger(path) {
  return FULL.some((re) => re.test(path));
}

export function isE2eIrrelevant(path) {
  if (NEVER_IRRELEVANT.some((re) => re.test(path))) return false;
  if (path.startsWith('.github/')) return path !== '.github/workflows/e2e.yml';
  return IRRELEVANT.some((re) => re.test(path));
}

/** `git diff --name-status` output → changes; a rename is a delete plus an add, a copy an add. */
export function parseNameStatus(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const [code, a, b] = line.split('\t');
    if (!code || !a) continue;
    if (code[0] === 'R' || code[0] === 'C') {
      if (code[0] === 'R') out.push({ path: a, status: 'D' });
      out.push({ path: b, status: 'A' });
    } else out.push({ path: a, status: code[0] === 'A' || code[0] === 'D' ? code[0] : 'M' });
  }
  return out;
}

/**
 * `git diff -U0 --no-renames <map build> HEAD` → per file, the BASE-side hunks: `{ start, count }`
 * are 1-based lines of the map build's copy; `count` 0 is a pure insertion after line `start`.
 * `absent`: the file did not exist in the map build.
 */
export function parseZeroContextDiff(text) {
  const out = {};
  let cur = null;
  let oldPath = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = null;
      oldPath = null;
    } else if (line.startsWith('--- ')) {
      oldPath = line === '--- /dev/null' ? null : line.slice(6).replace(/\t$/, '');
    } else if (line.startsWith('+++ ')) {
      const newPath = line === '+++ /dev/null' ? null : line.slice(6).replace(/\t$/, '');
      const path = oldPath ?? newPath;
      cur = { absent: oldPath === null, hunks: [] };
      if (path) out[path] = cur;
    } else if (cur && line.startsWith('@@ ')) {
      const m = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
      if (m) cur.hunks.push({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) });
    }
  }
  return out;
}

/**
 * Current-build spans per file: `{ from, to, scenario }`. An entry kept from an older nightly (its
 * scenario failed since) is in that build's line numbers, so it credits no line here.
 */
function spansByFile(map, known) {
  const byFile = new Map();
  const older = [];
  for (const [scenario, entry] of Object.entries(map.scenarios)) {
    if (!known.has(scenario)) continue;
    if (entry.builtFrom !== map.builtFrom) {
      older.push(scenario);
      continue;
    }
    for (const [file, spans] of Object.entries(entry.files)) {
      const list = byFile.get(file) ?? [];
      for (const [from, to] of spans) list.push({ from, to, scenario });
      byFile.set(file, list);
    }
  }
  return { byFile, older };
}

/**
 * Scenarios whose credited spans hold every changed base line, or the first line none holds. An
 * insertion after line `a` is inside a function only if one span holds both `a` and `a + 1`.
 */
function scenariosForHunks(hunks, spans) {
  const names = new Set();
  const take = (hits) => {
    for (const s of hits) names.add(s.scenario);
    return hits.length > 0;
  };
  for (const { start, count } of hunks) {
    if (count === 0) {
      if (!take(spans.filter((s) => s.from <= start && start + 1 <= s.to))) {
        return { outside: `${start}+` };
      }
      continue;
    }
    for (let line = start; line < start + count; line++) {
      if (!take(spans.filter((s) => s.from <= line && line <= s.to))) return { outside: line };
    }
  }
  return { names };
}

/**
 * Spec §B2. `changed[].hunks` are the base-side hunks of the file's diff against the map's build
 * (`map.builtFrom`), not against the merge-base: the spans are in the map build's line numbers.
 * Missing hunks for a modified mapped file mean that diff could not be made.
 *
 * A scenario the coverage map has never seen (added or split since the last nightly) always runs:
 * the map can't say what it covers, and leaving it out is the unsafe direction.
 *
 * @param {{ path: string, status: 'A'|'M'|'D', hunks?: { start: number, count: number }[] }[]} changed
 * @param {{ map: { schema?: number, builtFrom: string, scenarios: Record<string, {
 *   builtFrom: string, files: Record<string, [number, number][]> }> } | null,
 *   all: string[], core: string[], excluded?: string[] }} ctx
 * @returns {{ kind: 'none'|'full'|'names', names: string[], reasons: string[] }}
 */
export function selectAffected(changed, ctx) {
  const full = (reasons) => ({ kind: 'full', names: [...ctx.all].sort(), reasons });
  const triggers = changed.filter((c) => isFullTrigger(c.path));
  if (triggers.length) return full(triggers.map((c) => `${c.path}: always runs the full suite`));
  const relevant = changed.filter((c) => !isE2eIrrelevant(c.path));
  if (!relevant.length) {
    return { kind: 'none', names: [], reasons: ['only e2e-irrelevant files changed'] };
  }
  if (ctx.map?.schema !== MAP_SCHEMA) {
    return full(['no coverage map with function ranges yet']);
  }

  const { byFile, older } = spansByFile(ctx.map, new Set(ctx.all));
  const names = new Set();
  const reasons = [];
  for (const { path, status, hunks } of relevant) {
    const spans = byFile.get(path);
    if (status === 'A') return full([`${path}: new, so no scenario has run its code yet`]);
    if (status === 'D') {
      if (!CODE.test(path)) return full([`${path}: deleted, and it is not code a scenario ran`]);
      const ran = [...new Set((spans ?? []).map((s) => s.scenario))];
      for (const n of ran) names.add(n);
      reasons.push(`${path}: deleted; ${ran.length} scenario(s) ran its functions`);
      continue;
    }
    if (!spans) return full([`${path}: changed, and no scenario ran any function in it`]);
    if (!hunks) return full([`${path}: no line diff against the map's build`]);
    const hit = scenariosForHunks(hunks, spans);
    if ('outside' in hit) {
      return full([
        `${path}:${hit.outside}: changed outside every function a scenario ran ` +
          '(top-level code, a function no scenario reached, or new code between functions)',
      ]);
    }
    for (const n of hit.names) names.add(n);
    reasons.push(`${path}: changed lines lie in functions ${hit.names.size} scenario(s) ran`);
  }
  const excluded = new Set(ctx.excluded ?? []);
  const unseen = ctx.all.filter((n) => !Object.hasOwn(ctx.map.scenarios, n) && !excluded.has(n));
  for (const n of unseen) names.add(n);
  if (unseen.length) reasons.push(`not in the coverage map yet: ${unseen.join(', ')}`);
  for (const n of older) names.add(n);
  if (older.length)
    reasons.push(`coverage from an older nightly (always run): ${older.join(', ')}`);
  for (const n of ctx.core) names.add(n);
  reasons.push(`core smoke set: ${ctx.core.join(', ')}`);
  return { kind: 'names', names: [...names].sort(), reasons };
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

function hasCommit(sha) {
  try {
    git('cat-file', '-e', `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/** Base-side hunks against the map's build, for the modified code files. */
function withMapBuildHunks(changed, map) {
  const paths = changed.filter((c) => c.status === 'M' && CODE.test(c.path)).map((c) => c.path);
  if (!paths.length || !hasCommit(map.builtFrom)) return changed;
  const diff = parseZeroContextDiff(
    git(
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-ext-diff',
      '--no-renames',
      '-U0',
      map.builtFrom,
      'HEAD',
      '--',
      ...paths,
    ),
  );
  return changed.map((c) => {
    if (!paths.includes(c.path)) return c;
    const d = diff[c.path];
    if (d?.absent) return { ...c, status: 'A' };
    return { ...c, hunks: d ? d.hunks : [] };
  });
}

function main([base, mapFile, outFile]) {
  const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
  const all = readdirSync('test/e2e')
    .filter((f) => f.endsWith('.e2e.mjs'))
    .map((f) => f.replace('.e2e.mjs', ''));
  const map = existsSync(mapFile) ? read(mapFile) : null;
  let r;
  if (!base) r = { kind: 'full', names: [...all].sort(), reasons: ['no diff base given'] };
  else {
    const changed = parseNameStatus(git('diff', '--name-status', `${base}...HEAD`));
    r = selectAffected(map?.schema === MAP_SCHEMA ? withMapBuildHunks(changed, map) : changed, {
      map,
      all,
      core: read('test/e2e/core-smoke.json'),
      excluded: Object.keys(read('test/e2e/remote-exclusions.json')),
    });
    if (map) console.log(`coverage map built from ${map.builtFrom}`);
  }
  console.log(`affected: ${r.kind}, ${r.names.length} scenario(s)`);
  for (const why of r.reasons) console.log(`  ${why}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const list = r.reasons.map((x) => `- ${x}`).join('\n');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Affected: ${r.kind}, ${r.names.length} scenario(s)\n\n${list}\n\n`,
    );
  }
  writeFileSync(outFile, JSON.stringify(r));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
