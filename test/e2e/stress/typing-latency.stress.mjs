/**
 * Typing latency — keystroke-to-echo time in the focused terminal, idle and under load.
 *
 * A real `page.keyboard` key goes into the focused xterm of a cmd session; the scenario times it
 * from the key's keydown (capture listener) to the moment the echoed char is in the xterm buffer
 * (`onWriteParsed`). Stage stamps on the way, all on the shared epoch clock
 * (`performance.timeOrigin + performance.now()` in each process):
 *   inject   node, just before `keyboard.press`
 *   down     renderer, keydown (capture)
 *   data     renderer, xterm `onData` (what the pane posts as term:input)
 *   mainIn   main, `ipcMain 'to-host'` term:input
 *   mainOut  main, `webContents.send('to-webview')` term:data carrying the echo
 *   recv     renderer, bridge subscriber sees that term:data
 *   parsed   renderer, buffer holds the char
 * mainIn → mainOut is the server + hc + ConPTY + cmd round trip (the server is its own process and
 * is not instrumented); per phase, `echo %time%` probes split it at cmd (see stampProbes).
 *
 * Phases (TYPING_PHASES=A,B,C,D or `--phases=A,C`; default all):
 *   A idle · B CPU (one normal-priority busy-loop child per core) · C output contention (other
 *   sessions in the window flooding) · D both.
 * Each phase types TYPING_HUMAN_KEYS (200) keys at 80–120 ms and TYPING_BURST_KEYS (120) at 20 ms.
 * TYPING_OUT=<file> also writes the per-key records as JSON.
 *
 * The app runs hidden, where Chromium throttles rAF, so this is pipeline-to-buffer latency, not
 * paint. The app tree runs at normal priority here (not the harness's below-normal), because a
 * user's app competes with their load at normal priority; CONDUIT_E2E_PRIORITY overrides.
 *
 * Invariant: every phase echoes ≥ 95% of its keys. The latencies are advisory.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { constants, cpus, setPriority, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { revealSessionRow } from '../harness.mjs';
import {
  assertInvariant,
  emitReport,
  openSession,
  runStress,
  startPerf,
  stopPerf,
  waitForShellReady,
} from './harness-stress.mjs';

process.env.CONDUIT_E2E_PRIORITY ??= 'normal';

const NAME = 'typing-latency';
const ALL_PHASES = ['A', 'B', 'C', 'D'];
const PHASE_LABEL = { A: 'idle', B: 'cpu', C: 'output', D: 'cpu+output' };
const phaseArg = process.argv.find((a) => a.startsWith('--phases='))?.slice(9);
const PHASES = (phaseArg ?? process.env.TYPING_PHASES ?? ALL_PHASES.join(','))
  .split(',')
  .map((p) => p.trim().toUpperCase())
  .filter((p) => ALL_PHASES.includes(p));
const HUMAN_KEYS = Number(process.env.TYPING_HUMAN_KEYS ?? 200);
const BURST_KEYS = Number(process.env.TYPING_BURST_KEYS ?? 120);
const FLOOD_SESSIONS = 3;
const BUSY_PROCS = cpus().length;
// Distinct chars per line, so a chunk carrying a char names exactly one pending key.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const LINE_KEYS = 30;
const ECHO_TIMEOUT_MS = 30_000;
// `prompt $G`: a bare ">", so no prompt char can match a typed key.
const PROMPT = '>';
const LOAD_WARMUP_MS = 2000;
// CSI, OSC and two-byte escapes: their final bytes are letters a typed key could match.
const ANSI_SRC = String.raw`\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|.)`;

const now = () => performance.timeOrigin + performance.now();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Deterministic 80–120 ms gaps, so a before/after run types the same rhythm. */
function humanGaps(n) {
  let s = 0x9e3779b9;
  return Array.from({ length: n }, () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    return 80 + (s % 41);
  });
}

function percentile(sorted, p) {
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
    : null;
}

const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

function stats(xs) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return {
    n: v.length,
    min: r1(s[0]),
    p50: r1(percentile(s, 50)),
    p95: r1(percentile(s, 95)),
    p99: r1(percentile(s, 99)),
    max: r1(s.at(-1)),
    mean: r1(mean),
    sd: r1(sd),
    over50: v.filter((x) => x > 50).length,
    over100: v.filter((x) => x > 100).length,
  };
}

