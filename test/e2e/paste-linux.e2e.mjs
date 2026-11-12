// End-to-end regression test for terminal paste on Linux: the clipboard routing behind Ctrl+V
// (pasteRoute in webview/terminal-clipboard.ts, used by pasteFromClipboard in
// webview/components/terminal-pane.tsx). The Windows path is paste.e2e.mjs.
//
// Three routes, each driven by a real Ctrl+V into a real shell reader:
//   text      → xterm paste(), bracketed when the program enabled DECSET 2004
//   image     → a raw 0x16 to the PTY, which is how Claude Code reads a clipboard image on Linux
//   empty     → nothing reaches the child
//
// The clipboard is set from the MAIN process (app.evaluate). Headless Ozone keeps its own
// in-process clipboard, so the user's desktop clipboard is never touched.
//
// Run locally:  npm run e2e -- paste-linux

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  defaultShellAgent,
  finishScenario,
  openSession,
  runScenario,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'linux') {
  console.log('[paste-linux] SKIP — Linux clipboard routing (Windows covered by paste.e2e.mjs)');
  await finishScenario(0);
}

// A 1x1 PNG: Electron only has to decode it, the pixels do not matter.
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const TEXT = 'hello-linux';
const BRACKET_OPEN = '\x1b[200~';
const BRACKET_CLOSE = '\x1b[201~';

const hex = (buf) => buf.toString('hex') || '(empty)';

await runScenario('paste-linux', async ({ app, page, log }) => {
  const work = mkdtempSync(join(tmpdir(), 'conduit-paste-linux-'));

  await page.evaluate(() => {
    window.__terms = {};
  });
  await tapBridge(page);
  const sid = await openSession(page, { path: work, agentId: defaultShellAgent() });
  await page.waitForFunction(() => window.__cap.length > 0, null, { timeout: 20000 });
  // The app may auto-open a sibling session; make this scenario's own session the active one so
  // the paste cannot land in it.
  await page.locator(`.session[data-sessionid="${sid}"]`).click();
  await page.waitForSelector(`.session--active[data-sessionid="${sid}"]`, { timeout: 5000 });
  await page.waitForFunction((id) => (window.__terms?.[id]?.element?.offsetWidth ?? 0) > 0, sid, {
    timeout: 20000,
  });

  // Runs one reader in the shell and returns the bytes it received. The reader puts the tty in
  // raw mode and reads exactly `bytes` bytes. READY is spelled RE"ADY" so the echo of the typed
  // command does not satisfy the wait, and likewise READ-"DONE". Both markers are only printed
  // once the reader is actually blocked on head (READY) or has finished (READ-DONE).
  const runReader = async (label, { bytes, bracketed = false, bounded = false }) => {
    const file = join(work, `${label}.bin`);
    const enable = bracketed ? `printf '\\e[?2004h'; ` : '';
    const disable = bracketed ? `printf '\\e[?2004l'; ` : '';
    // --foreground keeps head in the terminal's foreground group; without it a tty read from
    // the timeout child stops with SIGTTIN and the bound never fires.
    const head = bounded ? `timeout --foreground 3 head -c ${bytes}` : `head -c ${bytes}`;
    const command = `F="${file}"; ${enable}stty raw -echo; echo RE"ADY"; ${head} > "$F"; stty sane; ${disable}echo READ-"DONE"`;

    await page.evaluate(
      ({ s, c }) => {
        window.__capBy[s] = '';
        window.agentDeck.post({ type: 'term:input', sessionId: s, data: `${c}\r` });
      },
      { s: sid, c: command },
    );
    await page.waitForFunction((s) => (window.__capBy?.[s] ?? '').includes('READY'), sid, {
      timeout: 20000,
    });
    if (bracketed) {
      // The shell's printf has been written, but xterm parses it asynchronously. The paste is
      // only bracketed once this session's xterm has processed DECSET 2004.
      await page.waitForFunction(
        (id) => window.__terms?.[id]?.modes?.bracketedPasteMode === true,
        sid,
        { timeout: 20000 },
      );
    }

    await page.click(`.termhost[data-sessionid="${sid}"] .termpane`);
    await page.waitForFunction(
      (id) => !!document.activeElement?.closest(`.termhost[data-sessionid="${id}"] .xterm`),
      sid,
      { timeout: 5000 },
    );
    await page.keyboard.press('Control+V');

    await page.waitForFunction((s) => (window.__capBy?.[s] ?? '').includes('READ-DONE'), sid, {
      timeout: 30000,
    });
    return readFileSync(file);
  };

  // 1. Image only: no text, so the keystroke must reach the child as a raw Ctrl+V.
  const imageClip = await app.evaluate(({ clipboard, nativeImage }, url) => {
    clipboard.clear();
    clipboard.writeImage(nativeImage.createFromDataURL(url));
    return { image: !clipboard.readImage().isEmpty(), text: clipboard.readText() };
  }, PNG_1X1);
  assert(
    imageClip.image && imageClip.text === '',
    `PRECONDITION (clipboard): image-only clipboard was not set: ${JSON.stringify(imageClip)}`,
  );
  const imageBytes = await runReader('image', { bytes: 1 });
  log(`image only: received ${hex(imageBytes)}`);
  assert(
    imageBytes.equals(Buffer.from([0x16])),
    `image-only clipboard must send a raw Ctrl+V (0x16), got ${hex(imageBytes)}`,
  );

  // 2. Text: xterm paste(), bracketed because the reader enabled DECSET 2004 first.
  const textClip = await app.evaluate(({ clipboard }, t) => {
    clipboard.clear();
    clipboard.writeText(t);
    return clipboard.readText();
  }, TEXT);
  assert(textClip === TEXT, `PRECONDITION (clipboard): text clipboard read back "${textClip}"`);
  const wantText = Buffer.from(`${BRACKET_OPEN}${TEXT}${BRACKET_CLOSE}`);
  const textBytes = await runReader('text', { bytes: wantText.length, bracketed: true });
  log(`text: received ${hex(textBytes)}`);
  assert(
    textBytes.equals(wantText),
    `text paste must reach the child bracketed as ${hex(wantText)}, got ${hex(textBytes)}`,
  );

  // 3. Empty clipboard: nothing may reach the child. The reader is bounded so a stray byte or
  // a missing one cannot hang the scenario; READY is awaited before the keystroke.
  const emptyClip = await app.evaluate(({ clipboard }) => {
    clipboard.clear();
    return { text: clipboard.readText(), image: clipboard.readImage().isEmpty() };
  });
  assert(
    emptyClip.text === '' && emptyClip.image,
    `PRECONDITION (clipboard): clipboard was not cleared: ${JSON.stringify(emptyClip)}`,
  );
  const emptyBytes = await runReader('empty', { bytes: 1, bounded: true });
  log(`empty: received ${hex(emptyBytes)}`);
  assert(
    emptyBytes.length === 0,
    `empty clipboard must send nothing, but the child received ${hex(emptyBytes)}`,
  );

  log('PASS ✓ image → 0x16, text → bracketed, empty → nothing');
});
