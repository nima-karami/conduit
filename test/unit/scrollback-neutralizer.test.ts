import { describe, expect, it } from 'vitest';
import { neutralizeReplay, REPLAY_MODE_NEUTRALIZER } from '../../src/scrollback-persistence';

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

  it('contains only CSI sequences (nothing that could print)', () => {
    expect(parts[0]).toBe('');
    expect(parts.slice(1).every((p) => /^\[\??[\d;]*[a-zA-Z]$/.test(p))).toBe(true);
  });
});

describe('neutralizeReplay', () => {
  it('appends the neutralizer so it wins over the replayed history', () => {
    const history = `${ESC}[?1003h${ESC}[?1006hsome output\r\n`;
    const out = neutralizeReplay(history);
    expect(out.startsWith(history)).toBe(true);
    expect(out).toBe(history + REPLAY_MODE_NEUTRALIZER);
  });

  it('is a no-op for empty history (nothing was replayed, nothing to cancel)', () => {
    expect(neutralizeReplay('')).toBe('');
  });
});