const BUCKETS = [2, 5, 10, 16, 20, 33, 50, 100, 250, Number.POSITIVE_INFINITY];
function histogram(xs) {
  const h = Object.fromEntries(BUCKETS.map((b) => [`<=${b}`, 0]));
  for (const x of xs) h[`<=${BUCKETS.find((b) => x <= b)}`]++;
  return h;
}

// ─── load generators ────────────────────────────────────────────────────────

/** Only these PIDs are ever killed. */
const busy = new Set();
process.once('exit', () => {
  for (const c of busy) c.kill();
});

function startCpuLoad(n) {
  for (let i = 0; i < n; i++) {
    const c = spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' });
    try {
      setPriority(c.pid, constants.priority.PRIORITY_NORMAL);
    } catch {
      /* exited */
    }
    busy.add(c);
  }
}

async function stopCpuLoad() {
  const exits = [...busy].map(
    (c) => new Promise((r) => (c.exitCode !== null ? r() : c.once('exit', r))),
  );
  for (const c of busy) c.kill();
  await Promise.all(exits);
  busy.clear();
}

const post = (page, sid, data) =>
  page.evaluate(
    ([s, d]) => window.agentDeck.post({ type: 'term:input', sessionId: s, data: d }),
    [sid, data],
  );

async function startFlood(page, sids) {
  // for /L with step 0 never ends; Ctrl+C stops it.
  for (const s of sids)
    await post(
      page,
      s,
      'for /L %i in (0,0,1) do @echo FLOOD_LINE_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\r',
    );
}

async function stopFlood(page, sids) {
  for (const s of sids) await post(page, s, '\x03');
  // Drain: wait until the flood sessions have been quiet for 1 s.
  const deadline = Date.now() + 15_000;
  let last = -1;
  while (Date.now() < deadline) {
    const n = await page.evaluate(() => window.__tlFloodMsgs);
    if (n === last) return;
    last = n;
    await wait(1000);
  }
}

// ─── instrumentation ────────────────────────────────────────────────────────

/** Renderer side: keydown / onData / term:data / buffer-parsed stamps for the typing session. */
async function installRenderer(page, sid, floodSids) {
  await page.evaluate(
    ([s, floods, ansiSrc]) => {
      const now = () => performance.timeOrigin + performance.now();
      const ansi = new RegExp(ansiSrc, 'g');
      const term = window.__terms[s];
      const st = {
        armed: false,
        keys: [],
        line: [],
        base: '',
        parseCalls: 0,
        mismatches: 0,
        sid: s,
      };
      window.__tl = st;
      window.__tlFloodMsgs = 0;
      // Esc repaints the erased input as explicit spaces, which translateToString keeps.
      const cursorLine = () => {
        const b = term.buffer.active;
        let row = b.baseY + b.cursorY;
        while (row > 0 && b.getLine(row)?.isWrapped) row--;
        let text = b.getLine(row)?.translateToString(true) ?? '';
        while (b.getLine(row + 1)?.isWrapped) text += b.getLine(++row).translateToString(true);
        return text.trimEnd();
      };
      st.cursorLine = cursorLine;
      document.addEventListener(
        'keydown',
        (e) => {
          if (!st.armed || e.key.length !== 1) return;
          const k = { ch: e.key, down: now(), data: null, recv: null, parsed: null };
          st.keys.push(k);
          st.line.push(k);
        },
        true,
      );
      term.onData((d) => {
        const t = now();
        for (const k of st.line) if (k.data === null && d.includes(k.ch)) k.data = t;
      });
      window.agentDeck.subscribe((m) => {
        if (m.type !== 'term:data') return;
        if (floods.includes(m.sessionId)) {
          window.__tlFloodMsgs++;
          return;
        }
        if (m.sessionId !== s) return;
        const t = now();
        const plain = m.data.replace(ansi, '');
        for (const k of st.line) if (k.recv === null && plain.includes(k.ch)) k.recv = t;
      });
      term.onWriteParsed(() => {
        if (!st.line.length) return;
        const t = now();
        st.parseCalls++;
        const text = cursorLine();
        if (!text.startsWith(st.base)) return;
        const echoed = text.slice(st.base.length);
        for (let i = 0; i < st.line.length && i < echoed.length; i++) {
          const k = st.line[i];
          if (k.parsed !== null) continue;
          if (echoed[i] === k.ch) k.parsed = t;
          else st.mismatches++;
        }
      });
    },
    [sid, floodSids, ANSI_SRC],
  );
}

