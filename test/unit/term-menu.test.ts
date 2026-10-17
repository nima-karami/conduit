import { describe, expect, it } from 'vitest';
import { pickerHeading } from '../../webview/components/path-candidate-picker-model';
import { buildLinkMenuItems, buildTerminalMenuItems } from '../../webview/term-menu';
import { expectCopyEnabledOnlyWithSelection, separatorBeforeOf } from '../helpers/menu';

const ids = (ctx: Parameters<typeof buildTerminalMenuItems>[0]) =>
  buildTerminalMenuItems(ctx).map((i) => i.id);

describe('buildTerminalMenuItems', () => {
  it('keeps a stable, ordered item list', () => {
    expect(ids({ hasSelection: true, canPaste: true })).toEqual(['copy', 'paste', 'find', 'clear']);
  });

  it('disables Copy without a selection, enables it with one', () => {
    expectCopyEnabledOnlyWithSelection((sel) =>
      buildTerminalMenuItems({ hasSelection: sel, canPaste: true }).find((i) => i.id === 'copy'),
    );
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
    const sep = separatorBeforeOf(list);
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

// Plan 2026-10-16-terminal-path-links T5.1: the link actions prepended on a path link.
describe('buildLinkMenuItems', () => {
  const shape = (ctx: Parameters<typeof buildLinkMenuItems>[0]) =>
    buildLinkMenuItems(ctx).map((i) => [i.id, i.separatorBefore === true, i.hint ?? null]);

  it('file link', () => {
    expect(shape({ target: 'file', matchCount: 1, openAsSessionHint: 'in Proj' })).toEqual([
      ['open', false, null],
      ['copyPath', true, null],
      ['copyRelativePath', false, null],
      ['reveal', false, null],
      ['openAsSession', true, 'in Proj'],
    ]);
  });

  it('file link with 3 matches adds Show all matches', () => {
    expect(buildLinkMenuItems({ target: 'file', matchCount: 3 }).map((i) => i.id)).toEqual([
      'open',
      'showAll',
      'copyPath',
      'copyRelativePath',
      'reveal',
      'openAsSession',
    ]);
  });

  it('dir link single: no primary, no separator before Copy path', () => {
    expect(shape({ target: 'dir', matchCount: 1 })).toEqual([
      ['copyPath', false, null],
      ['copyRelativePath', false, null],
      ['reveal', false, null],
      ['openAsSession', true, null],
    ]);
  });

  it('ambiguous: Show all matches, then every action hinted with the count', () => {
    expect(shape({ target: null, matchCount: 3, openAsSessionHint: 'in Proj' })).toEqual([
      ['showAll', false, null],
      ['copyPath', true, '3 matches'],
      ['copyRelativePath', false, '3 matches'],
      ['reveal', false, '3 matches'],
      ['openAsSession', true, '3 matches'],
    ]);
  });

  it('labels come from the shared strings', () => {
    const labels = buildLinkMenuItems({ target: 'file', matchCount: 2 }).map((i) => i.label);
    expect(labels).toEqual([
      'Open',
      'Show all matches',
      'Copy path',
      'Copy relative path',
      'Reveal in Explorer',
      'Open as new session',
    ]);
  });

  it('an action picker heading names the action', () => {
    expect(pickerHeading('x', 3, 'copyPath')).toBe('Copy path — pick a match');
  });
});
