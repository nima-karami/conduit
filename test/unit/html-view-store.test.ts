import { afterEach, describe, expect, it } from 'vitest';
import {
  bumpHtmlReload,
  clearHtmlView,
  getHtmlReload,
  getHtmlScroll,
  getHtmlView,
  setHtmlScroll,
  setHtmlView,
  subscribeHtmlView,
  toggleHtmlView,
} from '../../webview/html-view-store';

// The store is a module singleton, so every test names its own docs and drops them again.
const touched = new Set<string>();
const doc = (name: string) => {
  const id = `file:${name}.html`;
  touched.add(id);
  return id;
};

afterEach(() => {
  for (const id of touched) clearHtmlView(id);
  touched.clear();
});

describe('html view store', () => {
  it('an unset doc reports the fallback', () => {
    expect(getHtmlView(doc('unset-a'), 'preview')).toBe('preview');
    expect(getHtmlView(doc('unset-b'), 'source')).toBe('source');
  });

  it('toggle flips from the fallback and then from the stored value', () => {
    const id = doc('toggle');
    expect(toggleHtmlView(id, 'preview')).toBe('source');
    expect(getHtmlView(id, 'preview')).toBe('source');
    expect(toggleHtmlView(id, 'preview')).toBe('preview');
    expect(getHtmlView(id, 'source')).toBe('preview');
  });

  it('setting an unchanged value does not notify', () => {
    const id = doc('unchanged');
    let calls = 0;
    const off = subscribeHtmlView(() => {
      calls += 1;
    });
    setHtmlView(id, 'source');
    expect(calls).toBe(1);
    setHtmlView(id, 'source');
    expect(calls).toBe(1);
    setHtmlView(id, 'preview');
    expect(calls).toBe(2);
    off();
  });

  it('bumpHtmlReload increments per doc and notifies', () => {
    const a = doc('reload-a');
    const b = doc('reload-b');
    let calls = 0;
    const off = subscribeHtmlView(() => {
      calls += 1;
    });
    expect(getHtmlReload(a)).toBe(0);
    bumpHtmlReload(a);
    bumpHtmlReload(a);
    expect(getHtmlReload(a)).toBe(2);
    expect(getHtmlReload(b)).toBe(0);
    bumpHtmlReload(b);
    expect(getHtmlReload(b)).toBe(1);
    expect(getHtmlReload(a)).toBe(2);
    expect(calls).toBe(3);
    off();
  });

  it('scroll is remembered per doc and defaults to 0', () => {
    const a = doc('scroll-a');
    const b = doc('scroll-b');
    expect(getHtmlScroll(a)).toBe(0);
    setHtmlScroll(a, 420);
    expect(getHtmlScroll(a)).toBe(420);
    expect(getHtmlScroll(b)).toBe(0);
  });

  it('clearHtmlView drops view, reload nonce and scroll together', () => {
    const id = doc('clear');
    setHtmlView(id, 'source');
    bumpHtmlReload(id);
    setHtmlScroll(id, 120);
    clearHtmlView(id);
    expect(getHtmlView(id, 'preview')).toBe('preview');
    expect(getHtmlReload(id)).toBe(0);
    expect(getHtmlScroll(id)).toBe(0);
  });

  it('unsubscribe stops delivery', () => {
    const id = doc('unsub');
    let calls = 0;
    const off = subscribeHtmlView(() => {
      calls += 1;
    });
    setHtmlView(id, 'source');
    expect(calls).toBe(1);
    off();
    setHtmlView(id, 'preview');
    expect(calls).toBe(1);
  });
});
