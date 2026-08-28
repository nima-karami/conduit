import { describe, expect, it } from 'vitest';
import { buildEditorMenuItems, NAVIGATION } from '../../webview/editor-menu';
import { navCommandKind } from '../../webview/nav-outcome';
import { SHORTCUT_ACTIONS } from '../../webview/shortcuts';
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

  // Monaco's BUILT-IN commands, not the old custom action: they navigate cross-file now that
  // the editor opener is registered, and `nav` routes them through the bounded runner.
  it('wires the navigation group to Monaco built-ins and disables it for non-TS', () => {
    const items = (ts: boolean) =>
      buildEditorMenuItems({ readOnly: true, hasSelection: false, canGoToDefinition: ts });
    const byId = (ts: boolean, id: string) => items(ts).find((i) => i.id === id);
    expect(byId(true, 'goToDefinition')?.action).toEqual({
      kind: 'nav',
      actionId: 'editor.action.revealDefinition',
    });
    expect(byId(true, 'goToTypeDefinition')?.action).toEqual({
      kind: 'nav',
      actionId: 'editor.action.goToTypeDefinition',
    });
    expect(byId(true, 'goToImplementations')?.action).toEqual({
      kind: 'nav',
      actionId: 'editor.action.goToImplementation',
    });
    expect(byId(true, 'goToReferences')?.action).toEqual({
      kind: 'nav',
      actionId: 'editor.action.goToReferences',
    });
    expect(byId(true, 'peekDefinition')?.action).toEqual({
      kind: 'nav',
      actionId: 'editor.action.peekDefinition',
    });
    expect(byId(true, 'findAllReferences')?.action).toEqual({
      kind: 'nav',
      actionId: 'editor.action.referenceSearch.trigger',
    });
    expect(byId(true, 'goToDefinition')?.disabled).toBe(false);
    for (const id of ['goToDefinition', 'goToTypeDefinition', 'goToImplementations'])
      expect(byId(false, id)?.disabled).toBe(true);
  });

  // No "Go to Source Definition": the bundled TS services expose no findSourceDefinition, and
  // nothing under node_modules is indexed for it to map back from.
  it('omits Go to Source Definition rather than aliasing it to Go to Definition', () => {
    expect(ids({ readOnly: true, hasSelection: true, canGoToDefinition: true })).not.toContain(
      'goToSourceDefinition',
    );
  });

  it('shows the VS Code accelerators on the navigation rows', () => {
    const list = buildEditorMenuItems({
      readOnly: true,
      hasSelection: true,
      canGoToDefinition: true,
    });
    const hint = (id: string) => list.find((i) => i.id === id)?.hint;
    expect(hint('goToDefinition')).toBe('F12');
    expect(hint('goToImplementations')).toBe('Ctrl+F12');
    expect(hint('goToReferences')).toBe('Shift+F12');
    expect(hint('peekDefinition')).toBe('Alt+F12');
    expect(hint('findAllReferences')).toBe('Shift+Alt+F12');
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
      'goToTypeDefinition',
      'goToImplementations',
      'goToReferences',
      'peekDefinition',
      'findAllReferences',
      'toggleGitBlame',
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
    // Within-group items carry no separator — the navigation rows are one group.
    expect(sep('goToTypeDefinition')).toBe(false);
    expect(sep('findAllReferences')).toBe(false);
    expect(sep('commandPalette')).toBe(false);
    expect(sep('toggleWordWrap')).toBe(false);
  });

  it('omits the change rows when the file has no changes', () => {
    const list = ids({ readOnly: false, hasSelection: false, canGoToDefinition: true });
    expect(list).not.toContain('nextChange');
    expect(list).not.toContain('prevChange');
  });

  it('offers next / previous change when the file has changes', () => {
    const list = ids({
      readOnly: false,
      hasSelection: false,
      canGoToDefinition: true,
      hasChanges: true,
    });
    expect(list).toEqual(expect.arrayContaining(['nextChange', 'prevChange']));
  });

  it('offers the peek row beside them — the keyboard path to a gutter-click-only widget', () => {
    const list = ids({
      readOnly: false,
      hasSelection: false,
      canGoToDefinition: true,
      hasChanges: true,
    });
    expect(list).toContain('peekChange');
  });

  it('hides the peek row on an unchanged file, like the rest of the group', () => {
    const list = ids({
      readOnly: false,
      hasSelection: false,
      canGoToDefinition: true,
      hasChanges: false,
    });
    expect(list).not.toContain('peekChange');
  });

  it('prints the VS Code accelerators on the change rows', () => {
    const items = buildEditorMenuItems({
      readOnly: false,
      hasSelection: false,
      canGoToDefinition: true,
      hasChanges: true,
    });
    expect(items.find((i) => i.id === 'nextChange')?.hint).toBe('Alt+F5');
    expect(items.find((i) => i.id === 'prevChange')?.hint).toBe('Shift+Alt+F5');
  });

  it('prints a REBOUND change combo, not the shipped one', () => {
    const items = buildEditorMenuItems({
      readOnly: false,
      hasSelection: false,
      canGoToDefinition: true,
      hasChanges: true,
      changeCombos: { next: 'Mod+F7', prev: 'Mod+Shift+F7' },
    });
    expect(items.find((i) => i.id === 'nextChange')?.hint).toBe('Mod+F7');
    expect(items.find((i) => i.id === 'prevChange')?.hint).toBe('Mod+Shift+F7');
  });

  it('falls back to the registry defaults when no live combo is supplied', () => {
    const nextChange = SHORTCUT_ACTIONS.find((a) => a.id === 'nextChange');
    const items = buildEditorMenuItems({
      readOnly: false,
      hasSelection: false,
      canGoToDefinition: true,
      hasChanges: true,
    });
    expect(items.find((i) => i.id === 'nextChange')?.hint).toBe(nextChange?.defaultCombo);
  });

  it('starts the change group with a separator', () => {
    const items = buildEditorMenuItems({
      readOnly: false,
      hasSelection: false,
      canGoToDefinition: true,
      hasChanges: true,
    });
    expect(items.find((i) => i.id === 'nextChange')?.separatorBefore).toBe(true);
  });
});

describe('navigation rows and the outcome classifier agree', () => {
  it('every navigation menu row maps to a classifiable command kind', () => {
    const unmapped = NAVIGATION.filter((n) => navCommandKind(n.actionId) === null);
    expect(unmapped.map((n) => n.actionId)).toEqual([]);
  });
});