/** Main side: term:input in and term:data out for the typing session. */
async function installMain(app, sid) {
  await app.evaluate(({ ipcMain, BrowserWindow }, s) => {
    const { performance: perf } = process.getBuiltinModule('perf_hooks');
    const now = () => perf.timeOrigin + perf.now();
    const st = { ins: [], outs: [] };
    globalThis.__tlMain = st;
    ipcMain.on('to-host', (_e, m) => {
      if (m?.type === 'term:input' && m.sessionId === s) st.ins.push({ t: now(), d: m.data });
    });
    for (const w of BrowserWindow.getAllWindows()) {
      const wc = w.webContents;
      const send = wc.send.bind(wc);
      wc.send = (channel, msg, ...rest) => {
        if (channel === 'to-webview' && msg?.type === 'term:data' && msg.sessionId === s)
          st.outs.push({ t: now(), d: msg.data });
        return send(channel, msg, ...rest);
      };
    }
  }, sid);
}

// ─── typing driver ──────────────────────────────────────────────────────────

/** Type `gaps.length` keys on an absolute schedule, `LINE_KEYS` per cmd line, Esc between lines. */
async function typeKeys(page, gaps, injects) {
  let i = 0;
  while (i < gaps.length) {
    const n = Math.min(LINE_KEYS, gaps.length - i);
    await waitForPrompt(page);
    await page.evaluate(() => {
      const st = window.__tl;
      st.line = [];
      st.base = '>';
      st.armed = true;
    });
    let at = now();
    for (let j = 0; j < n; j++, i++) {
      at += gaps[i];
      const ahead = at - now();
      if (ahead > 0) await wait(ahead);
      injects.push(now());
      await page.keyboard.press(ALPHABET[j % ALPHABET.length]);
    }
    await page
      .waitForFunction(() => window.__tl.line.every((k) => k.parsed !== null), null, {
        timeout: ECHO_TIMEOUT_MS,
        polling: 20,
      })
      .catch(() => {});
    await page.evaluate(() => {
      window.__tl.armed = false;
    });
    // Esc clears cmd's input line.
    await page.keyboard.press('Escape');
  }
  await waitForPrompt(page);
}

/** The cursor line is the bare prompt: the last line's Esc (and every echo before it) landed. */
async function waitForPrompt(page) {
  const ok = await page
    .waitForFunction((p) => window.__tl.cursorLine() === p, PROMPT, {
      timeout: ECHO_TIMEOUT_MS,
      polling: 20,
    })
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    const d = await page.evaluate(() => {
      const b = window.__terms[window.__tl.sid].buffer.active;
      const rows = [];
      for (let r = Math.max(0, b.baseY + b.cursorY - 3); r <= b.baseY + b.cursorY; r++)
        rows.push(b.getLine(r)?.translateToString(true));
      return { cursor: window.__tl.cursorLine(), rows };
    });
    console.log(`[${NAME}] prompt not bare after ${ECHO_TIMEOUT_MS} ms: ${JSON.stringify(d)}`);
  }
}

const strip = (d) => d.replace(new RegExp(ANSI_SRC, 'g'), '');

/** Join renderer keys with node inject stamps and main in/out stamps (in order, by char). */
function joinStages(keys, injects, main) {
  let inAt = 0;
  return keys.map((k, idx) => {
    const rec = { ...k, inject: injects[idx] ?? null, mainIn: null, mainOut: null };
    for (let j = inAt; j < main.ins.length; j++) {
      if (main.ins[j].d.includes(k.ch) && main.ins[j].t >= k.down - 5) {
        rec.mainIn = main.ins[j].t;
        inAt = j + 1;
        break;
      }
    }
    if (rec.mainIn !== null) {
      const out = main.outs.find((o) => o.t >= rec.mainIn && strip(o.d).includes(k.ch));
      rec.mainOut = out?.t ?? null;
    }
    return rec;
  });
}

function summarize(recs) {
  const d = (a, b) => recs.map((r) => (r[a] !== null && r[b] !== null ? r[b] - r[a] : null));
  const echoed = recs.filter((r) => r.parsed !== null);
  // Keys whose echo landed in the same parse callback as an earlier key: echoes in batches.
  const parsedAt = new Map();
  for (const r of echoed) parsedAt.set(r.parsed, (parsedAt.get(r.parsed) ?? 0) + 1);
  const batched = [...parsedAt.values()].filter((c) => c > 1).reduce((a, c) => a + c, 0);
  const downs = recs.map((r) => r.down);
  const total = d('down', 'parsed');
  return {
    keys: recs.length,
    echoed: echoed.length,
    total: stats(total),
    hist: histogram(total.filter((x) => x !== null)),
    stages: {
      dispatch: stats(d('inject', 'down')),
      xtermOnData: stats(d('down', 'data')),
      ipcToMain: stats(d('data', 'mainIn')),
      serverRoundTrip: stats(d('mainIn', 'mainOut')),
      ipcToRenderer: stats(d('mainOut', 'recv')),
      parse: stats(d('recv', 'parsed')),
      injectToParsed: stats(d('inject', 'parsed')),
    },
    batchedKeys: batched,
    keyGap: stats(downs.slice(1).map((t, i) => t - downs[i])),
  };
}

