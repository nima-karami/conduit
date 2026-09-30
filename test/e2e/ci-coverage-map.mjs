/**
 * Coverage → `coverage-map.json` for e2e `--affected` (spec docs/specs/2026-09-29-remote-e2e-lean-loop.md
 * §B2). The harness (coverage-capture.mjs) records, per bundle, the generated range of every
 * function a scenario executed; this maps each range back through the bundle's sourcemap to the
 * source LINES of the function that defines it, so `--affected` can tell a change inside a function
 * a scenario ran from one anywhere else in the file.
 *
 * Map (`schema` 2): `{ schema, builtFrom, scenarios: { <name>: { builtFrom, files: { <path>:
 * [[from, to], …] } } } }`, 1-based inclusive lines of `builtFrom`'s copy of the file.
 *
 * What is never credited, so a change there runs the full suite:
 * - top-level code: esbuild hoists every module's top level into one bundle-wide scope that runs
 *   at load (and wraps lazily loaded modules in an `__esm` init function, excluded by name);
 * - a function whose generated range holds more than one source — a bundle or module wrapper;
 * - a function's first or last line when other code of the same file shares it (a one-line arrow
 *   in a data table, `export const f = () => {`): the change could be to that other code.
 *
 * CLI (a shard, after its scenarios): `node test/e2e/ci-coverage-map.mjs <coverage dir> <out.json>`.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAP_SCHEMA } from './ci-affected.mjs';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) DIGIT[B64.charCodeAt(i)] = i;
const LINE_KEY = 2 ** 22;

/**
 * Sourcemap v3 `mappings` → the segments that name a source, as generated offsets into `generated`
 * (UTF-16 units, like V8's coverage offsets) with their source index and 0-based original line and
 * column. Sorted by offset. `lineCols`: per (source, line), the smallest and largest column mapped.
 */
export function segmentOffsets(mappings, generated) {
  const lineStart = [0];
  for (let i = generated.indexOf('\n'); i !== -1; i = generated.indexOf('\n', i + 1)) {
    lineStart.push(i + 1);
  }
  const offsets = [];
  const sources = [];
  const lines = [];
  const columns = [];
  const lineCols = new Map();
  let line = 0;
  let col = 0;
  let src = 0;
  let oLine = 0;
  let oCol = 0;
  const fields = [];
  let value = 0;
  let shift = 0;
  const flush = () => {
    if (fields.length >= 1) {
      col += fields[0];
      if (fields.length >= 4) {
        src += fields[1];
        oLine += fields[2];
        oCol += fields[3];
        offsets.push(lineStart[line] + col);
        sources.push(src);
        lines.push(oLine);
        columns.push(oCol);
        const key = src * LINE_KEY + oLine;
        const seen = lineCols.get(key);
        if (!seen) lineCols.set(key, { min: oCol, max: oCol });
        else {
          if (oCol < seen.min) seen.min = oCol;
          if (oCol > seen.max) seen.max = oCol;
        }
      }
    }
    fields.length = 0;
  };
  for (let i = 0; i < mappings.length; i++) {
    const c = mappings.charCodeAt(i);
    if (c === 59 /* ; */) {
      flush();
      line++;
      col = 0;
    } else if (c === 44 /* , */) flush();
    else {
      const d = DIGIT[c];
      value += (d & 31) << shift;
      if (d & 32) shift += 5;
      else {
        fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0;
        shift = 0;
      }
    }
  }
  flush();
  return { generated, offsets, sources, lines, columns, lineCols };
}

/**
 * A sourcemap `sources` entry (relative to out/) → repo path, or null for a dependency — including
 * one whose own sourcemap esbuild chained in (pdf.js's `webpack://…`).
 */
export function projectSource(source) {
  if (source.includes(':')) return null;
  const p = posix.normalize(`out/${source.replace(/\\/g, '/')}`);
  return p.startsWith('../') || p.split('/').includes('node_modules') ? null : p;
}

