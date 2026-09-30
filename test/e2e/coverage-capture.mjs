/**
 * Nightly coverage for e2e `--affected`: which functions of the app's bundles a scenario ran. Only
 * when the runner sets `E2E_COVERAGE_DIR` (the nightly); hooked from the harness's
 * `launchElectron`, `shutdownApp` and `finishScenario`. ci-coverage-map.mjs turns the result into
 * source files. Spec: docs/specs/2026-09-29-remote-e2e-lean-loop.md §B2.
 *
 * Writes `<E2E_COVERAGE_DIR>/<scenario>/<n>.json` = `{ "webview.js" | "main.js": [start offsets
 * of executed functions] }`. Renderer: CDP precise coverage (`page.coverage`), started at each
 * window's creation, so what ran before that — the first paint — is missed; a file only that path
 * touches stays unmapped, which `--affected` treats as "run everything". Host: `NODE_V8_COVERAGE`,
 * flushed with `v8.takeCoverage()` before the app closes, because a killed app never writes it.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BUNDLES = ['webview.js', 'main.js'];

export function coverageDir(env = process.env) {
  const { E2E_COVERAGE_DIR: root, E2E_SCENARIO: scenario } = env;
  return root && scenario ? join(root, scenario) : null;
}

/** `_electron.launch` options with the host's `NODE_V8_COVERAGE` set, when coverage is on. */
export function withCoverageEnv(launchOpts) {
  const dir = coverageDir();
  if (!dir) return launchOpts;
  return {
    ...launchOpts,
    env: { ...(launchOpts.env ?? process.env), NODE_V8_COVERAGE: join(dir, 'host-raw') },
  };
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

/** Begin renderer coverage on every window of `app`; `app.close` is wrapped to collect first. */
export function startCoverage(app, log = console.log) {
  if (!coverageDir()) return;
  const entry = { pages: [], stopped: false };
  tracked.set(app, entry);
  const begin = (page) => {
    entry.pages.push(
      page.coverage
        .startJSCoverage({ resetOnNavigation: false })
        .then(() => page)
        .catch((e) => log(`[coverage] not started: ${e?.message || e}`)),
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

/** Collect renderer coverage and flush the host's; each app once. */
export async function stopCoverage(app) {
  const entry = tracked.get(app);
  if (!entry || entry.stopped) return;
  entry.stopped = true;
  for (const started of entry.pages) {
    const page = await started;
    if (!page || page.isClosed()) continue;
    try {
      write(executedStarts(await page.coverage.stopJSCoverage()));
    } catch {
      /* the window closed under us */
    }
  }
  try {
    await app.evaluate(() => process.mainModule.require('v8').takeCoverage());
  } catch {
    /* the app is already gone; whatever it flushed on exit is in host-raw */
  }
}

/** Fold the host's raw `NODE_V8_COVERAGE` files into the compact form, and drop them. */
export function compactHostCoverage() {
  const dir = coverageDir();
  if (!dir) return;
  const raw = join(dir, 'host-raw');
  let files;
  try {
    files = readdirSync(raw);
  } catch {
    return;
  }
  for (const f of files) {
    try {
      write(executedStarts(JSON.parse(readFileSync(join(raw, f), 'utf8')).result ?? []));
    } catch {
      /* a file the exiting process left half-written */
    }
  }
  rmSync(raw, { recursive: true, force: true });
}