const STAMP_PROBES = 5;
const STAMP_SRC = String.raw`_\s?(\d{1,2}):(\d{2}):(\d{2})[.,](\d{2})`;

/**
 * Split mainIn → mainOut at the program: cmd expands `%time%` when it runs the line, so
 * `echo S<i>_%time%` stamps when the input reached cmd (10 ms resolution, local clock, same
 * machine). inLeg = main → server → hc → ConPTY → cmd; outLeg = cmd → ConPTY → hc → main.
 */
async function stampProbes(page, app, sid) {
  await app.evaluate(() => {
    globalThis.__tlMain.ins = [];
    globalThis.__tlMain.outs = [];
  });
  for (let i = 0; i < STAMP_PROBES; i++) {
    await post(page, sid, `echo S${i}_%time%\r`);
    await wait(300);
  }
  await page
    .waitForFunction(
      ([s, n]) => (window.__capBy?.[s] ?? '').includes(`S${n - 1}_`),
      [sid, STAMP_PROBES],
      { timeout: ECHO_TIMEOUT_MS },
    )
    .catch(() => {});
  await waitForPrompt(page);
  const main = await app.evaluate(() => globalThis.__tlMain);
  const day = new Date();
  const rows = [];
  for (let i = 0; i < STAMP_PROBES; i++) {
    const sent = main.ins.find((x) => x.d.startsWith(`echo S${i}_`))?.t ?? null;
    let out = null;
    let ran = null;
    // A stamp line can straddle two chunks, so match the stream accumulated so far.
    const re = new RegExp(`S${i}${STAMP_SRC}`);
    let seen = '';
    for (const o of main.outs) {
      seen += strip(o.d);
      const m = re.exec(seen);
      if (!m) continue;
      out = o.t;
      ran = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        Number(m[4]) * 10,
      ).getTime();
      break;
    }
    rows.push({
      inLeg: sent !== null && ran !== null ? ran - sent : null,
      outLeg: out !== null && ran !== null ? out - ran : null,
    });
  }
  return { inLeg: stats(rows.map((r) => r.inLeg)), outLeg: stats(rows.map((r) => r.outLeg)) };
}

// ─── scenario ───────────────────────────────────────────────────────────────

