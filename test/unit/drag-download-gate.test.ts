import { describe, expect, it } from 'vitest';
import { createDragDownloadGate, DRAG_DOWNLOAD_TTL_MS } from '../../src/drag-download-gate';

const W1 = 1;
const W2 = 2;

describe('createDragDownloadGate', () => {
  it('a fresh grant admits exactly one download of that file from that window', () => {
    const g = createDragDownloadGate({ caseInsensitive: false });
    g.arm(W1, '/w/home/a.txt', 1000);
    expect(g.claim(W1, '/w/home/a.txt', 1500)).toBe(true);
    expect(g.claim(W1, '/w/home/a.txt', 1600)).toBe(false);
  });

  it('nothing armed → refused', () => {
    const g = createDragDownloadGate({ caseInsensitive: false });
    expect(g.claim(W1, '/w/home/a.txt', 0)).toBe(false);
  });

  it('another window cannot spend the grant', () => {
    const g = createDragDownloadGate({ caseInsensitive: false });
    g.arm(W1, '/w/home/a.txt', 0);
    expect(g.claim(W2, '/w/home/a.txt', 1)).toBe(false);
    expect(g.claim(W1, '/w/home/a.txt', 2)).toBe(true);
  });

  it('another path is refused and leaves the grant for the real drop', () => {
    const g = createDragDownloadGate({ caseInsensitive: false });
    g.arm(W1, '/w/home/a.txt', 0);
    expect(g.claim(W1, '/w/home/b.txt', 1)).toBe(false);
    expect(g.claim(W1, '/w/home/a.txt', 2)).toBe(true);
  });

  it('a stale grant is refused', () => {
    const g = createDragDownloadGate({ caseInsensitive: false });
    g.arm(W1, '/w/home/a.txt', 0);
    expect(g.claim(W1, '/w/home/a.txt', DRAG_DOWNLOAD_TTL_MS + 1)).toBe(false);
  });

  it('a new drag replaces the window’s earlier grant', () => {
    const g = createDragDownloadGate({ caseInsensitive: false });
    g.arm(W1, '/w/home/a.txt', 0);
    g.arm(W1, '/w/home/b.txt', 1);
    expect(g.claim(W1, '/w/home/a.txt', 2)).toBe(false);
    expect(g.claim(W1, '/w/home/b.txt', 3)).toBe(true);
  });

  it('case folds only when the host filesystem does', () => {
    const insensitive = createDragDownloadGate({ caseInsensitive: true });
    insensitive.arm(W1, 'C:\\W\\A.txt', 0);
    expect(insensitive.claim(W1, 'c:\\w\\a.txt', 1)).toBe(true);
    const sensitive = createDragDownloadGate({ caseInsensitive: false });
    sensitive.arm(W1, '/w/A.txt', 0);
    expect(sensitive.claim(W1, '/w/a.txt', 1)).toBe(false);
  });
});
