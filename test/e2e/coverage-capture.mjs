/**
 * Nightly coverage for e2e `--affected`: which functions of the app's bundles a scenario ran. Only
 * when the runner sets `E2E_COVERAGE_DIR` (the nightly); hooked from the harness's
 * `launchElectron`, `closeApp`, `shutdownApp` and `finishScenario`. ci-coverage-map.mjs turns the
 * result into source files. Spec: docs/specs/2026-09-29-remote-e2e-lean-loop.md §B2.
 *
 * Writes `<E2E_COVERAGE_DIR>/<scenario>/<n>.json` = `{ "webview.js" | "main.js": [start offsets
 * of executed functions] }`.
 *
 * Function-granularity V8 coverage (`detailed: false`) over CDP, in the renderer and — through an
 * in-process inspector session — the host. Block coverage (Playwright's `page.coverage`,
 * `NODE_V8_COVERAGE`) slowed the app enough to fail two timing-sensitive scenarios in the first
 * nightly (change-map-geometry, nav-keybindings-settings) that pass without it. Coverage starts
 * once the app is up, so the first paint is missed; a file only that path touches stays
 * unmapped, which `--affected` treats as "run everything".
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BUNDLES = ['webview.js', 'main.js'];
const START = { callCount: true, detailed: false };

export function coverageDir(env = process.env) {
  const { E2E_COVERAGE_DIR: root, E2E_SCENARIO: scenario } = env;
  return root && scenario ? join(root, scenario) : null;
}

/** Start offsets of the functions that ran, per bundle, from V8 script coverage entries. */
export function executedStarts(entries) {
  const out = {};
  for (const e of entries) {
    const bundle = BUNDLES.find((b) => e.url.replace(/\\/g, '/').endsWith(`/out/${b}`));
    if (!bundle) continue;
    out[bundle] ??= [];
    for (const f of e.functions) {
      const r = f.ranges[0];
      if (r && r.count > 0 && r.startOffset > 0) out[bundle].push(r.startOffset);
    }
  }
  return out;
}

const tracked = new WeakMap();
let fileSeq = 0;

function write(starts) {
  const dir = coverageDir();
  if (!Object.keys(starts).length) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}-${fileSeq++}.json`), JSON.stringify(starts));
}

/** Begin coverage in the host and every window of `app`; `app.close` is wrapped to collect first. */
export function startCoverage(app, log = console.log) {
  if (!coverageDir()) return;
  const warn = (e) => log(`[coverage] not started: ${e?.message || e}`);
  const entry = { windows: [], stopped: false };
  tracked.set(app, entry);
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
    if (!cdp) continue;
    try {
      write(executedStarts((await cdp.send('Profiler.takePreciseCoverage')).result));
    } catch {
      /* the window closed under us */
    }
  }
  if (!(await entry.host)) return;
  try {
    const result = await app.evaluate(async () => {
      const { result: scripts } = await globalThis.__e2eCoverage('Profiler.takePreciseCoverage');
      return scripts.filter((s) => /[\\/]out[\\/]main\.js$/.test(s.url));
    });
    write(executedStarts(result));
  } catch {
    /* the app is already gone */
  }
}
