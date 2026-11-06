import { describe, expect, it } from 'vitest';
import { createPtySizeSync, terminalFaceLoaded } from '../../webview/terminal-size';

function fakeTerm(cols: number, rows: number) {
  return {
    cols,
    rows,
    resize(nextCols: number, nextRows: number) {
      this.cols = nextCols;
      this.rows = nextRows;
    },
  };
}

function fakeHc() {
  const resizes: string[] = [];
  return {
    resize(cols: number, rows: number) {
      resizes.push(`${cols}x${rows}`);
    },
    resizes,
  };
}

describe('createPtySizeSync', () => {
  it('hc sees only sizes the xterm actually has after term.resize, not a pre-layout fallback fit', () => {
    const term = fakeTerm(80, 24);
    const hc = fakeHc();
    let faceLoaded = false;
    const sync = createPtySizeSync({
      term,
      faceLoaded: () => faceLoaded,
      report: (size) => hc.resize(size.cols, size.rows),
    });

    // Fallback-face fit (scrollback-inrun Reload 1: 27x29). Applied to xterm, not reportable.
    term.resize(27, 29);
    sync.afterFit();
    expect(hc.resizes).toEqual([]);
    expect(`${term.cols}x${term.rows}`).toBe('27x29');

    // Real face lands; xterm is resized to the pane's settled size, then reported.
    faceLoaded = true;
    term.resize(46, 29);
    sync.afterFontRefresh();
    expect(hc.resizes).toEqual(['46x29']);
    expect(
      hc.resizes.every((size) => size === `${term.cols}x${term.rows}` || size === '46x29'),
    ).toBe(true);

    term.resize(46, 20);
    sync.afterFit();
    expect(hc.resizes).toEqual(['46x29', '46x20']);
    expect(hc.resizes).not.toContain('27x29');
  });

  it('reports the xterm, never a proposed geometry that was not applied', () => {
    const term = fakeTerm(46, 29);
    const hc = fakeHc();
    const sync = createPtySizeSync({
      term,
      faceLoaded: () => true,
      report: (size) => hc.resize(size.cols, size.rows),
    });
    const proposed = { cols: 27, rows: 29 };
    sync.afterFit();
    expect(hc.resizes).toEqual(['46x29']);
    expect(hc.resizes).not.toContain(`${proposed.cols}x${proposed.rows}`);
  });

  it('a font refresh starts even when the face never loaded, so a failed load is not a hung pane', () => {
    const term = fakeTerm(27, 29);
    const hc = fakeHc();
    const sync = createPtySizeSync({
      term,
      faceLoaded: () => false,
      report: (size) => hc.resize(size.cols, size.rows),
    });
    sync.afterFit();
    expect(hc.resizes).toEqual([]);
    sync.afterFontRefresh();
    expect(hc.resizes).toEqual(['27x29']);
  });

  it('does not re-report an unchanged size', () => {
    const term = fakeTerm(46, 29);
    const hc = fakeHc();
    const sync = createPtySizeSync({
      term,
      faceLoaded: () => true,
      report: (size) => hc.resize(size.cols, size.rows),
    });
    sync.afterFit();
    sync.afterFit();
    expect(hc.resizes).toEqual(['46x29']);
  });

  it('does not start on fonts.ready until a fit has been applied', async () => {
    const term = fakeTerm(80, 24);
    const hc = fakeHc();
    const fontsReady = Promise.resolve();
    const sync = createPtySizeSync({
      term,
      faceLoaded: () => false,
      fontsReady,
      report: (size) => hc.resize(size.cols, size.rows),
    });
    await fontsReady;
    expect(hc.resizes).toEqual([]);
    term.resize(27, 29);
    sync.afterFit();
    expect(hc.resizes).toEqual(['27x29']);
  });

  it('starts after fonts.ready with the current size when the face never loads', async () => {
    const term = fakeTerm(27, 29);
    const hc = fakeHc();
    let resolveReady!: () => void;
    const fontsReady = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const sync = createPtySizeSync({
      term,
      faceLoaded: () => false,
      fontsReady,
      report: (size) => hc.resize(size.cols, size.rows),
    });
    term.resize(27, 29);
    sync.afterFit();
    expect(hc.resizes).toEqual([]);
    resolveReady();
    await fontsReady;
    expect(hc.resizes).toEqual(['27x29']);
  });

  it('starts when the face load fails', async () => {
    const term = fakeTerm(27, 29);
    const hc = fakeHc();
    let rejectLoad!: (err: Error) => void;
    const faceLoad = new Promise<void>((_, reject) => {
      rejectLoad = reject;
    });
    const sync = createPtySizeSync({
      term,
      faceLoaded: () => false,
      faceLoad,
      report: (size) => hc.resize(size.cols, size.rows),
    });
    term.resize(27, 29);
    sync.afterFit();
    expect(hc.resizes).toEqual([]);
    rejectLoad(new Error('font load failed'));
    await faceLoad.catch(() => {});
    expect(hc.resizes).toEqual(['27x29']);
  });

  it('starts on the first fit when there is no GPU path', () => {
    const term = fakeTerm(27, 29);
    const hc = fakeHc();
    const sync = createPtySizeSync({
      term,
      faceLoaded: () => false,
      gpu: false,
      report: (size) => hc.resize(size.cols, size.rows),
    });
    term.resize(27, 29);
    sync.afterFit();
    expect(hc.resizes).toEqual(['27x29']);
  });
});

describe('terminalFaceLoaded', () => {
  it('is true when no family or no FontFaceSet — nothing to wait for', () => {
    expect(terminalFaceLoaded(null, 13, undefined)).toBe(true);
    expect(terminalFaceLoaded('"IBM Plex Mono"', 13, undefined)).toBe(true);
  });

  it('holds while a registered face of the stack is still loading', () => {
    const fonts = {
      check: () => false,
      *[Symbol.iterator]() {
        yield { family: 'IBM Plex Mono', status: 'loading' };
      },
    };
    expect(terminalFaceLoaded('"IBM Plex Mono", ui-monospace', 13, fonts)).toBe(false);
  });

  it('is true when check says the family is already available (system font)', () => {
    const fonts = {
      check: () => true,
      *[Symbol.iterator]() {
        yield { family: 'Figtree', status: 'loaded' };
      },
    };
    expect(terminalFaceLoaded('"IBM Plex Mono"', 13, fonts)).toBe(true);
  });

  it('holds when the family is not available and no matching face is registered yet', () => {
    const fonts = {
      check: () => false,
      *[Symbol.iterator]() {
        yield { family: 'Figtree', status: 'loaded' };
      },
    };
    expect(terminalFaceLoaded('"IBM Plex Mono"', 13, fonts)).toBe(false);
  });

  it('is true once check says the face would not need to load', () => {
    const fonts = {
      check: (font: string) => font.includes('IBM Plex Mono'),
      *[Symbol.iterator]() {
        yield { family: 'IBM Plex Mono', status: 'loaded' };
      },
    };
    expect(terminalFaceLoaded('"IBM Plex Mono"', 13, fonts)).toBe(true);
  });

  it('is true once every matching face has settled, even if check is still false', () => {
    const fonts = {
      check: () => false,
      *[Symbol.iterator]() {
        yield { family: 'IBM Plex Mono', status: 'loaded' };
        yield { family: 'IBM Plex Mono', status: 'error' };
      },
    };
    expect(terminalFaceLoaded('"IBM Plex Mono"', 13, fonts)).toBe(true);
  });
});
