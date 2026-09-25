// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installOsDropSeam } from '../../webview/os-drop-seam';

afterEach(() => {
  delete window.__conduitOsDrop;
});

describe('installOsDropSeam', () => {
  it('enabled → window.__conduitOsDrop is the handler; uninstall deletes it', async () => {
    const handler = vi.fn(async () => {});
    const uninstall = installOsDropSeam(true, handler);
    expect(typeof window.__conduitOsDrop).toBe('function');
    const input = { items: [{ path: '/x/a', isDir: true }], targetDir: '/w', x: 1, y: 2 };
    await window.__conduitOsDrop?.(input);
    expect(handler).toHaveBeenCalledWith(input);
    uninstall();
    expect('__conduitOsDrop' in window).toBe(false);
  });

  it('disabled → never defined', () => {
    const uninstall = installOsDropSeam(false, async () => {});
    expect('__conduitOsDrop' in window).toBe(false);
    uninstall();
    expect('__conduitOsDrop' in window).toBe(false);
  });
});
