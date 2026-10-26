import { describe, expect, it } from 'vitest';
import { createSessionScreens } from '../../electron/session-screens';

describe('createSessionScreens', () => {
  it('feed then snapshot returns viewport lines and cursorY', async () => {
    const s = createSessionScreens();
    s.start('a', 40, 6);
    s.feed('a', 'a\r\nb\r\n\x1b[2J\x1b[Hidle❯ ');
    const snap = await s.snapshot('a');
    expect(snap?.lines[0]).toBe('idle❯');
    expect(snap?.cursorY).toBe(0);
    expect(snap?.lines).toHaveLength(6);
  });

  it('differential repaint (cursor moves + erase) is reflected', async () => {
    const s = createSessionScreens();
    s.start('a', 40, 6);
    s.feed('a', 'header\r\nAllow tool?\r\n❯ 1. Yes\r\n');
    // Repaint row 2 in place and clear row 3, the way a TUI redraws a menu away.
    s.feed('a', '\x1b[2;1H\x1b[2Kfake❯ \x1b[3;1H\x1b[2K\x1b[2;7H');
    const snap = await s.snapshot('a');
    expect(snap?.lines.slice(0, 3)).toEqual(['header', 'fake❯', '']);
    expect(snap?.cursorY).toBe(1);
  });

  it('cursor row styles mark faint (SGR 2) cells, aligned with the trimmed text', async () => {
    const s = createSessionScreens();
    s.start('a', 40, 3);
    s.feed('a', '❯ \x1b[2myes, go ahead\x1b[22m   \x1b[1;3H');
    const snap = await s.snapshot('a');
    expect(snap?.lines[0]).toBe('❯ yes, go ahead');
    expect(snap).toMatchObject({ cursorY: 0, cursorX: 2, cursorRowStyles: '..ddddddddddddd' });
  });

  it('a wide char takes one mask char per string char, not per cell', async () => {
    const s = createSessionScreens();
    s.start('a', 40, 3);
    s.feed('a', '\x1b[1m›\x1b[22m\x1b[2m Ask 世界\x1b[22m x');
    const snap = await s.snapshot('a');
    expect(snap?.lines[0]).toBe('› Ask 世界 x');
    expect(snap?.cursorRowStyles).toBe('.ddddddd..');
  });

  it('only the cursor row carries styles', async () => {
    const s = createSessionScreens();
    s.start('a', 40, 3);
    s.feed('a', '\x1b[2mfaint above\x1b[22m\r\n');
    const snap = await s.snapshot('a');
    expect(snap).toMatchObject({ cursorY: 1, cursorX: 0, cursorRowStyles: '' });
  });

  it('cursorY is viewport-relative after scrolling', async () => {
    const s = createSessionScreens({ scrollback: 100 });
    s.start('a', 20, 4);
    s.feed('a', Array.from({ length: 10 }, (_, i) => `line${i}`).join('\r\n'));
    const snap = await s.snapshot('a');
    expect(snap?.lines).toEqual(['line6', 'line7', 'line8', 'line9']);
    expect(snap?.cursorY).toBe(3);
  });

  it('resize keeps the model at the new size', async () => {
    const s = createSessionScreens();
    s.start('a', 20, 4);
    s.resize('a', 30, 8);
    s.feed('a', 'x');
    const snap = await s.snapshot('a');
    expect(snap?.lines).toHaveLength(8);
  });

  it('start twice disposes the first', async () => {
    const s = createSessionScreens();
    s.start('a', 20, 4);
    s.feed('a', 'old text');
    s.start('a', 20, 4);
    const snap = await s.snapshot('a');
    expect(snap?.lines.join('')).toBe('');
    expect(snap?.cursorY).toBe(0);
  });

  // Settled before a timer tick: a disposed model must not hold the caller while xterm parses its
  // dead backlog (or never calls back at all).
  const settles = (p: Promise<unknown>) =>
    Promise.race([p.then(() => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 0))]);

  it('a snapshot pending at dispose resolves undefined', async () => {
    const s = createSessionScreens();
    s.start('a', 40, 6);
    s.feed('a', 'x'.repeat(2_000_000));
    const snap = s.snapshot('a');
    s.dispose('a');
    expect(await settles(snap)).toBe('settled');
    expect(await snap).toBeUndefined();
  });

  it('a snapshot pending when start replaces the model resolves undefined', async () => {
    const s = createSessionScreens();
    s.start('a', 40, 6);
    s.feed('a', 'x'.repeat(2_000_000));
    const snap = s.snapshot('a');
    s.start('a', 40, 6);
    expect(await settles(snap)).toBe('settled');
    expect(await snap).toBeUndefined();
  });

  it('snapshot of an unknown session → undefined', async () => {
    const s = createSessionScreens();
    expect(await s.snapshot('nope')).toBeUndefined();
    expect(s.has('nope')).toBe(false);
    s.feed('nope', 'ignored');
    s.resize('nope', 10, 10);
    expect(s.has('nope')).toBe(false);
  });

  it('dispose drops the model', async () => {
    const s = createSessionScreens();
    s.start('a', 20, 4);
    expect(s.has('a')).toBe(true);
    s.dispose('a');
    expect(s.has('a')).toBe(false);
    expect(await s.snapshot('a')).toBeUndefined();
  });

  it('alt screen content is what snapshot reads while active', async () => {
    const s = createSessionScreens();
    s.start('a', 20, 4);
    s.feed('a', 'normal');
    s.feed('a', '\x1b[?1049h\x1b[Halt view');
    expect((await s.snapshot('a'))?.lines[0]).toBe('alt view');
    s.feed('a', '\x1b[?1049l');
    expect((await s.snapshot('a'))?.lines[0]).toBe('normal');
  });
});
