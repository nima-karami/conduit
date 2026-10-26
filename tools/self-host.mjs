#!/usr/bin/env node
/**
 * Self-hosting: run a visible dev Conduit whose sessions develop Conduit itself.
 *
 * The app runs from its own detached worktree (default `<repo>/../conduit-selfhost`), never from
 * the worktree the agents edit, so an in-progress edit can't break the running host. `restart`
 * moves that worktree to the agents' latest commit, rebuilds, and relaunches.
 *
 *   node tools/self-host.mjs start   [--ref <git ref>]   sync, build, launch (visible)
 *   node tools/self-host.mjs restart [--ref <git ref>]   stop + start
 *   node tools/self-host.mjs stop | status
 *   node tools/self-host.mjs sessions                    list sessions (id, agent, title)
 *   node tools/self-host.mjs open <agentId> <path>       open a session
 *   node tools/self-host.mjs type <sessionId> <text> [--enter]
 *   node tools/self-host.mjs screen <sessionId> [--json]  print the visible terminal rows
 *   node tools/self-host.mjs shot <file.png>             screenshot the window
 *
 * Profile: `--user-data-dir` (default `%APPDATA%/Conduit (selfhost)`), so it never shares state
 * or the MCP pipe with an installed Conduit. Driving goes over a localhost-only CDP port.
 * App stdout/stderr land in `<userData>/selfhost-logs/`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../test/e2e/harness.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const bool = (name) => {
  const i = argv.indexOf(name);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};
const enter = bool('--enter');
const json = bool('--json');
const REF = flag('--ref', 'HEAD');
const RUN_DIR = resolve(flag('--run-dir', join(REPO, '..', 'conduit-selfhost')));
const USER_DATA = resolve(
  flag('--user-data-dir', join(process.env.APPDATA ?? REPO, 'Conduit (selfhost)')),
);
const PORT = Number(flag('--port', '9333'));
const STATE = join(USER_DATA, 'selfhost.json');
const [cmd, ...rest] = argv;

const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
};
const readState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null);
const alive = (pid) => {
  // Checked by PID and image together: a recycled PID must never get killed.
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
    encoding: 'utf8',
  });
  return r.stdout.toLowerCase().includes('"electron.exe"');
};

function syncRunDir() {
  const sha = git(REPO, 'rev-parse', REF);
  if (!existsSync(RUN_DIR)) git(REPO, 'worktree', 'add', '--detach', RUN_DIR, sha);
  if (git(RUN_DIR, 'status', '--porcelain')) throw new Error(`${RUN_DIR} has local edits`);
  git(RUN_DIR, 'checkout', '--quiet', '--detach', sha);
  const nm = join(RUN_DIR, 'node_modules');
  if (!existsSync(nm)) {
    const common = resolve(REPO, git(REPO, 'rev-parse', '--git-common-dir'));
    symlinkSync(join(dirname(common), 'node_modules'), nm, 'junction');
  }
  return sha;
}

function build() {
  const r = spawnSync('npm', ['run', 'build'], { cwd: RUN_DIR, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error(`build failed (exit ${r.status}); app not relaunched`);
}

function start() {
  const st = readState();
  if (st && alive(st.pid)) throw new Error(`already running (pid ${st.pid})`);
  const sha = syncRunDir();
  build();
  const logs = join(USER_DATA, 'selfhost-logs');
  mkdirSync(logs, { recursive: true });
  const logFile = join(logs, `app-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const out = openSync(logFile, 'a');
  const electron = createRequire(join(RUN_DIR, 'package.json'))('electron');
  const child = spawn(
    electron,
    [`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`, RUN_DIR],
    {
      cwd: RUN_DIR,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: false,
      // Launched from an agent's shell: its session markers would make every Claude in the app a
      // child of that agent (no transcript, not a messaging peer).
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE'))),
    },
  );
  child.unref();
  writeFileSync(STATE, JSON.stringify({ pid: child.pid, sha, logFile, port: PORT }, null, 2));
  console.log(`started pid ${child.pid} @ ${sha.slice(0, 8)}; log ${logFile}`);
}

function stop() {
  const st = readState();
  if (!st || !alive(st.pid)) return console.log('not running');
  spawnSync('taskkill', ['/PID', String(st.pid), '/T', '/F'], { stdio: 'inherit' });
}

async function withPage(fn) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => !p.url().startsWith('devtools:'));
    if (!page) throw new Error('no app window');
    await page.evaluate(() => {
      if (window.__selfhost) return;
      window.__selfhost = true;
      // Opt-in test observability (terminal-pane.tsx): panes mounted from now on register here.
      window.__terms ??= {};
      window.__sessions = [];
      window.agentDeck.subscribe((m) => {
        if (m.type === 'state') window.__sessions = m.sessions || [];
      });
      window.agentDeck.post({ type: 'ready' });
    });
    await page.waitForFunction(() => window.__sessions.length >= 0);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

const sessions = (page) =>
  page.evaluate(() =>
    window.__sessions.map((s) => ({ id: s.id, agentId: s.agentId, title: s.title, cwd: s.cwd })),
  );

const commands = {
  start,
  stop,
  restart: () => {
    stop();
    start();
  },
  status: () => {
    const st = readState();
    console.log(st ? { ...st, running: alive(st.pid) } : 'never started');
  },
  sessions: () => withPage(async (page) => console.table(await sessions(page))),
  open: ([agentId, path]) =>
    withPage(async (page) => {
      const before = (await sessions(page)).map((s) => s.id);
      await page.evaluate(
        ({ a, p }) => window.agentDeck.post({ type: 'openRepo', path: p, agentId: a }),
        { a: agentId, p: path.replace(/\\/g, '/') },
      );
      const id = await page
        .waitForFunction(
          (ids) => window.__sessions.map((s) => s.id).find((x) => !ids.includes(x)) ?? null,
          before,
          { timeout: 20_000 },
        )
        .then((h) => h.jsonValue());
      console.log(id);
    }),
  type: ([sid, ...words]) =>
    withPage(async (page) => {
      const text = words.join(' ');
      // Typed as one write, then Enter after a gap: a CLI treats a write ending in \r as a paste.
      await page.evaluate(
        ({ s, d }) => window.agentDeck.post({ type: 'term:input', sessionId: s, data: d }),
        { s: sid, d: text },
      );
      if (enter) {
        await page.waitForTimeout(400);
        await page.evaluate(
          (s) => window.agentDeck.post({ type: 'term:input', sessionId: s, data: '\r' }),
          sid,
        );
      }
    }),
  screen: ([sid]) =>
    withPage(async (page) => {
      const rows = await page.evaluate((s) => {
        const t = window.__terms?.[s];
        if (!t) return null;
        const b = t.buffer.active;
        const out = [];
        for (let y = 0; y < t.rows; y++)
          out.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
        return { rows: out, cursorY: b.cursorY };
      }, sid);
      if (!rows) throw new Error('pane not registered: open it after the first self-host command');
      if (json) return console.log(JSON.stringify({ cursorY: rows.cursorY, lines: rows.rows }));
      console.log(rows.rows.join('\n'));
      console.log(`--- cursorY ${rows.cursorY}`);
    }),
  shot: ([file]) => withPage((page) => page.screenshot({ path: resolve(file) })),
};

const run = commands[cmd];
if (!run) {
  console.error(`usage: self-host.mjs ${Object.keys(commands).join('|')}`);
  process.exit(2);
}
await run(rest);
