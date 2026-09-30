/**
 * Nightly coverage for e2e `--affected`: which functions of the app's bundles a scenario ran. Only
 * when the runner sets `E2E_COVERAGE_DIR` (the nightly); hooked from the harness's
 * `launchElectron`, `closeApp`, `shutdownApp` and `finishScenario`. ci-coverage-map.mjs turns the
 * result into credited source lines. Spec: docs/specs/archive/2026-09-29-remote-e2e-lean-loop.md §B2.
 *
 * Writes `<E2E_COVERAGE_DIR>/<scenario>/<n>.json` = `{ "webview.js" | "main.js": [[start, end]
 * generated offsets of each executed function] }`.
 *
 * Function-granularity V8 coverage (`detailed: false`) over CDP, in the renderer and — through an
 * in-process inspector session — the host. Block coverage (Playwright's `page.coverage`,
 * `NODE_V8_COVERAGE`) slowed the app enough to fail two timing-sensitive scenarios in the first
 * nightly (change-map-geometry, nav-keybindings-settings) that pass without it. Coverage starts
 * once the app is up, so startup-only functions are never credited, and `--affected` runs the full
 * suite for a change to one.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BUNDLES = ['webview.js', 'main.js'];
const START = { callCount: true, detailed: false };

export function coverageDir(env = process.env) {
  const { E2E_COVERAGE_DIR: root, E2E_SCENARIO: scenario } = env;
  return root && scenario ? join(root, scenario) : null;
}

// esbuild's `__esm({ "webview/x.ts"() {…} })` wrapper: a lazily loaded module's top level.
const MODULE_INIT = /\.[cm]?[jt]sx?$/;

/** Generated ranges of the functions that ran, per bundle, from V8 script coverage entries. */
export function executedRanges(entries) {
  const out = {};
  for (const e of entries) {
    const bundle = BUNDLES.find((b) => e.url.replace(/\\/g, '/').endsWith(`/out/${b}`));
    if (!bundle) continue;
    out[bundle] ??= [];
    for (const f of e.functions) {
      const r = f.ranges[0];
      if (!r || r.count === 0 || r.startOffset === 0 || MODULE_INIT.test(f.functionName)) continue;
      out[bundle].push([r.startOffset, r.endOffset]);
    }
  }
  return out;
}

const tracked = new WeakMap();
let fileSeq = 0;

/**
 * This attempt's completeness sentinel, rewritten on every change to `meta-<pid>.json`: an attempt
 * killed before it stopped its apps leaves `stopped < launches` behind. ci-coverage-map.mjs
 * `scenarioCompleteness` reads it.
 */
const meta = { launches: 0, windows: 0, stopped: 0, incomplete: [] };

function writeMeta() {
  const dir = coverageDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `meta-${process.pid}.json`), JSON.stringify(meta));
}

function lost(why) {
  if (!meta.incomplete.includes(why)) meta.incomplete.push(why);
}

/** This attempt's coverage is missing something (`why`); the nightly won't merge it. */
export function markCoverageIncomplete(why) {
  if (!coverageDir()) return;
  lost(why);
  writeMeta();
}

function write(ranges) {
  const dir = coverageDir();
  if (!Object.keys(ranges).length) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}-${fileSeq++}.json`), JSON.stringify(ranges));
}

/** Begin coverage in the host and every window of `app`; `app.close` is wrapped to collect first. */
export function startCoverage(app, log = console.log) {
  if (!coverageDir()) return;
  const warn = (e) => log(`[coverage] not started: ${e?.message || e}`);
  const entry = { windows: [], stopped: false };
  tracked.set(app, entry);
  meta.launches++;
  writeMeta();
  entry.host = app
    .evaluate(async (_electron, start) => {
      const inspector = process.mainModule.require('node:inspector');
      const session = new inspector.Session();
      session.connect();
      const post = (method, params) =>
        new Promise((resolve, reject) =>
          session.post(method, params, (err, res) => (err ? reject(err) : resolve(res))),
        );
      await post('Profiler.enable');
      await post('Profiler.startPreciseCoverage', start);
      globalThis.__e2eCoverage = post;
      return true;
    }, START)
    .catch(warn);
  const begin = (page) => {
    if (entry.windows.length + 1 > meta.windows) {
      meta.windows = entry.windows.length + 1;
      writeMeta();
    }
    entry.windows.push(
      (async () => {
        const cdp = await app.context().newCDPSession(page);
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.startPreciseCoverage', START);
        return cdp;
      })().catch(warn),
    );
  };
  app.on('window', begin);
  for (const page of app.windows()) begin(page);
  const close = app.close.bind(app);
  app.close = async () => {
    await stopCoverage(app);
    return close();
  };
}

/** Collect the host's and every window's coverage; each app once. */
export async function stopCoverage(app) {
  const entry = tracked.get(app);
  if (!entry || entry.stopped) return;
  entry.stopped = true;
  for (const started of entry.windows) {
    const cdp = await started;
    if (!cdp) {
      lost('window coverage never started');
      continue;
    }
    try {
      write(executedRanges((await cdp.send('Profiler.takePreciseCoverage')).result));
    } catch {
      lost('a window closed before its coverage was taken');
    }
  }
  if (!(await entry.host)) lost('host coverage never started');
  else {
    try {
      const result = await app.evaluate(async () => {
        const { result: scripts } = await globalThis.__e2eCoverage('Profiler.takePreciseCoverage');
        return scripts.filter((s) => /[\\/]out[\\/]main\.js$/.test(s.url));
      });
      write(executedRanges(result));
    } catch {
      lost('the app was gone before its host coverage was taken');
    }
  }
  meta.stopped++;
  writeMeta();
}