runStress(NAME, async ({ app, page, log }) => {
  log(
    `phases ${PHASES.join(',')} · ${HUMAN_KEYS} human + ${BURST_KEYS} burst keys · ${BUSY_PROCS} busy procs (B/D) · ${FLOOD_SESSIONS} flood sessions (C/D)`,
  );
  log('hidden window: rAF is throttled, so this is pipeline-to-buffer latency, not paint');
  const root = mkdtempSync(join(tmpdir(), 'conduit-typing-latency-'));
  await page.evaluate(() => {
    window.__terms = {};
  });

  const needFlood = PHASES.some((p) => p === 'C' || p === 'D');
  const floodSids = [];
  if (needFlood) {
    for (let i = 0; i < FLOOD_SESSIONS; i++) {
      const s = await openSession(page, { path: root, agentId: 'shell:cmd' });
      await waitForShellReady(page, s);
      floodSids.push(s);
    }
  }
  const sid = await openSession(page, { path: root, agentId: 'shell:cmd' });
  await waitForShellReady(page, sid);
  await post(page, sid, 'prompt $G\r');
  await wait(300);
  await post(page, sid, 'cls\r');
  await wait(500);
  const row = `[data-agent-tree] .session[data-sessionid="${sid}"]`;
  await revealSessionRow(page, sid);
  await page.locator(row).click();
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.getAttribute('aria-selected') === 'true',
    row,
    { timeout: 10_000 },
  );
  await page.waitForFunction((s) => !!window.__terms[s], sid, { timeout: 10_000 });
  await page.evaluate((s) => window.__terms[s].focus(), sid);
  const focused = await page.evaluate(() =>
    document.activeElement?.classList.contains('xterm-helper-textarea'),
  );
  assertInvariant(focused, 'the typing session xterm did not take focus');

  await installRenderer(page, sid, floodSids);
  await installMain(app, sid);

  // Warm the path once (first keys after a spawn are slower and not what we measure).
  await typeKeys(page, humanGaps(10), []);

  const results = {};
  const raw = {};
  for (const p of PHASES) {
    const cpu = p === 'B' || p === 'D';
    const flood = p === 'C' || p === 'D';
    if (cpu) startCpuLoad(BUSY_PROCS);
    if (flood) await startFlood(page, floodSids);
    if (cpu || flood) await wait(LOAD_WARMUP_MS);
    const floodBefore = await page.evaluate(() => window.__tlFloodMsgs);

    const sub = {};
    await startPerf(page, `${NAME}-${p}`);
    for (const [kind, gaps] of [
      ['human', humanGaps(HUMAN_KEYS)],
      ['burst', Array(BURST_KEYS).fill(20)],
    ]) {
      await page.evaluate(() => {
        window.__tl.keys = [];
      });
      await app.evaluate(() => {
        globalThis.__tlMain.ins = [];
        globalThis.__tlMain.outs = [];
      });
      const injects = [];
      await typeKeys(page, gaps, injects);
      const keys = await page.evaluate(() =>
        window.__tl.keys.map(({ ch, down, data, recv, parsed }) => ({
          ch,
          down,
          data,
          recv,
          parsed,
        })),
      );
      const main = await app.evaluate(() => globalThis.__tlMain);
      const recs = joinStages(keys, injects, main);
      sub[kind] = summarize(recs);
      raw[`${p}-${kind}`] = recs;
    }
    sub.cmdStamp = await stampProbes(page, app, sid);
    const perf = await stopPerf(page);
    const floodMsgs = (await page.evaluate(() => window.__tlFloodMsgs)) - floodBefore;

    if (flood) await stopFlood(page, floodSids);
    if (cpu) await stopCpuLoad();

    const mismatches = await page.evaluate(() => window.__tl.mismatches);
    results[p] = { label: PHASE_LABEL[p], ...sub, floodMsgs, mismatches };
    emitReport(`${NAME}-${p}`, perf, { phase: PHASE_LABEL[p], ...sub, floodMsgs });
    log(
      `${p} cmd %time% split (ms, ±10): inLeg ${JSON.stringify(sub.cmdStamp.inLeg)} outLeg ${JSON.stringify(sub.cmdStamp.outLeg)}`,
    );
    for (const kind of ['human', 'burst']) {
      const s = sub[kind];
      log(
        `${p} ${PHASE_LABEL[p]} ${kind}: echoed ${s.echoed}/${s.keys} total ${JSON.stringify(s.total)}`,
      );
      log(
        `   stages p50/p95/max: ${Object.entries(s.stages)
          .map(([k, v]) => `${k}=${v?.p50}/${v?.p95}/${v?.max}`)
          .join(' ')}`,
      );
      log(`   hist ${JSON.stringify(s.hist)} batched=${s.batchedKeys} keyGap p50=${s.keyGap?.p50}`);
    }
    log(
      `   main lag block=${perf.lag.totalMs}ms maxStall=${perf.lag.maxMs}ms stalls=${perf.lag.stalls} floodMsgs=${floodMsgs}`,
    );
  }

  console.log('\n| phase | kind | echoed | p50 | p95 | p99 | max | sd | >50 | >100 |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const [p, r] of Object.entries(results))
    for (const kind of ['human', 'burst']) {
      const t = r[kind].total ?? {};
      console.log(
        `| ${p} ${r.label} | ${kind} | ${r[kind].echoed}/${r[kind].keys} | ${t.p50} | ${t.p95} | ${t.p99} | ${t.max} | ${t.sd} | ${t.over50} | ${t.over100} |`,
      );
    }

  if (process.env.TYPING_OUT)
    writeFileSync(process.env.TYPING_OUT, JSON.stringify({ results, raw }, null, 1));

  for (const [p, r] of Object.entries(results))
    for (const kind of ['human', 'burst'])
      assertInvariant(
        r[kind].echoed >= r[kind].keys * 0.95,
        `phase ${p} ${kind}: only ${r[kind].echoed}/${r[kind].keys} keys echoed within ${ECHO_TIMEOUT_MS} ms`,
      );
});
