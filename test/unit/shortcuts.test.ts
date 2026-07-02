import { describe, expect, it } from 'vitest';
import {
  comboFromEvent,
  effectiveCombo,
  type KeyEvt,
  matchCombo,
  SHORTCUT_ACTIONS,
} from '../../webview/shortcuts';

// In the node test env navigator is undefined, so Mod === ctrlKey.
const ev = (o: KeyEvt): KeyEvt => o;

describe('shortcuts', () => {
  it('captures combos from events', () => {
    expect(comboFromEvent(ev({ key: 'p', ctrlKey: true }))).toBe('Mod+P');
    expect(comboFromEvent(ev({ key: 'P', ctrlKey: true, shiftKey: true }))).toBe('Mod+Shift+P');
    expect(comboFromEvent(ev({ key: ',', ctrlKey: true }))).toBe('Mod+,');
    expect(comboFromEvent(ev({ key: 'k' }))).toBe('K'); // no mod
  });

  it('returns null for modifier-only keydowns', () => {
    expect(comboFromEvent(ev({ key: 'Control', ctrlKey: true }))).toBeNull();
    expect(comboFromEvent(ev({ key: 'Shift', shiftKey: true }))).toBeNull();
  });

  it('matches events against combos', () => {
    expect(matchCombo(ev({ key: 'p', ctrlKey: true }), 'Mod+P')).toBe(true);
    expect(matchCombo(ev({ key: 'p', ctrlKey: true, shiftKey: true }), 'Mod+P')).toBe(false);
    expect(matchCombo(ev({ key: 'P', ctrlKey: true, shiftKey: true }), 'Mod+Shift+P')).toBe(true);
    expect(matchCombo(ev({ key: ',', ctrlKey: true }), 'Mod+,')).toBe(true);
    expect(matchCombo(ev({ key: 'p' }), 'Mod+P')).toBe(false); // missing mod
  });

  it('resolves effective combos with overrides', () => {
    const a = SHORTCUT_ACTIONS[0];
    expect(effectiveCombo(a, {})).toBe(a.defaultCombo);
    expect(effectiveCombo(a, { [a.id]: 'Mod+K' })).toBe('Mod+K');
  });

  it('exposes a global Save action bound to Mod+S (K2)', () => {
    const save = SHORTCUT_ACTIONS.find((s) => s.id === 'save');
    expect(save).toBeDefined();
    expect(save?.defaultCombo).toBe('Mod+S');
    // It must actually MATCH a Ctrl+S keydown so a press anywhere routes to it.
    expect(matchCombo(ev({ key: 's', ctrlKey: true }), save?.defaultCombo ?? '')).toBe(true);
  });

  it('binds git history (Mod+Shift+G) and reopen-closed-tab (Mod+Shift+T)', () => {
    const hist = SHORTCUT_ACTIONS.find((s) => s.id === 'openGitHistory');
    expect(hist?.defaultCombo).toBe('Mod+Shift+G');
    expect(
      matchCombo(ev({ key: 'G', ctrlKey: true, shiftKey: true }), hist?.defaultCombo ?? ''),
    ).toBe(true);
    const reopen = SHORTCUT_ACTIONS.find((s) => s.id === 'reopenClosedTab');
    expect(reopen?.defaultCombo).toBe('Mod+Shift+T');
  });

  it('lists the hardcoded nav shortcuts as fixed (display-only) rows', () => {
    const fixed = SHORTCUT_ACTIONS.filter((s) => s.fixed);
    expect(fixed.map((s) => s.defaultCombo)).toEqual(
      expect.arrayContaining([
        'Ctrl+Tab',
        'Ctrl+Shift+Tab',
        'Ctrl+PageUp',
        'Ctrl+PageDown',
        'Ctrl+`',
      ]),
    );
    // Fixed rows carry no Mod token, so the rebindable matcher never claims them.
    expect(fixed.every((s) => !s.defaultCombo.includes('Mod'))).toBe(true);
  });
});
