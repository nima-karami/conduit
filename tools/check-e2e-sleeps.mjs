import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const NEEDLE = 'waitForTimeout(';
const BASELINE = join('test', 'e2e', 'sleep-baseline.json');
const E2E_DIR = join('test', 'e2e');

/** @param {string} rel */
export function toPosixRel(rel) {
  return rel.split(/[/\\]/).join('/');
}

/**
 * @param {string} source
 * @param {number} start
 * @param {number} end
 */
function countSleepsIn(source, start, end) {
  let count = 0;
  let i = start;
  while (i < end) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      i += 2;
      while (i < end && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < end - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuotedString(source, i, end, c);
      continue;
    }
    if (c === '`') {
      const scanned = scanTemplateLiteral(source, i, end);
      count += scanned.count;
      i = scanned.i;
      continue;
    }
    if (source.startsWith(NEEDLE, i)) {
      count++;
      i += NEEDLE.length;
      continue;
    }
    i++;
  }
  return count;
}

/**
 * @param {string} source
 * @param {number} i
 * @param {number} end
 * @param {string} quote
 */
function skipQuotedString(source, i, end, quote) {
  i++;
  while (i < end) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) {
      return i + 1;
    }
    i++;
  }
  return i;
}

/**
 * @param {string} source
 * @param {number} i
 * @param {number} end
 */
function scanTemplateLiteral(source, i, end) {
  let count = 0;
  i++;
  while (i < end) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === '$' && source[i + 1] === '{') {
      i += 2;
      const inner = scanTemplateInterpolation(source, i, end);
      count += inner.count;
      i = inner.i;
      continue;
    }
    if (source[i] === '`') {
      return { count, i: i + 1 };
    }
    i++;
  }
  return { count, i };
}

/**
 * @param {string} source
 * @param {number} i index after "${"
 * @param {number} end
 */
function scanTemplateInterpolation(source, i, end) {
  let depth = 1;
  let j = i;
  while (j < end && depth > 0) {
    const c = source[j];
    const next = source[j + 1];
    if (c === '/' && next === '/') {
      j += 2;
      while (j < end && source[j] !== '\n') j++;
      continue;
    }
    if (c === '/' && next === '*') {
      j += 2;
      while (j < end - 1 && !(source[j] === '*' && source[j + 1] === '/')) j++;
      j += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      j = skipQuotedString(source, j, end, c);
      continue;
    }
    if (c === '`') {
      const scanned = scanTemplateLiteral(source, j, end);
      j = scanned.i;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    j++;
  }
  const closeIndex = j - 1;
  return { count: countSleepsIn(source, i, closeIndex), i: j };
}

/** @param {string} source */
export function countSleeps(source) {
  return countSleepsIn(source, 0, source.length);
}

/**
 * @param {Record<string, number>} counts
 * @param {Record<string, number>} baseline
 */
export function compareToBaseline(counts, baseline) {
  const over = [];
  const under = [];
  const files = new Set([...Object.keys(counts), ...Object.keys(baseline)]);
  for (const file of [...files].sort()) {
    const count = counts[file] ?? 0;
    const allowed = baseline[file] ?? 0;
    if (count > allowed) over.push({ file, count, allowed });
    if (count < allowed) under.push({ file, count, allowed });
  }
  return { ok: over.length === 0 && under.length === 0, over, under };
}

/** @param {string} root @param {string} absPath */
function posixRel(root, absPath) {
  return toPosixRel(relative(root, absPath));
}

/** @param {string} dir @param {string} projectRoot */
function scanE2eMjs(dir, projectRoot) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      Object.assign(counts, scanE2eMjs(abs, projectRoot));
    } else if (ent.isFile() && ent.name.endsWith('.mjs')) {
      const key = posixRel(projectRoot, abs);
      const source = readFileSync(abs, 'utf8');
      const n = countSleeps(source);
      if (n > 0) counts[key] = n;
    }
  }
  return counts;
}

/** @returns {Record<string, number>} */
export function currentSleepCounts(projectRoot = process.cwd()) {
  const e2e = join(projectRoot, E2E_DIR);
  const counts = scanE2eMjs(e2e, projectRoot);
  const sorted = /** @type {Record<string, number>} */ ({});
  for (const k of Object.keys(counts).sort()) sorted[k] = counts[k];
  return sorted;
}

/** @param {Record<string, number>} raw */
function normalizeCountKeys(raw) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    out[toPosixRel(k)] = v;
  }
  return out;
}

/** @param {string} baselinePath @param {Record<string, number>} data */
function writeBaselineFile(baselinePath, data) {
  writeFileSync(baselinePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * @param {{
 *   root: string;
 *   baselinePath: string;
 *   update?: boolean;
 *   log?: (message: string) => void;
 * }} opts
 */
export function run({ root, baselinePath, update = false, log = (msg) => console.error(msg) }) {
  const counts = currentSleepCounts(root);

  if (update) {
    writeBaselineFile(baselinePath, counts);
    return { exitCode: 0 };
  }

  const baseline = normalizeCountKeys(
    /** @type {Record<string, number>} */ (JSON.parse(readFileSync(baselinePath, 'utf8'))),
  );
  const { ok, over, under } = compareToBaseline(counts, baseline);
  for (const { file, count, allowed } of over) {
    log(
      `${file}: ${count} fixed sleeps, baseline ${allowed} — wait on a real condition instead (CON-134)`,
    );
  }
  for (const { file, count, allowed } of under) {
    log(
      `${file}: ${count} fixed sleeps, baseline ${allowed} — lower the baseline: npm run check:e2e-sleeps -- --update`,
    );
  }
  return { exitCode: ok ? 0 : 1 };
}

function main() {
  const projectRoot = process.cwd();
  const update = process.argv.includes('--update');
  const { exitCode } = run({
    root: projectRoot,
    baselinePath: join(projectRoot, BASELINE),
    update,
  });
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
