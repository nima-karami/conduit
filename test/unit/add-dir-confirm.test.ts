import { describe, expect, it } from 'vitest';
import {
  ADD_DIR_SCAN_START,
  type AddDirScanState,
  scanAddDirOutput,
} from '../../src/add-dir-confirm';

// Verbatim PTY bytes from claude 2.1.282 (mf-live-edits fix1 probe, 100/120 columns).
const BASE =
  'C:\\Users\\karam\\AppData\\Local\\Temp\\claude-scratch\\mf-live-edits-qa\\work-real-1IglbQ';
const SPACE = `${BASE}\\R with space`;
const ADDED = `⎿  \u001b[mAdded\u001b[1m\u001b[1C${BASE}\\R with\u001b[22m     \u001b[1mspace\u001b[22m as a working directory for this session \u001b[2m· /permissions to manage\u001b[22m\u001b[K\u001b[13;3H\u001b[K\u001b[38;2;136;136;136m\r\n────────────────────`;
const ALREADY = `  ⎿  \u001b[m\u001b[1m${SPACE}\u001b[22m     is already added as a working directory.\u001b[K\r\n\u001b[K\r\n`;
const INSIDE = `  ⎿  \u001b[m\u001b[1m${BASE}\\T home\\sub\u001b[22m\r\n     is inside the current working directory\u001b[K\r\n  \u001b[1m`;
const NOT_FOUND = `⎿  \u001b[mPath \u001b[1m${BASE}\\does \u001b[22m  \r\n     \u001b[1mnot exist\u001b[22m was not found.\u001b[K\r\n\u001b[K\r\n`;
const DID_NOT = `⎿  \u001b[mDid\u001b[1Cnot\u001b[1Cadd\u001b[1m\u001b[1C${SPACE}\u001b[22m\u001b[1Cas\u001b[1Ca\r\n     working directory.\u001b[K\u001b[12;3H\u001b[K\u001b[38;2;136;136;136m\r\n───`;
const ROOT_DID_NOT = `⎿  \u001b[mDid\u001b[1Cnot\u001b[1Cadd\u001b[1m\u001b[1CC:\\\u001b[22m\u001b[1Cas\u001b[1Ca\u001b[1Cworking\u001b[1Cdirectory.\r\n\u001b[K`;
// The draft claude echoes while the pasted command waits for Enter.
const DRAFT = `\u001b[?25l\u001b[38;2;177;185;249m/add-dir\u001b[m\u001b[1C${SPACE}\u001b[?25h`;

const scan = (chunks: string[], paths: string[], from: AddDirScanState = ADD_DIR_SCAN_START) => {
  let state = from;
  const all: Array<{ path: string; outcome: string }> = [];
  for (const c of chunks) {
    const r = scanAddDirOutput(state, c, paths);
    state = r.state;
    all.push(...r.matches);
  }
  return { state, all };
};

describe('scanAddDirOutput (mf-live-edits §2.3, measured claude 2.1.282 lines)', () => {
  it('"Added … as a working directory", ANSI-coloured and wrapped inside the path → added', () => {
    expect(scan([ADDED], [SPACE]).all).toEqual([{ path: SPACE, outcome: 'added' }]);
  });

  it('"is already added" and "is inside the current working directory" → added', () => {
    expect(scan([ALREADY], [SPACE]).all).toEqual([{ path: SPACE, outcome: 'added' }]);
    const sub = `${BASE}\\T home\\sub`;
    expect(scan([INSIDE], [sub]).all).toEqual([{ path: sub, outcome: 'added' }]);
  });

  it('"Did not add" (Esc at claude\'s confirm) and "Path … was not found" → declined', () => {
    expect(scan([DID_NOT], [SPACE]).all).toEqual([{ path: SPACE, outcome: 'declined' }]);
    const gone = `${BASE}\\does not exist`;
    expect(scan([NOT_FOUND], [gone]).all).toEqual([{ path: gone, outcome: 'declined' }]);
  });

  it('a drive root, typed as C:/ and printed as C:\\, matches the session path C:\\', () => {
    expect(scan([ROOT_DID_NOT], ['C:\\']).all).toEqual([{ path: 'C:\\', outcome: 'declined' }]);
  });

  it('the echoed draft is not a confirmation', () => {
    expect(scan([DRAFT], [SPACE]).all).toEqual([]);
  });

  it('matches whichever chunk boundary splits the line — inside an escape or a word', () => {
    for (let i = 1; i < ADDED.length; i++) {
      const r = scan([ADDED.slice(0, i), ADDED.slice(i)], [SPACE]);
      expect(r.all, `split at ${i}`).toEqual([{ path: SPACE, outcome: 'added' }]);
    }
  });

  it('a drive path matches case-blind; the session may hold a lower-case drive letter', () => {
    const lower = `c${SPACE.slice(1)}`.replace('Users', 'users');
    expect(scan([ADDED], [lower]).all).toEqual([{ path: lower, outcome: 'added' }]);
  });

  it('a posix path must match its own case', () => {
    const line = 'Added /home/u/Proj as a working directory for this session';
    expect(scan([line], ['/home/u/Proj']).all).toEqual([
      { path: '/home/u/Proj', outcome: 'added' },
    ]);
    expect(scan([line], ['/home/u/proj']).all).toEqual([]);
  });

  it('a folder whose path is a prefix of the confirmed one is not confirmed', () => {
    expect(scan([ADDED], [`${BASE}\\R`, SPACE]).all).toEqual([{ path: SPACE, outcome: 'added' }]);
  });

  it('reports a match once; later output does not re-report it from the carry', () => {
    const first = scan([ADDED], [SPACE]);
    expect(scan(['\r\n❯ '], [SPACE], first.state).all).toEqual([]);
  });

  it('the last outcome wins: declined, then added on a retry', () => {
    expect(scan([DID_NOT + ADDED], [SPACE]).all).toEqual([{ path: SPACE, outcome: 'added' }]);
    expect(scan([ADDED + DID_NOT], [SPACE]).all).toEqual([{ path: SPACE, outcome: 'declined' }]);
  });

  it('keeps a bounded carry under a firehose with no match', () => {
    const r = scan(
      Array.from({ length: 200 }, () => 'x'.repeat(500)),
      [SPACE],
    );
    expect(r.state.text.length).toBeLessThanOrEqual(1024);
  });

  it('a path claude never names → nothing', () => {
    expect(scan([ADDED], [`${BASE}\\R2`]).all).toEqual([]);
  });
});
