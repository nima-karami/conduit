/**
 * Coverage → `coverage-map.json` (scenario → source files) for e2e `--affected`
 * (spec docs/specs/2026-09-29-remote-e2e-lean-loop.md §B2). The harness (coverage-capture.mjs)
 * records, per bundle, the start offsets of the functions a scenario executed; this maps each
 * offset back through the bundle's sourcemap to the file that defines the function.
 *
 * By function definition, not by every executed byte: esbuild hoists every module's top level
 * into one bundle-wide scope that runs at load, so byte-level coverage would put every file in
 * every scenario. A file with no function of its own (constants, types) is therefore never
 * mapped, and `--affected` runs the full suite for it — the safe direction.
 *
 * CLI (a shard, after its scenarios): `node test/e2e/ci-coverage-map.mjs <coverage dir> <out.json>`.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) DIGIT[B64.charCodeAt(i)] = i;

/**
 * Sourcemap v3 `mappings` → the segments that name a source, as generated offsets into `generated`
 * (UTF-16 units, like V8's coverage offsets) with their source index. Sorted by offset.
 */
export function segmentOffsets(mappings, generated) {
  const lineStart = [0];
  for (let i = generated.indexOf('\n'); i !== -1; i = generated.indexOf('\n', i + 1)) {
    lineStart.push(i + 1);
  }
  const offsets = [];
  const sources = [];
  let line = 0;
  let col = 0;
  let src = 0;
  const fields = [];
  let value = 0;
  let shift = 0;
  const flush = () => {
    if (fields.length >= 1) {
      col += fields[0];
      if (fields.length >= 4) {
        src += fields[1];
        offsets.push(lineStart[line] + col);
        sources.push(src);
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
  return { offsets, sources };
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

/** Repo files defining the functions that start at `starts` (generated offsets). */
export function sourcesForOffsets(starts, { offsets, sources }, mapSources) {
  const out = new Set();
  for (const at of starts) {
    let lo = 0;
    let hi = offsets.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] <= at) {
        hit = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (hit < 0) continue;
    const file = projectSource(mapSources[sources[hit]]);
    if (file) out.add(file);
  }
  return out;
}

/** This nightly's scenarios replace their entries; scenarios it didn't cover keep theirs. */
export function mergeCoverageMaps(prev, shardMaps, sha) {
  const scenarios = { ...(prev?.scenarios ?? {}) };
  for (const m of shardMaps) Object.assign(scenarios, m);
  return { builtFrom: sha, scenarios };
}

function loadBundle(outDir, bundle) {
  const js = join(outDir, bundle);
  if (!existsSync(`${js}.map`)) return null;
  const map = JSON.parse(readFileSync(`${js}.map`, 'utf8'));
  return { index: segmentOffsets(map.mappings, readFileSync(js, 'utf8')), sources: map.sources };
}

/** `<coverage dir>/<scenario>/*.json` (`{ [bundle]: number[] }`) → `{ scenario: files[] }`. */
function mapShard(covDir, outDir) {
  const bundles = {};
  const result = {};
  for (const scenario of readdirSync(covDir)) {
    const files = new Set();
    for (const f of readdirSync(join(covDir, scenario)).filter((n) => n.endsWith('.json'))) {
      const starts = JSON.parse(readFileSync(join(covDir, scenario, f), 'utf8'));
      for (const [bundle, offsets] of Object.entries(starts)) {
        if (!(bundle in bundles)) bundles[bundle] = loadBundle(outDir, bundle);
        const b = bundles[bundle];
        if (b) for (const s of sourcesForOffsets(offsets, b.index, b.sources)) files.add(s);
      }
    }
    if (files.size) result[scenario] = [...files].sort();
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [covDir, outFile] = process.argv.slice(2);
  const result = existsSync(covDir) ? mapShard(covDir, 'out') : {};
  writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
  const counts = Object.entries(result).map(([s, f]) => `${s} ${f.length}`);
  console.log(
    `coverage: ${counts.length} scenario(s)${counts.length ? `: ${counts.join(', ')}` : ''}`,
  );
}
