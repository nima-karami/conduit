// A fake `claude` for the auto-resume scenarios (spec 2026-11-13-scheduler-auto-resume R11): it
// reads the `--settings <file>` Conduit passes, merges it with the user's settings the way Claude
// does (hooks merge, user first; a `statusLine` in --settings REPLACES the user's, spike S1) and
// runs the configured commands exactly as Claude would: through a POSIX shell, payload on stdin,
// payloads recorded from a real Claude (test/fixtures/claude-hooks) with `resets_at` rewritten.
//
//   node fake-claude-hooks.mjs --dir <dir> --label <label> [--as claude|codex] [--paste on|off]
//
// `--as codex` is the same TUI without settings or hooks: a Codex session's signals come from its
// rollout file, which the scenario writes, so only the input side is needed.
//
// The TUI turns bracketed paste on (or never does, `--paste off`), echoes what it receives, and
// logs it to `<dir>/<label>.jsonl` — the only place a scenario reads what the PTY delivered:
//   START {argv, cwd, as, paste, hookEvents, statusLine}   once the settings are read
//   READY                                                   SessionStart hook and first status line done
//   IN {t, d}                                               every stdin chunk, verbatim
//   PASTE {t, text}                                         one complete bracketed paste
//   ECHO_START / ECHO_DONE {t}                              the (deliberately slow) echo of a paste
//   SUBMIT {t, line}                                        Enter: the draft that was submitted
//   HOOK {event, source, code, ms}                          one hook command run (source user|conduit)
//   STATUS {source, out}                                    one status line run and what it printed
//   CUE {id, cue, ...} / CUE_DONE {id}                      a scenario command, taken and finished
//
// The scenario drives it by appending JSON lines to `<dir>/<label>.cue` (auto-resume-helpers.mjs):
//   {cue:'limit', resetsInS}          status line with rate_limits, then a StopFailure rate_limit hook
//   {cue:'status', resetsInS?}        one status line run (rate_limits only when resetsInS is given)
//   {cue:'hook', event, notificationType?}   UserPromptSubmit | Stop | Notification
//   {cue:'config', onSubmit:'none'|'prompt-hook'|'limit', resetsInS?}   what Enter does next
//   {cue:'bracketed', on}             turn bracketed paste on or off
//   {cue:'quit'}
// The screen never prints a limit notice: the limit rules scan it, and these scenarios are about
// the structured signal.
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ESC = String.fromCharCode(27);
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const CSI_SEQ = new RegExp(`^${ESC}\\[[0-9;?<>]*[ -/]*[@-~]`);
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', '..', 'fixtures', 'claude-hooks');

const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dir = argAfter('--dir');
const label = argAfter('--label') ?? `fake-${process.pid}`;
const as = argAfter('--as') === 'codex' ? 'codex' : 'claude';
let pasteOn = argAfter('--paste') !== 'off';
if (!dir) throw new Error('fake-claude-hooks: --dir is required');
mkdirSync(dir, { recursive: true });
const recordFile = join(dir, `${label}.jsonl`);
const cueFile = join(dir, `${label}.cue`);

const write = (s, cb) => process.stdout.write(s, cb);
const record = (kind, payload = {}) =>
  appendFileSync(recordFile, `${JSON.stringify({ kind, t: Date.now(), ...payload })}\n`);
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

// ── settings: Claude's merge ───────────────────────────────────────────────────────────────────
const settingsFlag = as === 'claude' ? argAfter('--settings') : undefined;
const flagSettings = settingsFlag ? readJson(settingsFlag) : null;
const userSettings =
  as === 'claude'
    ? readJson(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'))
    : null;
/** Hooks merge, user first (spike S1); a statusLine in --settings replaces the user's. */
const hooks = {};
for (const [source, settings] of [
  ['user', userSettings],
  ['conduit', flagSettings],
]) {
  for (const [event, groups] of Object.entries(settings?.hooks ?? {})) {
    hooks[event] = [...(hooks[event] ?? []), ...groups.map((g) => ({ ...g, source }))];
  }
}
const statusLine = flagSettings?.statusLine ?? userSettings?.statusLine ?? null;
const statusSource = flagSettings?.statusLine
  ? 'settings-flag'
  : userSettings?.statusLine
    ? 'user'
    : 'none';

// ── running a command the way Claude does ─────────────────────────────────────────────────────
function shell(command) {
  if (process.platform !== 'win32') return { file: '/bin/sh', args: ['-c', command] };
  // Claude on Windows runs hooks in Git Bash; GitHub's Windows runners ship it.
  const { ProgramFiles, LOCALAPPDATA } = process.env;
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    ProgramFiles && join(ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] &&
      join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    LOCALAPPDATA && join(LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter((p) => p && existsSync(p));
  if (candidates.length === 0) throw new Error('no Git Bash to run hooks with');
  return { file: candidates[0], args: ['-c', command] };
}

function runCommand(command, stdinText, timeoutS) {
  return new Promise((resolve) => {
    const started = Date.now();
    const { file, args } = shell(command);
    const child = spawn(file, args, {
      cwd: process.cwd(),
      env: { ...process.env, CLAUDE_PROJECT_DIR: process.cwd() },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const out = [];
    const timer = setTimeout(() => child.kill(), (timeoutS ?? 60) * 1000);
    child.stdout.on('data', (c) => out.push(c));
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdinText);
    const done = (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), ms: Date.now() - started });
    };
    child.on('error', () => done(-1));
    child.on('close', (code) => done(code));
  });
}

