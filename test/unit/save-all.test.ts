import { describe, expect, it, vi } from 'vitest';
import { registerSave, revertDocByPath, saveAllDirtyDocs } from '../../webview/save-registry';

describe('saveAllDirtyDocs', () => {
  it('calls save() on every path in the dirty set that has a registry entry', async () => {
    const saveA = vi.fn().mockResolvedValue(true);
    const saveB = vi.fn().mockResolvedValue(true);
    const offA = registerSave('/a.ts', { save: saveA });
    const offB = registerSave('/b.ts', { save: saveB });

    const failed = await saveAllDirtyDocs(new Set(['/a.ts', '/b.ts']));

    expect(saveA).toHaveBeenCalledOnce();
    expect(saveB).toHaveBeenCalledOnce();
    expect(failed).toEqual([]);

    offA();
    offB();
  });

  it('returns failed paths when save() resolves false', async () => {
    const saveOk = vi.fn().mockResolvedValue(true);
    const saveFail = vi.fn().mockResolvedValue(false);
    const offOk = registerSave('/ok.ts', { save: saveOk });
    const offFail = registerSave('/fail.ts', { save: saveFail });

    const failed = await saveAllDirtyDocs(new Set(['/ok.ts', '/fail.ts']));

    expect(failed).toContain('/fail.ts');
    expect(failed).not.toContain('/ok.ts');

    offOk();
    offFail();
  });

  it('silently skips paths with no registered entry', async () => {
    // No registration for /unregistered.ts — should not throw.
    const failed = await saveAllDirtyDocs(new Set(['/unregistered.ts']));
    expect(failed).toEqual([]);
  });

  it('returns an empty array when the dirty set is empty', async () => {
    const failed = await saveAllDirtyDocs(new Set());
    expect(failed).toEqual([]);
  });

  it('collects multiple failures', async () => {
    const off1 = registerSave('/f1.ts', { save: vi.fn().mockResolvedValue(false) });
    const off2 = registerSave('/f2.ts', { save: vi.fn().mockResolvedValue(false) });
    const off3 = registerSave('/f3.ts', { save: vi.fn().mockResolvedValue(true) });

    const failed = await saveAllDirtyDocs(new Set(['/f1.ts', '/f2.ts', '/f3.ts']));

    expect(failed).toHaveLength(2);
    expect(failed).toContain('/f1.ts');
    expect(failed).toContain('/f2.ts');
    expect(failed).not.toContain('/f3.ts');

    off1();
    off2();
    off3();
  });
});

describe('revertDocByPath', () => {
  it('calls revert() on the registered entry', () => {
    const revert = vi.fn();
    const off = registerSave('/rev.ts', { save: vi.fn().mockResolvedValue(true), revert });
    revertDocByPath('/rev.ts');
    expect(revert).toHaveBeenCalledOnce();
    off();
  });

  it('is a no-op when the entry has no revert', () => {
    const off = registerSave('/norev.ts', { save: vi.fn().mockResolvedValue(true) });
    // Should not throw.
    expect(() => revertDocByPath('/norev.ts')).not.toThrow();
    off();
  });

  it('is a no-op when there is no entry for the path', () => {
    expect(() => revertDocByPath('/missing.ts')).not.toThrow();
  });
});
