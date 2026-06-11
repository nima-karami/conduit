import { describe, expect, it, vi } from 'vitest';
import {
  activeDocPath,
  getSaveEntry,
  notifySaved,
  onFileSaved,
  registerSave,
  saveActiveDoc,
} from '../../webview/save-registry';

describe('activeDocPath — routes the active tab to its file path', () => {
  const docs = [
    { id: 'file:/a.ts', path: '/a.ts' },
    { id: 'file:/b.ts', path: '/b.ts' },
  ];

  it('returns the path of the active doc', () => {
    expect(activeDocPath(docs, 'file:/b.ts')).toBe('/b.ts');
  });

  it('returns null when the Terminal tab is active (null id)', () => {
    expect(activeDocPath(docs, null)).toBe(null);
  });

  it('returns null when the active id matches no open doc', () => {
    expect(activeDocPath(docs, 'file:/gone.ts')).toBe(null);
  });

  it('returns null for an empty doc list', () => {
    expect(activeDocPath([], 'file:/a.ts')).toBe(null);
  });
});

describe('save-registry — register / unregister / lookup', () => {
  it('registers an entry under a path and looks it up', () => {
    const entry = { save: vi.fn() };
    const off = registerSave('/x.ts', entry);
    expect(getSaveEntry('/x.ts')).toBe(entry);
    off();
    expect(getSaveEntry('/x.ts')).toBeUndefined();
  });

  it('unregister only drops the entry it owns (no clobber on re-mount)', () => {
    const first = { save: vi.fn() };
    const off1 = registerSave('/y.ts', first);
    const second = { save: vi.fn() };
    registerSave('/y.ts', second); // a remount replaces the entry
    off1(); // the OLD unregister must not remove the NEW entry
    expect(getSaveEntry('/y.ts')).toBe(second);
  });

  it('replaces the entry when the same path registers again', () => {
    const first = { save: vi.fn() };
    registerSave('/z.ts', first);
    const second = { save: vi.fn() };
    registerSave('/z.ts', second);
    expect(getSaveEntry('/z.ts')).toBe(second);
  });
});

describe('saveActiveDoc — invokes the active doc’s registered save', () => {
  it('calls save() for the active doc’s path', () => {
    const save = vi.fn();
    registerSave('/active.ts', { save });
    const docs = [{ id: 'file:/active.ts', path: '/active.ts' }];
    saveActiveDoc(docs, 'file:/active.ts');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the Terminal tab is active', () => {
    const save = vi.fn();
    registerSave('/t.ts', { save });
    saveActiveDoc([{ id: 'file:/t.ts', path: '/t.ts' }], null);
    expect(save).not.toHaveBeenCalled();
  });

  it('is a no-op when the active doc has no registered entry', () => {
    const docs = [{ id: 'file:/unreg.ts', path: '/unreg.ts' }];
    // No registration for /unreg.ts -> must not throw, must do nothing.
    expect(() => saveActiveDoc(docs, 'file:/unreg.ts')).not.toThrow();
  });
});

describe('K3 — notifySaved / onFileSaved — saved-content notification channel', () => {
  it('calls a registered listener with the path and content', () => {
    const cb = vi.fn();
    const off = onFileSaved(cb);
    notifySaved('/foo.md', '# Hello');
    expect(cb).toHaveBeenCalledWith('/foo.md', '# Hello');
    off();
  });

  it('calls multiple listeners', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const off1 = onFileSaved(cb1);
    const off2 = onFileSaved(cb2);
    notifySaved('/bar.ts', 'const x = 1;');
    expect(cb1).toHaveBeenCalledWith('/bar.ts', 'const x = 1;');
    expect(cb2).toHaveBeenCalledWith('/bar.ts', 'const x = 1;');
    off1();
    off2();
  });

  it('does not call a listener after it is unsubscribed', () => {
    const cb = vi.fn();
    const off = onFileSaved(cb);
    off();
    notifySaved('/baz.md', '# After unsub');
    expect(cb).not.toHaveBeenCalled();
  });

  it('is a no-op when there are no listeners', () => {
    // Should not throw even with no subscribers.
    expect(() => notifySaved('/empty.ts', 'content')).not.toThrow();
  });

  it('each notifySaved call passes the exact content to listeners', () => {
    const received: Array<{ path: string; content: string }> = [];
    const off = onFileSaved((path, content) => received.push({ path, content }));
    notifySaved('/a.md', 'first');
    notifySaved('/b.md', 'second');
    expect(received).toEqual([
      { path: '/a.md', content: 'first' },
      { path: '/b.md', content: 'second' },
    ]);
    off();
  });
});