const matches = (matcher, value) =>
  matcher === undefined ||
  matcher === '' ||
  matcher === '*' ||
  (value !== undefined && new RegExp(`^(?:${matcher})$`).test(value));

const sessionId = '00000000-0000-4000-8000-0000000000a1';
const payloadFor = (name, extra = {}) => ({
  ...fixture(name),
  session_id: sessionId,
  cwd: process.cwd(),
  ...extra,
});

async function fireHook(event, payload, matcherValue) {
  for (const group of hooks[event] ?? []) {
    if (!matches(group.matcher, matcherValue)) continue;
    for (const hook of group.hooks ?? []) {
      if (hook.type !== 'command') continue;
      const r = await runCommand(hook.command, JSON.stringify(payload), hook.timeout);
      record('HOOK', { event, source: group.source, code: r.code, ms: r.ms });
    }
  }
}

async function runStatusLine(resetsInS) {
  if (statusLine?.type !== 'command') return;
  const payload = payloadFor(
    resetsInS === undefined ? 'statusline-startup' : 'statusline-rate-limits',
  );
  if (resetsInS !== undefined) {
    const sec = Math.floor(Date.now() / 1000) + resetsInS;
    payload.rate_limits.five_hour.resets_at = sec;
    // The weekly window is not the one at 100 %, and resets later.
    payload.rate_limits.seven_day.resets_at = sec + 3600;
  }
  const r = await runCommand(statusLine.command, JSON.stringify(payload), 10);
  const out = r.stdout.replace(/\n+$/, '');
  record('STATUS', {
    source: statusSource,
    out,
    ...(resetsInS === undefined ? {} : { resetsInS }),
  });
  if (out !== '') write(`\r\n${out.replace(/\n/g, '\r\n')}\r\n`);
}

async function limit(resetsInS) {
  const resetsAt = Math.floor(Date.now() / 1000) + resetsInS;
  // A real Claude refreshes the status line as the turn ends; the hook follows.
  await runStatusLine(resetsInS);
  write('\r\nFAKE-CLAUDE: turn failed\r\n');
  await fireHook('StopFailure', payloadFor('stop-failure-rate-limit'), 'rate_limit');
  record('LIMIT', { resetsAtMs: resetsAt * 1000 });
}

// ── the TUI ────────────────────────────────────────────────────────────────────────────────────
const PROMPT = as === 'codex' ? '› ' : '❯ ';
const prompt = () => write(`\r\n${PROMPT}`);
const display = (s) => s.replace(/\n/g, '\r\n');
const cfg = { onSubmit: 'none', resetsInS: 10 };
let chain = Promise.resolve();
const enqueue = (fn) => {
  chain = chain.then(fn).catch((err) => record('ERROR', { message: String(err?.message ?? err) }));
  return chain;
};

let line = '';
let inPaste = false;
let pasteBuf = '';
let rx = '';

function echoSlowly(text) {
  // Slower than the writer's 300 ms quiet window between parts, so an Enter sent after the
  // writer's first lull instead of after the echo lands inside it and is visible in the log.
  const parts = [];
  for (let i = 0; i < text.length; i += 1000) parts.push(text.slice(i, i + 1000));
  record('ECHO_START', { parts: parts.length });
  let i = 0;
  const step = () => {
    const last = i === parts.length - 1;
    write(display(parts[i]), last ? () => record('ECHO_DONE') : undefined);
    i += 1;
    if (!last) setTimeout(step, 120);
  };
  if (parts.length > 0) step();
}

