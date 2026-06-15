import { describe, expect, it } from 'vitest';
import { buildEditorMenuItems } from '../../webview/editor-menu';
import { expectCopyEnabledOnlyWithSelection, separatorBeforeOf } from '../helpers/menu';

const ids = (ctx: Parameters<typeof buildEditorMenuItems>[0]) =>
  buildEditorMenuItems(ctx).map((i) => i.id);

describe('buildEditorMenuItems', () => {
  it('omits Cut/Paste when the editor is read-only', () => {
    const list = ids({ readOnly: true, hasSelection: true, canGoToDefinition: true });
    expect(list).not.toContain('cut');
    expect(list).not.toContain('paste');
  });

  it('includes Cut/Paste when the editor is editable', () => {
    const list = ids({ readOnly: false, hasSelection: true, canGoToDefinition: true });
    expect(list).toContain('cut');
    expect(list).toContain('paste');
  });

  it('always offers the essential read-only actions', () => {
    const list = ids({ readOnly: true, hasSelection: false, canGoToDefinition: false });
    expect(list).toEqual(
      expect.arrayContaining([
        'copy',
        'goToDefinition',
        'find',
        'commandPalette',
        'selectAll',
        'toggleWordWrap',
      ]),
    );
  });

  it('disables Copy without a selection, enables it with one', () => {
    expectCopyEnabledOnlyWithSelection((sel) =>
      buildEditorMenuItems({ readOnly: true, hasSelection: sel, canGoToDefinition: true }).find(
        (i) => i.id === 'copy',
      ),
    );
  });

  it('wires Copy to the clipboard copy kind, not a Monaco action', () => {
    const copy = buildEditorMenuItems({
      readOnly: true,
      hasSelection: true,
      canGoToDefinition: true,
    }).find((i) => i.id === 'copy');
    expect(copy?.action).toEqual({ kind: 'copy' });
  });

  it('wires Go to Definition to the CUSTOM agentdeck action and disables it for non-TS', () => {
    const def = (ts: boolean) =>
      buildEditorMenuItems({ readOnly: true, hasSelection: false, canGoToDefinition: ts }).find(
        (i) => i.id === 'goToDefinition',
      );
    expect(def(true)?.action).toEqual({ kind: 'action', actionId: 'agentdeck.goToDefinition' });
    expect(def(true)?.disabled).toBe(false);
    expect(def(false)?.disabled).toBe(true);
  });

  it('wires search/palette/select-all/word-wrap to their Monaco action ids', () => {
    const list = buildEditorMenuItems({
      readOnly: true,
      hasSelection: true,
      canGoToDefinition: true,
    });
    const byId = (id: string) => list.find((i) => i.id === id)?.action;
    expect(byId('find')).toEqual({ kind: 'action', actionId: 'actions.find' });
    expect(byId('commandPalette')).toEqual({
      kind: 'action',
      actionId: 'editor.action.quickCommand',
    });
    expect(byId('selectAll')).toEqual({ kind: 'action', actionId: 'editor.action.selectAll' });
    expect(byId('toggleWordWrap')).toEqual({
      kind: 'action',
      actionId: 'agentdeck.toggleWordWrap',
    });
  });

  it('is deterministic for a given context', () => {
    const ctx = { readOnly: true, hasSelection: true, canGoToDefinition: true };
    expect(buildEditorMenuItems(ctx)).toEqual(buildEditorMenuItems(ctx));
  });

  it('keeps a stable, ordered read-only item list', () => {
    expect(ids({ readOnly: true, hasSelection: true, canGoToDefinition: true })).toEqual([
      'copy',
      'mention',
      'goToDefinition',
      'find',
      'commandPalette',
      'selectAll',
      'toggleWordWrap',
    ]);
  });

  it('groups items with separators (def / find / select-all start new groups)', () => {
    const list = buildEditorMenuItems({
      readOnly: true,
      hasSelection: true,
      canGoToDefinition: true,
    });
    const sep = separatorBeforeOf(list);
    expect(sep('copy')).toBe(false);
    expect(sep('goToDefinition')).toBe(true);
    expect(sep('find')).toBe(true);
    expect(sep('selectAll')).toBe(true);
    // Within-group items carry no separator.
    expect(sep('commandPalette')).toBe(false);
    expect(sep('toggleWordWrap')).toBe(false);
  });
});
