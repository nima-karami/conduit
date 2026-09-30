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
/** 3: entries carry `alwaysRun`; a schema-2 map can't say which scenarios need it. */
export const MAP_SCHEMA = 3;

function isFullTrigger(path) {
  return FULL.some((re) => re.test(path));
}

export function isE2eIrrelevant(path) {
  if (NEVER_IRRELEVANT.some((re) => re.test(path))) return false;
  if (path.startsWith('.github/')) return path !== '.github/workflows/e2e.yml';
  return IRRELEVANT.some((re) => re.test(path));
}

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/**
 * A path as git prints it: C-quoted (`"src/a\tb.ts"`, octal UTF-8 bytes) when it holds a character
 * `core.quotePath=false` still escapes, else verbatim.
 */
function unquotePath(s) {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const bytes = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      bytes.push(...Buffer.from(body[i], 'utf8'));
      continue;
    }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) {
      bytes.push(Number.parseInt(oct[0], 8));
      i += 3;
    } else {
      bytes.push(C_ESCAPES[body[i + 1]] ?? body.charCodeAt(i + 1));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** `git diff --name-status` output → changes; a rename is a delete plus an add, a copy an add. */
export function parseNameStatus(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const [code, qa, qb] = line.split('\t');
    if (!code || !qa) continue;
    const a = unquotePath(qa);
    const b = qb === undefined ? qb : unquotePath(qb);
    if (code[0] === 'R' || code[0] === 'C') {
      if (code[0] === 'R') out.push({ path: a, status: 'D' });
      out.push({ path: b, status: 'A' });
    } else out.push({ path: a, status: code[0] === 'A' || code[0] === 'D' ? code[0] : 'M' });
  }
  return out;
}

/** A `--- a/x` / `+++ b/x` header's path (prefixes forced by `withMapBuildHunks`), or null. */
function headerPath(line) {
  const rest = unquotePath(line.slice(4).replace(/\t$/, ''));
  return rest === '/dev/null' ? null : rest.slice(2);
}

/**
 * `git diff -U0 --no-renames <map build> HEAD` → per file, the BASE-side hunks: `{ start, count }`
 * are 1-based lines of the map build's copy; `count` 0 is a pure insertion after line `start`.
 * `absent`: the file did not exist in the map build.
 *
 * A hunk's body is skipped by the counts in its `@@ -a,b +c,d @@` header: a removed line `-- x`
 * prints as `--- x`, an added `++ x` as `+++ x`, and read as headers they re-keyed the file.
 */
export function parseZeroContextDiff(text) {
  const out = {};
  let cur = null;
  let oldPath = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of text.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line[0] === '-') oldLeft--;
      else if (line[0] === '+') newLeft--;
      else if (line[0] === ' ') {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith('diff --git ')) {
      cur = null;
      oldPath = null;
    } else if (line.startsWith('--- ')) {
      oldPath = headerPath(line);
    } else if (line.startsWith('+++ ')) {
      const path = oldPath ?? headerPath(line);
      cur = { absent: oldPath === null, hunks: [] };
      if (path) out[path] = cur;
    } else if (cur && line.startsWith('@@ ')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (m) {
        const count = m[2] === undefined ? 1 : Number(m[2]);
        cur.hunks.push({ start: Number(m[1]), count });
        oldLeft = count;
        newLeft = m[3] === undefined ? 1 : Number(m[3]);
      }
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
  const always = [];
  for (const [scenario, entry] of Object.entries(map.scenarios)) {
    if (!known.has(scenario)) continue;
    if (entry.alwaysRun) always.push(scenario);
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
  return { byFile, older, always };
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

  const { byFile, older, always } = spansByFile(ctx.map, new Set(ctx.all));
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
    reasons.push(
      hunks.length
        ? `${path}: changed lines lie in functions ${hit.names.size} scenario(s) ran`
        : `${path}: identical to the map's build`,
    );
  }
  const excluded = new Set(ctx.excluded ?? []);
  const unseen = ctx.all.filter((n) => !Object.hasOwn(ctx.map.scenarios, n) && !excluded.has(n));
  for (const n of unseen) names.add(n);
  if (unseen.length) reasons.push(`not in the coverage map yet: ${unseen.join(', ')}`);
  for (const n of older) names.add(n);
  if (older.length)
    reasons.push(`coverage from an older nightly (always run): ${older.join(', ')}`);
  for (const n of always) names.add(n);
  if (always.length) {
    reasons.push(
      `relaunches the app or opens a second window (always run): ${always.sort().join(', ')}`,
    );
  }
  for (const n of ctx.core) names.add(n);
  reasons.push(`core smoke set: ${ctx.core.join(', ')}`);
  return { kind: 'names', names: [...names].sort(), reasons };
}

/** Every diff this file parses: the output format pinned against the user's and repo's git config. */
const DIFF = [
  '-c',
  'core.quotePath=false',
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--no-renames',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

const gitIn = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });

function hasCommit(sha, cwd) {
  try {
    gitIn(cwd, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Base-side hunks against the map's build, for the modified code files. A file git lists as changed
 * that the hunk parse has no entry for gets no `hunks` (→ full): an unparsed diff must never read
 * as "identical to the map's build".
 */
export function withMapBuildHunks(changed, map, cwd = process.cwd()) {
  const paths = changed.filter((c) => c.status === 'M' && CODE.test(c.path)).map((c) => c.path);
  if (!paths.length || !hasCommit(map.builtFrom, cwd)) return changed;
  const range = [map.builtFrom, 'HEAD', '--', ...paths];
  const diff = parseZeroContextDiff(gitIn(cwd, [...DIFF, '-U0', ...range]));
  const listed = new Set(
    gitIn(cwd, [...DIFF, '--name-only', ...range])
      .split('\n')
      .filter(Boolean)
      .map(unquotePath),
  );
  return changed.map((c) => {
    if (!paths.includes(c.path)) return c;
    const d = diff[c.path];
    if (d?.absent) return { ...c, status: 'A' };
    if (d) return { ...c, hunks: d.hunks };
    return listed.has(c.path) ? c : { ...c, hunks: [] };
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
    const changed = parseNameStatus(
      gitIn(process.cwd(), [...DIFF, '--name-status', `${base}...HEAD`]),
    );
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