/** The credited source lines of the function at generated `[start, end)`, or null (see header). */
function functionSpan(start, end, index) {
  const { generated, offsets, sources, lines, columns, lineCols } = index;
  let i = 0;
  let hi = offsets.length;
  while (i < hi) {
    const mid = (i + hi) >> 1;
    if (offsets[mid] < start) i = mid + 1;
    else hi = mid;
  }
  // esbuild maps a statement from its indentation, V8 starts a function at its keyword.
  if (i > 0 && generated.slice(offsets[i - 1], start).trim() === '') i--;
  if (i >= offsets.length || offsets[i] >= end) return null;
  const src = sources[i];
  let first = i;
  let last = i;
  for (let j = i; j < offsets.length && offsets[j] < end; j++) {
    if (sources[j] !== src) return null;
    if (lines[j] < lines[first] || (lines[j] === lines[first] && columns[j] < columns[first])) {
      first = j;
    }
    if (lines[j] > lines[last] || (lines[j] === lines[last] && columns[j] > columns[last])) {
      last = j;
    }
  }
  const ownsFirst = lineCols.get(src * LINE_KEY + lines[first]).min >= columns[first];
  const ownsLast = lineCols.get(src * LINE_KEY + lines[last]).max <= columns[last];
  const from = lines[first] + (ownsFirst ? 1 : 2);
  const to = lines[last] + (ownsLast ? 1 : 0);
  return from <= to ? { src, from, to } : null;
}

/** Overlapping spans merge; spans that only touch stay apart, so an insertion between them is outside both. */
export function mergeSpans(spans) {
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [from, to] of sorted) {
    const prev = out[out.length - 1];
    if (prev && from <= prev[1]) prev[1] = Math.max(prev[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** Generated `[start, end]` ranges of executed functions → `{ repo path: merged spans }`. */
export function spansForRanges(ranges, index, mapSources, cache = new Map()) {
  const byFile = {};
  for (const [start, end] of ranges) {
    const key = `${start}:${end}`;
    let hit = cache.get(key);
    if (hit === undefined) {
      const span = functionSpan(start, end, index);
      const file = span && projectSource(mapSources[span.src]);
      hit = file ? { file, span: [span.from, span.to] } : null;
      cache.set(key, hit);
    }
    if (!hit) continue;
    const list = byFile[hit.file] ?? [];
    list.push(hit.span);
    byFile[hit.file] = list;
  }
  for (const f of Object.keys(byFile)) byFile[f] = mergeSpans(byFile[f]);
  return byFile;
}

const MERGEABLE = new Set(['PASS', 'FLAKY']);

/**
 * This nightly's scenarios replace their entries, but only those that ended PASS or FLAKY: a
 * failed run stops early and would under-credit. Every other entry, and every entry of an old-schema
 * map, is kept or dropped as it stands (a kept one keeps its own `builtFrom`).
 *
 * @param {Record<string, string>} statuses scenario → final status in this nightly
 */
export function mergeCoverageMaps(prev, shardMaps, sha, statuses) {
  const scenarios = prev?.schema === MAP_SCHEMA ? { ...prev.scenarios } : {};
  for (const m of shardMaps) {
    for (const [name, files] of Object.entries(m)) {
      if (MERGEABLE.has(statuses[name])) scenarios[name] = { builtFrom: sha, files };
    }
  }
  return { schema: MAP_SCHEMA, builtFrom: sha, scenarios };
}

function loadBundle(outDir, bundle) {
  const js = join(outDir, bundle);
  if (!existsSync(`${js}.map`)) return null;
  const map = JSON.parse(readFileSync(`${js}.map`, 'utf8'));
  return {
    index: segmentOffsets(map.mappings, readFileSync(js, 'utf8')),
    sources: map.sources,
    cache: new Map(),
  };
}

/** `<coverage dir>/<scenario>/*.json` (`{ [bundle]: [start, end][] }`) → `{ scenario: { file: spans } }`. */
function mapShard(covDir, outDir) {
  const bundles = {};
  const result = {};
  for (const scenario of readdirSync(covDir)) {
    const files = {};
    for (const f of readdirSync(join(covDir, scenario)).filter((n) => n.endsWith('.json'))) {
      const ranges = JSON.parse(readFileSync(join(covDir, scenario, f), 'utf8'));
      for (const [bundle, list] of Object.entries(ranges)) {
        if (!(bundle in bundles)) bundles[bundle] = loadBundle(outDir, bundle);
        const b = bundles[bundle];
        if (!b) continue;
        const found = spansForRanges(list, b.index, b.sources, b.cache);
        for (const [file, spans] of Object.entries(found)) {
          const list = files[file] ?? [];
          list.push(...spans);
          files[file] = list;
        }
      }
    }
    for (const file of Object.keys(files)) files[file] = mergeSpans(files[file]);
    if (Object.keys(files).length) result[scenario] = files;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [covDir, outFile] = process.argv.slice(2);
  const result = existsSync(covDir) ? mapShard(covDir, 'out') : {};
  writeFileSync(outFile, `${JSON.stringify(result)}\n`);
  const counts = Object.entries(result).map(([s, f]) => `${s} ${Object.keys(f).length}`);
  console.log(
    `coverage: ${counts.length} scenario(s)${counts.length ? `: ${counts.join(', ')}` : ''}`,
  );
}