function submit() {
  const got = line;
  line = '';
  record('SUBMIT', { line: got });
  write('\r\n');
  if (cfg.onSubmit === 'prompt-hook') {
    enqueue(() => fireHook('UserPromptSubmit', payloadFor('user-prompt-submit', { prompt: got })));
  } else if (cfg.onSubmit === 'limit') {
    enqueue(() => limit(cfg.resetsInS));
  }
  prompt();
}

function consume() {
  for (;;) {
    if (inPaste) {
      const end = rx.indexOf(PASTE_END);
      if (end < 0) {
        // Keep a possible partial end marker for the next chunk.
        const keep = Math.min(rx.length, PASTE_END.length - 1);
        pasteBuf += rx.slice(0, rx.length - keep);
        rx = rx.slice(rx.length - keep);
        return;
      }
      pasteBuf += rx.slice(0, end);
      rx = rx.slice(end + PASTE_END.length);
      inPaste = false;
      record('PASTE', { text: pasteBuf });
      line += pasteBuf;
      echoSlowly(pasteBuf);
      pasteBuf = '';
      continue;
    }
    if (rx === '') return;
    if (rx.startsWith(PASTE_START)) {
      rx = rx.slice(PASTE_START.length);
      inPaste = true;
      continue;
    }
    if (rx[0] === ESC) {
      if (PASTE_START.startsWith(rx)) return;
      const m = CSI_SEQ.exec(rx);
      if (m) rx = rx.slice(m[0].length);
      else if (rx.length > 1 && rx[1] === '[') return;
      else rx = rx.slice(1);
      continue;
    }
    const ch = rx[0];
    rx = rx.slice(1);
    if (ch === '\r') submit();
    else if (ch === '\x7f' || ch === '\b') {
      if (line.length > 0) {
        line = line.slice(0, -1);
        write('\b \b');
      }
    } else if (ch !== '\n') {
      line += ch;
      write(ch);
    }
  }
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  record('IN', { d: chunk });
  rx += chunk;
  consume();
});

// ── cues from the scenario ─────────────────────────────────────────────────────────────────────
let cueOffset = 0;
let cueTail = '';
function readCues() {
  if (!existsSync(cueFile)) return [];
  const size = statSync(cueFile).size;
  if (size <= cueOffset) return [];
  const fd = openSync(cueFile, 'r');
  try {
    const buf = Buffer.alloc(size - cueOffset);
    readSync(fd, buf, 0, buf.length, cueOffset);
    cueOffset = size;
    const parts = (cueTail + buf.toString('utf8')).split('\n');
    cueTail = parts.pop() ?? '';
    return parts.filter((p) => p.trim() !== '').map((p) => JSON.parse(p));
  } finally {
    closeSync(fd);
  }
}

async function runCue(c) {
  record('CUE', { ...c });
  switch (c.cue) {
    case 'limit':
      await limit(c.resetsInS);
      break;
    case 'status':
      await runStatusLine(c.resetsInS);
      break;
    case 'hook':
      if (c.event === 'Notification') {
        await fireHook(
          'Notification',
          payloadFor('notification-quota-fired', { notification_type: c.notificationType }),
          c.notificationType,
        );
      } else if (c.event === 'UserPromptSubmit') {
        await fireHook('UserPromptSubmit', payloadFor('user-prompt-submit'));
      } else {
        await fireHook('Stop', payloadFor('stop'));
      }
      break;
    case 'config':
      Object.assign(cfg, {
        onSubmit: c.onSubmit ?? cfg.onSubmit,
        resetsInS: c.resetsInS ?? cfg.resetsInS,
      });
      break;
    case 'bracketed':
      pasteOn = c.on === true;
      write(pasteOn ? `${ESC}[?2004h` : `${ESC}[?2004l`);
      break;
    case 'quit':
      record('CUE_DONE', { id: c.id });
      process.exit(0);
  }
  record('CUE_DONE', { id: c.id });
}
setInterval(() => {
  for (const c of readCues()) enqueue(() => runCue(c));
}, 100);

// ── start ──────────────────────────────────────────────────────────────────────────────────────
if (pasteOn) write(`${ESC}[?2004h`);
write(`FAKE-${as.toUpperCase()} ready`);
prompt();
record('START', {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  as,
  paste: pasteOn,
  hookEvents: Object.keys(hooks),
  statusLine: statusSource,
});
if (as === 'claude') {
  enqueue(async () => {
    await fireHook(
      'SessionStart',
      payloadFor('stop', { hook_event_name: 'SessionStart', source: 'startup' }),
      'startup',
    );
    await runStatusLine(undefined);
  });
}
enqueue(async () => record('READY'));
