/**
 * auto-resume-long-multiline-message — spec 2026-11-13-scheduler-auto-resume §7, "Long
 * multi-paragraph message". A fake TUI with bracketed paste on (it echoes a paste slowly, in
 * parts) is sent a 6000-character, three-paragraph message through `timers.sendOnce`:
 *   - the CLI receives all 6000 characters inside ONE bracketed paste, "\n\n" breaks intact;
 *   - there is exactly one Enter, and it arrives after the echo of the paste has finished (and
 *     after the writer's output-quiet wait), not at the writer's first lull.
 */
import {
  autoResumeProfile,
  PASTE_END,
  PASTE_START,
  paneHas,
  waitForSubmits,
  workFolder,
} from './auto-resume-helpers.mjs';
import { assert, openSession, phase, runScenario } from './harness.mjs';

const profile = autoResumeProfile('auto-resume-long');
const { fake } = profile;

/** `n` characters that start with a word and end with a letter, so trimming leaves them whole. */
const paragraph = (label, n) =>
  `${label} ${'lorem ipsum dolor sit amet '.repeat(Math.ceil(n / 5))}`.slice(0, n - 1).concat('x');
const MESSAGE = [
  paragraph('First', 1998),
  paragraph('Second', 2000),
  paragraph('Third', 1998),
].join('\n\n');

await runScenario(
  'auto-resume-long-multiline-message',
  async ({ page, log }) => {
    assert(MESSAGE.length === 6000, `fixture is ${MESSAGE.length} characters`);
    const sid = await openSession(page, { path: workFolder(), agentId: profile.agentId });
    await fake.ready();
    // The server learns the paste mode from the PTY's output: once the window has the byte, it has.
    assert(
      await paneHas(page, sid, '\x1b[?2004h', 15_000),
      'the fake never turned bracketed paste on in the pane',
    );

    phase('send');
    await page.evaluate(
      ([id, message]) => window.agentDeck.post({ type: 'timer:sendOnce', sessionId: id, message }),
      [sid, MESSAGE],
    );
    const [submit] = await waitForSubmits(fake, 1, 45_000, 'the 6000-character message');

    phase('assert');
    const pastes = fake.pastes();
    assert(pastes.length === 1, `expected one bracketed paste, got ${pastes.length}`);
    assert(
      pastes[0].text.length === 6000 && pastes[0].text === MESSAGE,
      `the paste is not the message (${pastes[0].text.length} characters; line breaks: ${pastes[0].text.split('\n').length - 1} of ${MESSAGE.split('\n').length - 1})`,
    );
    const raw = fake.raw();
    assert(
      raw.includes(`${PASTE_START}${MESSAGE}${PASTE_END}`) && raw.split(PASTE_START).length === 2,
      'the bytes received are not exactly one bracketed paste of the message',
    );
    assert(submit.line === MESSAGE, 'the submitted draft is not the whole message');
    assert(raw.split('\r').length - 1 === 1, 'expected exactly one Enter');

    // Enter after the echo: the first chunk with a CR came after ECHO_DONE, by the writer's
    // 300 ms quiet wait (src/pty-writer.ts ECHO_QUIET_MS) less the slack of two clocks.
    const [echoDone] = fake.records('ECHO_DONE');
    const enter = fake.records('IN').find((r) => r.d.includes('\r'));
    assert(echoDone && enter, 'the echo or the Enter was never logged');
    assert(
      fake.records('ECHO_START')[0].t < echoDone.t - 100,
      'the echo was not slow enough to tell an early Enter from a late one',
    );
    assert(
      enter.t >= echoDone.t + 250,
      `Enter arrived ${enter.t - echoDone.t} ms after the echo finished; expected the writer's quiet wait`,
    );
    log('one 6000-character bracketed paste, line breaks intact, Enter after the echo ✓');
  },
  { userDataDir: profile.userDataDir, env: profile.env },
);
