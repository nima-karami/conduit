// A long-lived program for the three-process scenarios: it reports what reaches it through the
// terminal, so a scenario can assert the program's own view of keystrokes, pastes and its size.
// Launched as `node echo-probe.cjs --records <dir>`; every record is one JSON line appended to
// `<dir>/probe.jsonl` ({kind, pid, seq, size, …}) and also printed, short, for the pane:
//   PROBE-READY <size>            once at start (one per launch: a relaunch would print another)
//   PROBE-IN <json chunk> <size>  every stdin chunk, escaped, so ESC[200~ … ESC[201~ stay visible
//   PROBE-LINE <text>             every submitted line (Enter), without the brackets
//   PROBE-SIZE <size>             every resize the terminal reports
// Raw mode, so bracketed-paste markers and single keys arrive as sent; ESC[?2004h asks for them.
const { appendFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const at = process.argv.indexOf('--records');
const dir = at >= 0 ? process.argv[at + 1] : undefined;
if (dir) mkdirSync(dir, { recursive: true });
const file = dir ? join(dir, 'probe.jsonl') : undefined;

let seq = 0;
const size = () => `${process.stdout.columns}x${process.stdout.rows}`;
const record = (kind, payload, shown) => {
  seq += 1;
  const body = { kind, pid: process.pid, seq, size: size(), ...payload };
  if (file) appendFileSync(file, `${JSON.stringify(body)}\n`);
  process.stdout.write(`PROBE-${kind} ${shown}\r\n`);
};

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write('\x1b[?2004h');
record('READY', {}, size());
process.stdout.on('resize', () => record('SIZE', {}, size()));

const BRACKETS = new RegExp(`${String.fromCharCode(27)}\\[20[01]~`, 'g');
let line = '';
process.stdin.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  record('IN', { data: text }, `${JSON.stringify(text)} ${size()}`);
  for (const ch of text.replace(BRACKETS, '')) {
    if (ch === '\r' || ch === '\n') {
      if (line) record('LINE', { line }, line);
      line = '';
    } else if (ch === '\x03') {
      process.exit(130);
    } else line += ch;
  }
});
