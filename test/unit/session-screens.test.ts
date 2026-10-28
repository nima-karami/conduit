import { describe, expect, it } from 'vitest';
import { createSessionScreens, SCREEN_TAIL_BYTES } from '../../electron/session-screens';

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

  describe('output tail (spec §2.4 D6: a lazy model is seeded from the last 64 KiB)', () => {
    it('a model started after keepTail replays the output fed before it', async () => {
      const s = createSessionScreens();
      s.keepTail('a', 20, 4);
      s.feed('a', 'hello\r\n\x1b[1;3Hy');
      expect(s.has('a')).toBe(false);
      s.start('a', 20, 4);
      s.feed('a', '!');
      const snap = await s.snapshot('a');
      expect(snap?.lines.slice(0, 2)).toEqual(['hey!o', '']);
    });

    it('is 64 KiB by default', () => {
      expect(SCREEN_TAIL_BYTES).toBe(64 * 1024);
    });

    it('keeps only the last tailBytes, counted in UTF-8 bytes', async () => {
      const s = createSessionScreens({ tailBytes: 8 });
      s.keepTail('a', 20, 3);
      s.feed('a', 'x\ny\n');
      s.feed('a', 'z€€');
      s.start('a', 20, 3);
      // 11 bytes, so the last 8 are `\nz€€`; counted in UTF-16 units nothing would be cut.
      expect((await s.snapshot('a'))?.lines[0]).toBe('z€€');
    });

    it('the ring keeps stream order across many wraps, a character straddling the wrap included', async () => {
      const s = createSessionScreens({ tailBytes: 12 });
      s.keepTail('a', 20, 2);
      for (const ch of 'abcdefghijklmnopq\nrstu') s.feed('a', ch);
      s.feed('a', 'v€w');
      s.start('a', 20, 2);
      expect((await s.snapshot('a'))?.lines[0]).toBe('rstuv€w');
    });

    it('a single chunk over the cap keeps its own last bytes', async () => {
      const s = createSessionScreens({ tailBytes: 4 });
      s.keepTail('a', 20, 2);
      s.feed('a', 'abcd\nfgh');
      s.start('a', 20, 2);
      expect((await s.snapshot('a'))?.lines[0]).toBe('fgh');
    });

    // Review S3: a cut lands mid-character or mid-sequence; replaying from there prints U+FFFD
    // cells or a sequence's parameters as text.
    it('a cut tail starts after its first newline: no half character is replayed', async () => {
      const s = createSessionScreens({ tailBytes: 8 });
      s.keepTail('a', 20, 3);
      s.feed('a', 'xx€yz\nok');
      s.start('a', 20, 3);
      const snap = await s.snapshot('a');
      expect(snap?.lines.join('|')).not.toContain('�');
      expect(snap?.lines[0]).toBe('ok');
    });

    it('a cut tail with no newline starts at its first ESC: no half sequence is replayed', async () => {
      const s = createSessionScreens({ tailBytes: 13 });
      s.keepTail('a', 20, 3);
      s.feed('a', '\x1b[5;10Hab\x1b[2;3Hok');
      s.start('a', 20, 3);
      expect((await s.snapshot('a'))?.lines).toEqual(['', '  ok', '']);
    });

    it('an uncut tail replays from its first byte', async () => {
      const s = createSessionScreens({ tailBytes: 8 });
      s.keepTail('a', 20, 3);
      s.feed('a', 'ab\ncd');
      s.start('a', 20, 3);
      expect((await s.snapshot('a'))?.lines.slice(0, 2)).toEqual(['ab', '  cd']);
    });

    it('output is not kept for a session without keepTail', async () => {
      const s = createSessionScreens();
      s.feed('a', 'before');
      s.start('a', 20, 2);
      expect((await s.snapshot('a'))?.lines[0]).toBe('');
    });

    it('dispose drops the tail, and keepTail starts a new one empty', async () => {
      const s = createSessionScreens();
      s.keepTail('a', 20, 2);
      s.feed('a', 'old generation');
      s.dispose('a');
      s.start('a', 20, 2);
      expect((await s.snapshot('a'))?.lines[0]).toBe('');
      s.keepTail('b', 20, 2);
      s.feed('b', 'old generation');
      s.keepTail('b', 20, 2);
      s.feed('b', 'new');
      s.start('b', 20, 2);
      expect((await s.snapshot('b'))?.lines[0]).toBe('new');
    });

    it('a resize while the tail is kept replays at its place: the screen of a model that lived through it (review S2)', async () => {
      const before = '\x1b[3;100HA';
      const after = '\x1b[1;100HB\x1b[2;1Hdone';
      const ref = createSessionScreens();
      ref.start('r', 80, 5);
      ref.feed('r', before);
      await ref.snapshot('r');
      ref.resize('r', 120, 6);
      ref.feed('r', after);
      const want = await ref.snapshot('r');
      expect(want?.lines[2]).toBe(`${' '.repeat(79)}A`);

      const s = createSessionScreens();
      s.keepTail('a', 80, 5);
      s.feed('a', before);
      s.resize('a', 120, 6);
      s.feed('a', after);
      s.start('a', 120, 6);
      expect(await s.snapshot('a')).toEqual(want);
    });

    it('a resize that fell out of the window still sets the size the kept bytes replay at', async () => {
      const s = createSessionScreens({ tailBytes: 32 });
      s.keepTail('a', 80, 4);
      s.feed('a', 'old\r\n');
      s.resize('a', 120, 4);
      s.feed('a', `${'z'.repeat(30)}\n\x1b[2;100HA`);
      s.start('a', 120, 4);
      expect((await s.snapshot('a'))?.lines[1]).toBe(`${' '.repeat(99)}A`);
    });

    // Review F1: the seed's last step must apply the size the session has when it runs.
    it('a resize before the seed is parsed is the size the model ends at', async () => {
      const s = createSessionScreens();
      s.keepTail('a', 100, 6);
      s.feed('a', 'seed\r\n');
      s.start('a', 100, 6);
      s.resize('a', 50, 3);
      s.feed('a', 'x'.repeat(60));
      const snap = await s.snapshot('a');
      expect(snap?.lines).toHaveLength(3);
      expect(snap?.lines[1]).toBe('x'.repeat(50));
    });

    it('the tail is replayed once: a later start does not replay it again', async () => {
      const s = createSessionScreens();
      s.keepTail('a', 20, 2);
      s.feed('a', 'seed');
      s.start('a', 20, 2);
      s.start('a', 20, 2);
      expect((await s.snapshot('a'))?.lines[0]).toBe('');
    });
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
