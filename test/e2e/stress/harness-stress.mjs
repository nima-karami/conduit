/**
 * Stress/load-lane harness — a thin layer over the base e2e harness (test/e2e/harness.mjs).
 *
 * Adds three things the load scenarios need on top of launch/openSession/closeApp:
 *   1. Perf probe control — startPerf/stopPerf drive window.__conduitPerf (webview/perf-probe.ts)
 *      to measure frame cadence + long tasks during a load window.
 *   2. A report protocol — emitReport prints a `##PERF##` sentinel line the run-stress runner
 *      parses back into docs/runs/2026-07-07-stress-load/baseline.json, plus a human line.
 *   3. Load generators — file trees, big files, heavy markdown, and the shared arch corpus.
 *
 * Assert vs advisory (spec 2026-07-07-stress-load-testing.md): assertInvariant() FAILS the
 * scenario (structural regressions — windowing broke, scrollback uncapped). The numbers in
 * emitReport() are advisory: they print and are recorded, but never fail the lane.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, closeApp, launchApp, makeLog, openSession } from '../harness.mjs';
import { makeArchCorpus } from './arch-corpus.mjs';

export {
  assert,
  closeApp,
  launchApp,
  makeLog,
  openSession,
  REPO,
  tapBridge,
} from '../harness.mjs';
export { makeArchCorpus } from './arch-corpus.mjs';

/**
 * Structural invariant. Same failure semantics as assert (throws → scenario exits 1), but
 * named to mark the assert/advisory split: only invariants gate the lane.
 */
export const assertInvariant = assert;

/**
 * Standard scenario wrapper for the stress lane: launch → run body → closeApp → cleanup, with
 * the exit-code convention (0 pass / 1 invariant fail / 2 infra error) and non-win32 SKIP.
 * Uses closeApp (not a bare app.close()) so a scenario that opened running sessions doesn't hang
 * on the quit-guard. Scenarios needing a custom launch (e.g. a relaunch against a fixed profile)
 * drive launchApp/closeApp themselves instead of using this.
 */
