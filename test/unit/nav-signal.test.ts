import { describe, expect, it } from 'vitest';
import { createNavSignal } from '../../webview/nav-signal';

const host = () => ({ dataset: {} as Record<string, string | undefined> });

describe('createNavSignal', () => {
  it('reports running, then the outcome and a bumped sequence', () => {
    const h = host();
    const s = createNavSignal(h);
    s.begin();
    expect(h.dataset.navState).toBe('running');
    s.end('none');
    expect(h.dataset).toMatchObject({ navSeq: '1', navState: 'none', navTarget: '' });
  });

  it('publishes the landing target and clears it for the next navigation', () => {
    const h = host();
    const s = createNavSignal(h);
    s.begin();
    s.landing('/p/a.ts', 3, 7);
    s.end('navigated');
    expect(h.dataset.navTarget).toBe('/p/a.ts:3:7');
    s.begin();
    s.end('none');
    expect(h.dataset.navTarget).toBe('');
    expect(h.dataset.navSeq).toBe('2');
  });

  it('stays running until the last overlapping navigation ends', () => {
    const h = host();
    const s = createNavSignal(h);
    s.begin();
    s.begin();
    s.end('cancelled');
    expect(h.dataset).toMatchObject({ navSeq: '1', navState: 'running' });
    s.end('navigated');
    expect(h.dataset).toMatchObject({ navSeq: '2', navState: 'navigated' });
  });

  it('is inert without a document', () => {
    const s = createNavSignal(null);
    s.begin();
    expect(() => s.end('none')).not.toThrow();
  });
});
