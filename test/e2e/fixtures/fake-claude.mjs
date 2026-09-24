// The agent mf-live-edits.e2e.mjs spawns through a `claude.cmd`, so the claude adapter (matched by
// basename) passes it --add-dir. Every record ends in " <<END>>": ConPTY wraps and repaints, and
// the scenario reads output with the line breaks stripped. LAUNCH carries a per-process nonce, so a
// repaint or a replayed scrollback can never pass for a new spawn.
const nonce = `${process.pid}-${Date.now()}`;
const out = (line) => process.stdout.write(`${line} <<END>>\r\n`);

out(`FAKE-CLAUDE LAUNCH ${nonce}`);
out(`FAKE-CLAUDE ARGS ${JSON.stringify(process.argv.slice(2))}`);
out(`FAKE-CLAUDE CWD ${process.cwd()}`);

let line = '';
let streaming = null;

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

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const ch of chunk) {
    if (ch === '\r' || ch === '\n') {
      if (line === '' && ch === '\n') continue;
      out(`FAKE-CLAUDE GOT ${line}`);
      if (line === 'work') work();
      line = '';
    } else {
      line += ch;
    }
  }
});
// Never exits on its own: only a kill (restart / dispose / quit) ends it.
setInterval(() => {}, 1 << 30);
