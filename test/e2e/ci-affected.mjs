/**
 * `--affected`: which e2e scenarios a diff needs (spec docs/specs/2026-09-29-remote-e2e-lean-loop.md
 * §B2, rules in order). Pure; `e2e:remote` applies only the irrelevant-set rule client-side, and the
 * `prepare` job of .github/workflows/e2e.yml applies all of them.
 */

const IRRELEVANT = [/^test\/unit\//, /^docs\//, /\.md$/i, /^designs\//, /^\.conduit\//];
const FULL = [
  /^test\/e2e\//,
  /^electron\/main\.ts$/,
  /^electron\/preload\.ts$/,
  /^esbuild\.mjs$/,
  /^package(-lock)?\.json$/,
  /^\.github\/workflows\/e2e\.yml$/,
];

export function isE2eIrrelevant(path) {
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

/** esbuild metafile → `{ file: [files importing it] }`, project files only. */
export function importersFromMetafile(meta) {
  const out = {};
  const own = (p) => !p.startsWith('node_modules/') && !p.includes('/node_modules/');
  for (const [file, input] of Object.entries(meta.inputs ?? {})) {
    if (!own(file)) continue;
    for (const { path } of input.imports ?? []) {
      if (!own(path)) continue;
      out[path] = [...new Set([...(out[path] ?? []), file])].sort();
    }
  }
  return out;
}

/** Only scenarios that still exist: the map is a nightly old and may name a split or deleted one. */
function scenariosByFile(map, all) {
  const known = new Set(all);
  const byFile = new Map();
  for (const [name, files] of Object.entries(map.scenarios ?? {})) {
    if (!known.has(name)) continue;
    for (const f of files) byFile.set(f, [...(byFile.get(f) ?? []), name]);
  }
  return byFile;
}

/** Nearest mapped files above `file` in the import graph (BFS; stops at the first mapped layer). */
function nearestMapped(file, importers, byFile) {
  const found = new Set();
  const seen = new Set([file]);
  let layer = [file];
  while (layer.length) {
    const next = [];
    for (const f of layer) {
      for (const imp of importers[f] ?? []) {
        if (seen.has(imp)) continue;
        seen.add(imp);
        if (byFile.has(imp)) found.add(imp);
        else next.push(imp);
      }
    }
    layer = next;
  }
  return [...found];
}

/**
 * A scenario the coverage map has never seen (added or split since the last nightly) always runs:
 * the map can't say what it covers, and leaving it out is the unsafe direction.
 *
 * @param {{ path: string, status: 'A'|'M'|'D' }[]} changed
 * @param {{ map: { scenarios: Record<string, string[]> }, importers: Record<string, string[]>,
 *   all: string[], core: string[], excluded?: string[] }} ctx
 * @returns {{ kind: 'none'|'full'|'names', names: string[], reasons: string[] }}
 */
export function selectAffected(changed, ctx) {
  const full = (reasons) => ({ kind: 'full', names: [...ctx.all].sort(), reasons });
  const relevant = changed.filter((c) => !isE2eIrrelevant(c.path));
  if (!relevant.length) {
    return { kind: 'none', names: [], reasons: ['only e2e-irrelevant files changed'] };
  }
  const triggers = relevant.filter((c) => FULL.some((re) => re.test(c.path)));
  if (triggers.length) return full(triggers.map((c) => `${c.path}: always runs the full suite`));

  const byFile = scenariosByFile(ctx.map, ctx.all);
  const names = new Set();
  const reasons = [];
  for (const { path, status } of relevant) {
    const mapped = byFile.get(path);
    if (mapped) {
      for (const n of mapped) names.add(n);
      reasons.push(`${path}: covered by ${mapped.length} scenario(s)`);
    } else if (status === 'A') {
      const via = nearestMapped(path, ctx.importers, byFile);
      if (!via.length) return full([`${path}: new, and no mapped file imports it`]);
      for (const f of via) for (const n of byFile.get(f)) names.add(n);
      reasons.push(`${path}: new, imported via ${via.join(', ')}`);
    } else if (status === 'M') {
      return full([`${path}: changed, and no scenario in the coverage map covers it`]);
    } else reasons.push(`${path}: deleted, unmapped`);
  }
  const excluded = new Set(ctx.excluded ?? []);
  const unseen = ctx.all.filter(
    (n) => !Object.hasOwn(ctx.map.scenarios ?? {}, n) && !excluded.has(n),
  );
  for (const n of unseen) names.add(n);
  if (unseen.length) reasons.push(`not in the coverage map yet: ${unseen.join(', ')}`);
  for (const n of ctx.core) names.add(n);
  reasons.push(`core smoke set: ${ctx.core.join(', ')}`);
  return { kind: 'names', names: [...names].sort(), reasons };
}