export async function runStress(name, fn) {
  if (process.platform !== 'win32') {
    console.log(`[${name}] SKIP — lane is Windows-only (non-win32 platform)`);
    process.exit(0);
  }
  const log = makeLog(name);
  let launched = null;
  try {
    launched = await launchApp();
    await fn({ app: launched.app, page: launched.page, log });
    log('PASS ✓');
    process.exit(0);
  } catch (e) {
    if (e?.name === 'AssertionError') {
      log('FAIL ✗', e.message);
      process.exit(1);
    }
    console.error(`[${name}] ERROR:`, e?.stack || e?.message || e);
    process.exit(2);
  } finally {
    try {
      if (launched) await closeApp(launched.app, launched.page);
    } catch {
      /* best-effort */
    }
    try {
      await launched?.cleanup();
    } catch {
      /* ignore */
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Perf probe control
// ──────────────────────────────────────────────────────────────────────────────

/** Begin a measurement window (resets frame + long-task counters). */
export async function startPerf(page, label) {
  await page.evaluate((l) => window.__conduitPerf.start(l), label);
}

/** End the window and return the {@link PerfReport}. */
export async function stopPerf(page) {
  return page.evaluate(() => window.__conduitPerf.stop());
}

/**
 * Wall-clock time (ms) from performing `action` until `predicate` (evaluated in the page) becomes
 * true — an "input → observable effect" latency. Polls at a fixed interval rather than rAF, so it's
 * reliable under the hidden-window rAF throttle. `arg` is passed to the predicate.
 */
export async function measureUntil(
  page,
  action,
  predicate,
  { timeout = 20000, polling = 50, arg } = {},
) {
  const t0 = Date.now();
  await action();
  await page.waitForFunction(predicate, arg, { timeout, polling });
  return Date.now() - t0;
}

/**
 * Wait for an interactive shell to be at its prompt before driving it. openSession only waits for
 * the session to register, not for the PTY to spawn + cmd to reach its prompt — input fired before
 * then is dropped. So resend a unique marker every ~2s until it echoes back, then clear the capture.
 */
export async function waitForShellReady(page, sid, { timeout = 30000 } = {}) {
  const marker = `READY_${Math.random().toString(36).slice(2, 8)}`;
  await page.evaluate(() => {
    window.__cap = '';
  });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await page.evaluate(
      ({ s, m }) =>
        window.agentDeck.post({ type: 'term:input', sessionId: s, data: `echo ${m}\r` }),
      { s: sid, m: marker },
    );
    const seen = await page
      .waitForFunction((m) => (window.__cap || '').includes(m), marker, {
        timeout: 2000,
        polling: 100,
      })
      .then(() => true)
      .catch(() => false);
    if (seen) {
      await page.evaluate(() => {
        window.__cap = '';
      });
      return;
    }
  }
  throw new Error('shell did not reach its prompt in time');
}

// ──────────────────────────────────────────────────────────────────────────────
// Report protocol (parsed by run-stress.mjs)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Emit one scenario's metrics. Prints a machine-readable `##PERF##` line (aggregated into
 * baseline.json) and a human-readable summary. `extra` carries scenario-specific numbers
 * (load time, IPC count, quit duration…). Advisory only — never fails the lane.
 */
export function emitReport(name, report, extra = {}) {
  console.log(`##PERF## ${JSON.stringify({ scenario: name, ...report, ...extra })}`);
  console.log(
    `[${name}] block=${report.lag.totalMs}ms maxStall=${report.lag.maxMs}ms ` +
      `stalls=${report.lag.stalls} longTasks=${report.longTasks.count}/${report.longTasks.totalMs}ms ` +
      `frameGapMax=${report.maxFrameGapMs}ms` +
      (Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''),
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Canvas opener (extracted from arch-node-graph.e2e.mjs)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Open the architecture canvas via the command palette. Retried 4× because on a saturated
 * machine the palette/shortcut occasionally doesn't register (env flake, not a product bug).
 * Returns true once a node has rendered.
 */
export async function openArchCanvas(page) {
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached', timeout: 20000 });
  for (let attempt = 0; attempt < 4; attempt++) {
    await page
      .locator('.xterm-helper-textarea')
      .first()
      .focus()
      .catch(() => {});
    await page.keyboard.press('Control+Backquote');
    await page.waitForTimeout(250);
    await page.keyboard.press('Control+Shift+P');
    const palette = await page
      .waitForSelector('.palette', { state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (!palette) continue;
    await page.keyboard.type('architecture');
    await page.keyboard.press('Enter');
    const opened = await page
      .waitForSelector('.archnode', { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (opened) {
      // A large corpus must auto-layout before the __archDoc effect commits — allow generous time.
      await page.waitForFunction(() => !!window.__archDoc, null, { timeout: 30000 });
      return true;
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// Load generators
// ──────────────────────────────────────────────────────────────────────────────

/** Wrap an ArchDoc in the on-disk `.conduit/architecture.json` envelope. */
export function archEnvelope(doc) {
  return { conduit: 1, kind: 'architecture', updatedAt: Date.now(), data: doc };
}

/**
 * Write a large ArchDoc corpus to a project's `.conduit/architecture.json` so opening the
 * canvas loads it through the REAL host path (requestArchitecture → readArchitectureForProject).
 */
export function seedArchCorpus(projectRoot, opts) {
  const doc = makeArchCorpus(opts);
  mkdirSync(join(projectRoot, '.conduit'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.conduit', 'architecture.json'),
    JSON.stringify(archEnvelope(doc)),
  );
  return doc;
}

/** Create `count` small files under `dir` (flat). Returns dir. */
export function makeManyFiles(dir, count) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(join(dir, `f${String(i).padStart(5, '0')}.txt`), `entry ${i}\n`);
  }
  return dir;
}

/**
 * A ~`targetBytes` single-line minified-JS file — worst case for the tokenizer (Conduit caps
 * the read at 2 MB, so this sits right at the ceiling).
 */
export function makeBigMinifiedFile(path, targetBytes = 2 * 1024 * 1024) {
  const parts = [];
  let size = 0;
  let i = 0;
  while (size < targetBytes) {
    const s = `function f${i}(){return{a:${i},b:${i + 1},c:[${i},${i},${i}]};}var x${i}=f${i}();`;
    parts.push(s);
    size += s.length;
    i++;
  }
  writeFileSync(path, parts.join(''));
  return path;
}

/**
 * A markdown doc that stresses the whole rehype pipeline: many headings + fenced code blocks
 * (rehypeHighlight) and many mermaid fences (one render each). No virtualization guards this.
 */
export function makeHeavyMarkdown(path, { sections = 300, mermaid = 40 } = {}) {
  const parts = ['# Stress document\n'];
  for (let i = 0; i < sections; i++) {
    parts.push(
      `\n## Section ${i}\n\nSome **prose** with \`inline code\` and a [link](#section-${i}).\n`,
    );
    parts.push(`\n\`\`\`ts\nconst value${i} = () => {\n  return ${i} * 2;\n};\n\`\`\`\n`);
  }
  for (let i = 0; i < mermaid; i++) {
    parts.push(`\n\`\`\`mermaid\ngraph TD\n  A${i} --> B${i}\n  B${i} --> C${i}\n\`\`\`\n`);
  }
  writeFileSync(path, parts.join(''));
  return path;
}
