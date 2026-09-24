// The agent mf-live-edits.e2e.mjs spawns through a `claude.cmd`, so the claude adapter (matched by
// basename) passes it --add-dir. Every record ends in " <<END>>": ConPTY wraps and repaints, and
// the scenario reads output with the line breaks stripped. LAUNCH carries a per-process nonce, so a
// repaint or a replayed scrollback can never pass for a new spawn.
//
// It models what real claude 2.1.282 does that the host has to survive (mf-live-edits fix1 probe):
// - turns on bracketed paste and focus reporting, and answers a focus change with `ESC[?2004h`;
// - a bracketed paste only fills the draft; Enter submits it, but a `\` right before Enter
//   becomes a newline instead;
// - `/add-dir <p>` answers "Added <p> as a working directory for this session" (wrapped and
//   styled inside the path), or first opens a confirm once `confirm on` was submitted;
// - a dialog (that confirm, or `ask`, standing in for the folder-trust prompt) ignores a paste;
//   Enter or `1` accepts, Esc or `3` declines. Accepting `ask` exits, as "No, exit" does.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ESC = '\x1b';
const CSI_SEQ = new RegExp(`^${ESC}\\[[0-9;?]*[ -/]*[@-~]`);
const nonce = `${process.pid}-${Date.now()}`;
const write = (s) => process.stdout.write(s);
const out = (line) => write(`${line} <<END>>\r\n`);

write(`${ESC}[?2004h${ESC}[?1004h`);
out(`FAKE-CLAUDE LAUNCH ${nonce}`);
out(`FAKE-CLAUDE ARGS ${JSON.stringify(process.argv.slice(2))}`);
out(`FAKE-CLAUDE CWD ${process.cwd()}`);

let line = '';
let streaming = null;
let confirmAddDir = false;
/** null | { kind: 'addDir', path } | { kind: 'ask' } */
let dialog = null;

function work() {
  let n = 0;
  clearInterval(streaming);
  streaming = setInterval(() => {
    out(`FAKE-CLAUDE WORKING ${++n}`);
    if (n >= 40) {
      clearInterval(streaming);
      streaming = null;
      out('FAKE-CLAUDE IDLE');
    }
  }, 100);
}

function added(path) {
  const shown = path.replace(' ', `${ESC}[22m\r\n     ${ESC}[1m`);
  write(
    `  ⎿  ${ESC}[mAdded${ESC}[1m${ESC}[1C${shown}${ESC}[22m as a working directory for this session\r\n`,
  );
  out(`FAKE-CLAUDE ADDED ${path}`);
}

function answer(accept) {
  const d = dialog;
  dialog = null;
  if (d.kind === 'ask') {
    out(`FAKE-CLAUDE PROMPT-ANSWERED ${accept ? 'yes' : 'no'}`);
    if (accept) process.exit(0);
    return;
  }
  if (accept) {
    added(d.path);
    return;
  }
  write(`  ⎿  Did${ESC}[1Cnot${ESC}[1Cadd ${d.path} as a\r\n     working directory.\r\n`);
  out(`FAKE-CLAUDE DECLINED ${d.path}`);
}

function submit() {
  const got = line;
  line = '';
  out(`FAKE-CLAUDE GOT ${got}`);
  if (got === 'work') {
    work();
  } else if (got === 'confirm on' || got === 'confirm off') {
    confirmAddDir = got === 'confirm on';
  } else if (got === 'ask') {
    dialog = { kind: 'ask' };
    out('FAKE-CLAUDE ASK Do you trust this folder? ❯ No, exit / Yes');
  } else if (got.startsWith('/add-dir ')) {
    const path = resolve(got.slice('/add-dir '.length).trim());
    if (!existsSync(path)) {
      write(`  ⎿  Path ${path} was not found.\r\n`);
    } else if (confirmAddDir) {
      dialog = { kind: 'addDir', path };
      out(`FAKE-CLAUDE CONFIRM Add directory to workspace ${path} ❯ 1. Yes, for this session`);
    } else {
      added(path);
    }
  }
}

function key(ch) {
  if (dialog) {
    if (ch === '\r' || ch === '1') answer(true);
    else if (ch === '3') answer(false);
    return;
  }
  if (ch === '\r') {
    if (line.endsWith('\\')) {
      line = `${line.slice(0, -1)}\n`;
      out(`FAKE-CLAUDE DRAFT ${JSON.stringify(line)}`);
    } else {
      submit();
    }
  } else if (ch === '\x7f' || ch === '\b') {
    line = line.slice(0, -1);
  } else if (ch === '\x03') {
    line = '';
    out('FAKE-CLAUDE CLEARED');
  } else if (ch !== '\n') {
    line += ch;
  }
}

let pasting = false;
let pasted = '';

function onEscape(seq) {
  if (seq === `${ESC}[200~`) {
    pasting = true;
    pasted = '';
  } else if (seq === `${ESC}[201~`) {
    pasting = false;
    if (dialog) {
      out('FAKE-CLAUDE PASTE-IGNORED');
    } else {
      line += pasted;
      out(`FAKE-CLAUDE DRAFT ${JSON.stringify(line)}`);
    }
  } else if (seq === `${ESC}[I` || seq === `${ESC}[O`) {
    write(`${ESC}[?2004h`);
  } else if (seq === ESC && dialog) {
    answer(false);
  }
}

let pending = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  let s = pending + chunk;
  pending = '';
  while (s.length > 0) {
    if (s[0] === ESC) {
      const m = CSI_SEQ.exec(s);
      if (m) {
        onEscape(m[0]);
        s = s.slice(m[0].length);
      } else if (s.length > 1 && s[1] === '[') {
        // A sequence split across chunks: wait for the rest.
        pending = s;
        s = '';
      } else {
        // A lone ESC is the Esc key.
        onEscape(ESC);
        s = s.slice(1);
      }
      continue;
    }
    const ch = s[0];
    s = s.slice(1);
    if (pasting) pasted += ch;
    else key(ch);
  }
});
// Never exits on its own: only a kill (restart / dispose / quit) or accepting `ask` ends it.
setInterval(() => {}, 1 << 30);
