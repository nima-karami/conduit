import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const NEEDLE = 'waitForTimeout(';
const BASELINE = join('test', 'e2e', 'sleep-baseline.json');
const E2E_DIR = join('test', 'e2e');

/** @param {string} source */
export function countSleeps(source) {
  let count = 0;
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < n) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === q) {
          i++;
          break;
        }
        i++;
      }
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

/** @param {string} root */
function posixRel(root, absPath) {
  return relative(root, absPath).split(sep).join('/');
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

/** @param {string} projectRoot */
function loadBaseline(projectRoot) {
  const path = join(projectRoot, BASELINE);
  return /** @type {Record<string, number>} */ (JSON.parse(readFileSync(path, 'utf8')));
}

/** @param {string} projectRoot @param {Record<string, number>} data */
function writeBaseline(projectRoot, data) {
  const path = join(projectRoot, BASELINE);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function main() {
  const projectRoot = process.cwd();
  const update = process.argv.includes('--update');
  const counts = currentSleepCounts(projectRoot);

  if (update) {
    writeBaseline(projectRoot, counts);
    process.exit(0);
  }

  const baseline = loadBaseline(projectRoot);
  const { ok, over, under } = compareToBaseline(counts, baseline);
  for (const { file, count, allowed } of over) {
    console.error(
      `${file}: ${count} fixed sleeps, baseline ${allowed} — wait on a real condition instead (CON-134)`,
    );
  }
  for (const { file, count, allowed } of under) {
    console.error(
      `${file}: ${count} fixed sleeps, baseline ${allowed} — lower the baseline: npm run check:e2e-sleeps -- --update`,
    );
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
