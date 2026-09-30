/**
 * CI failure artifacts for e2e scenarios, driven by the harness (`launchElectron`, teardown,
 * `finishScenario`). Spec: docs/specs/archive/2026-09-29-remote-e2e-lean-loop.md §3 "Failure artifacts".
 *
 * Measured on hosted runners (spec §2, Slice 0 results): tracing only works snapshots-only and
 * started once the first window is ready, and a screenshot costs 1–8 s per window — so every app
 * is traced, but windows are screenshotted only on the failure path.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** `$E2E_ARTIFACT_DIR/<scenario>/attempt-<n>/`, or null unless the runner set all three. */
export function attemptDir(env = process.env) {
  const { E2E_ARTIFACT_DIR: root, E2E_SCENARIO: scenario, E2E_ATTEMPT: attempt } = env;
  return root && scenario && attempt ? join(root, scenario, `attempt-${attempt}`) : null;
}

const traced = new WeakMap();
let traceSeq = 0;
let shotSeq = 0;

/**
 * Start tracing without holding up the scenario: waiting for the window here would delay the
 * caller past events it may be listening for. `app.close` is wrapped so the trace is saved first.
 */
export function startCapture(app, log = console.log) {
  const dir = attemptDir();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const entry = { k: traceSeq++, stopped: false, shot: false };
  entry.started = (async () => {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
    await app.context().tracing.start({ screenshots: false, snapshots: true });
    return true;
  })().catch((e) => {
    log(`[artifacts] tracing not started: ${e?.message || e}`);
    return false;
  });
  traced.set(app, entry);
  const close = app.close.bind(app);
  app.close = async () => {
    await stopTrace(app);
    return close();
  };
}

export async function stopTrace(app) {
  const entry = traced.get(app);
  if (!entry || entry.stopped) return;
  entry.stopped = true;
  if (!(await entry.started)) return;
  try {
    await app.context().tracing.stop({ path: join(attemptDir(), `trace-${entry.k}.zip`) });
  } catch {
    /* the app is already gone; its trace went with it */
  }
}

export async function screenshotWindows(app) {
  const entry = traced.get(app);
  if (!entry || entry.shot) return;
  entry.shot = true;
  for (const page of app.windows()) {
    try {
      await page.screenshot({ path: join(attemptDir(), `win-${shotSeq++}.png`), timeout: 7000 });
    } catch {
      /* a closing or crashed window */
    }
  }
}
