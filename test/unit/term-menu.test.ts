import { describe, expect, it } from 'vitest';
import { buildTerminalMenuItems } from '../../webview/term-menu';

const ids = (ctx: Parameters<typeof buildTerminalMenuItems>[0]) =>
  buildTerminalMenuItems(ctx).map((i) => i.id);

describe('buildTerminalMenuItems', () => {
  it('keeps a stable, ordered item list', () => {
    expect(ids({ hasSelection: true, canPaste: true })).toEqual(['copy', 'paste', 'find', 'clear']);
  });

  it('disables Copy without a selection, enables it with one', () => {
    const copy = (sel: boolean) =>
      buildTerminalMenuItems({ hasSelection: sel, canPaste: true }).find((i) => i.id === 'copy');
    expect(copy(false)?.disabled).toBe(true);
    expect(copy(true)?.disabled).toBe(false);
  });

  it('disables Paste when the clipboard read API is unavailable', () => {
    const paste = (can: boolean) =>
      buildTerminalMenuItems({ hasSelection: false, canPaste: can }).find((i) => i.id === 'paste');
    expect(paste(false)?.disabled).toBe(true);
    expect(paste(true)?.disabled).toBe(false);
  });

  it('always offers Find and Clear regardless of selection/clipboard', () => {
    const list = buildTerminalMenuItems({ hasSelection: false, canPaste: false });
    const find = list.find((i) => i.id === 'find');
    const clear = list.find((i) => i.id === 'clear');
    expect(find?.disabled).toBeFalsy();
    expect(clear?.disabled).toBeFalsy();
  });

  it('wires each item to its action kind', () => {
    const list = buildTerminalMenuItems({ hasSelection: true, canPaste: true });
    const byId = (id: string) => list.find((i) => i.id === id)?.action;
    expect(byId('copy')).toBe('copy');
    expect(byId('paste')).toBe('paste');
    expect(byId('find')).toBe('find');
    expect(byId('clear')).toBe('clear');
  });

  it('groups the clipboard items apart from find/clear with a separator', () => {
    const list = buildTerminalMenuItems({ hasSelection: true, canPaste: true });
    const sep = (id: string) => list.find((i) => i.id === id)?.separatorBefore ?? false;
    expect(sep('copy')).toBe(false);
    expect(sep('paste')).toBe(false);
    expect(sep('find')).toBe(true);
    expect(sep('clear')).toBe(false);
  });

  it('is deterministic for a given context', () => {
    const ctx = { hasSelection: true, canPaste: false };
    expect(buildTerminalMenuItems(ctx)).toEqual(buildTerminalMenuItems(ctx));
  });
});
