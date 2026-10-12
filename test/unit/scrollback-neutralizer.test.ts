import { describe, expect, it } from 'vitest';
import { coldReplay, REPLAY_MODE_NEUTRALIZER } from '../../src/scrollback-persistence';

const ESC = '\x1b';
// Split rather than match: a regex literal carrying ESC trips lint/suspicious/noControlCharactersInRegex.
const parts = REPLAY_MODE_NEUTRALIZER.split(ESC);

describe('REPLAY_MODE_NEUTRALIZER', () => {
  it.each([1000, 1002, 1003, 1005, 1006, 1015, 1016])(
    'resets mouse mode %i (the bug: a replayed set survives into a fresh shell)',
    (mode) => {
      expect(REPLAY_MODE_NEUTRALIZER).toContain(`${ESC}[?${mode}l`);
    },
  );

  it.each([1004, 1049, 2004, 1])('resets private mode %i', (mode) => {
    expect(REPLAY_MODE_NEUTRALIZER).toContain(`${ESC}[?${mode}l`);
  });

  it('restores autowrap, clears the scroll region and resets SGR', () => {
    expect(REPLAY_MODE_NEUTRALIZER).toContain(`${ESC}[?7h`);
    expect(REPLAY_MODE_NEUTRALIZER).toContain(`${ESC}[r`);
    expect(REPLAY_MODE_NEUTRALIZER).toContain(`${ESC}[m`);
  });

  it('sets no private mode other than autowrap', () => {
    const sets = parts.map((p) => /^\[\?(\d+)h$/.exec(p)?.[1]).filter(Boolean);
    expect(sets).toEqual(['7']);
  });

  it('leaves the alternate screen before resetting the scroll region and SGR', () => {
    const altOff = REPLAY_MODE_NEUTRALIZER.indexOf(`${ESC}[?1049l`);
    expect(altOff).toBeGreaterThanOrEqual(0);
    expect(altOff).toBeLessThan(REPLAY_MODE_NEUTRALIZER.indexOf(`${ESC}[r`));
    expect(altOff).toBeLessThan(REPLAY_MODE_NEUTRALIZER.indexOf(`${ESC}[m`));
  });

  it('contains only CSI sequences inside a DECSC/DECRC frame (nothing that could print)', () => {
    expect(parts[0]).toBe('');
    expect(parts[1]).toBe('7');
    const restore = parts.indexOf('8');
    expect(restore).toBeGreaterThan(1);
    const csi = [...parts.slice(2, restore), ...parts.slice(restore + 1)];
    expect(csi.every((p) => /^\[\??[\d;]*[a-zA-Z]$/.test(p))).toBe(true);
  });

  it('restores the cursor after every cursor-moving reset, and resets SGR after the restore', () => {
    const restore = REPLAY_MODE_NEUTRALIZER.indexOf(`${ESC}8`);
    expect(restore).toBeGreaterThan(REPLAY_MODE_NEUTRALIZER.indexOf(`${ESC}[?1049l`));
    expect(restore).toBeGreaterThan(REPLAY_MODE_NEUTRALIZER.indexOf(`${ESC}[r`));
    expect(REPLAY_MODE_NEUTRALIZER.endsWith(`${ESC}8${ESC}[m`)).toBe(true);
  });
});

describe('coldReplay applies the neutralizer', () => {
  it('after the replayed history, so it wins over it, then ends on a fresh line', () => {
    const history = `${ESC}[?1003h${ESC}[?1006hsome output`;
    const { data, tail } = coldReplay([{ data: history }]);
    expect(data).toBe(`${history + REPLAY_MODE_NEUTRALIZER}\r\n`);
    expect(tail).toEqual({ data: `${REPLAY_MODE_NEUTRALIZER}\r\n` });
  });

  it('not at all for empty history (nothing was replayed, nothing to cancel)', () => {
    expect(coldReplay([])).toEqual({ data: '', runs: [] });
  });
});
