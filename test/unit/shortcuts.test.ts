import { describe, expect, it, vi } from 'vitest';
import {
  comboFromEvent,
  effectiveCombo,
  formatCombo,
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

  it('registers the built-in nav actions as ordinary rebindable Ctrl combos', () => {
    const byId = (id: string) => SHORTCUT_ACTIONS.find((s) => s.id === id);
    expect(byId('navNextTab')?.defaultCombo).toBe('Ctrl+Tab');
    expect(byId('navPrevTab')?.defaultCombo).toBe('Ctrl+Shift+Tab');
    expect(byId('navPrevTabPage')?.defaultCombo).toBe('Ctrl+PageUp');
    expect(byId('navNextTabPage')?.defaultCombo).toBe('Ctrl+PageDown');
    expect(byId('navFocusTerminal')?.defaultCombo).toBe('Ctrl+`');
    expect(byId('navGoToTab')?.defaultCombo).toBe('Ctrl+1…9');
    // `fixed` is gone — every action now flows through the matcher.
    expect(SHORTCUT_ACTIONS.some((s) => 'fixed' in s)).toBe(false);
  });

  it('matches the built-in nav combos via the literal Ctrl token', () => {
    expect(matchCombo(ev({ key: 'Tab', ctrlKey: true }), 'Ctrl+Tab')).toBe(true);
    expect(matchCombo(ev({ key: 'Tab', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Tab')).toBe(
      true,
    );
    expect(matchCombo(ev({ key: 'Tab', ctrlKey: true }), 'Ctrl+Shift+Tab')).toBe(false);
    expect(matchCombo(ev({ key: 'PageUp', ctrlKey: true }), 'Ctrl+PageUp')).toBe(true);
    expect(matchCombo(ev({ key: 'PageDown', ctrlKey: true }), 'Ctrl+PageDown')).toBe(true);
    expect(matchCombo(ev({ key: '`', ctrlKey: true }), 'Ctrl+`')).toBe(true);
    // Backquote normalizes via e.code regardless of the layout-dependent e.key.
    expect(matchCombo(ev({ key: 'Dead', code: 'Backquote', ctrlKey: true }), 'Ctrl+`')).toBe(true);
    expect(matchCombo(ev({ key: 'Tab' }), 'Ctrl+Tab')).toBe(false);
  });

  it('matches the Ctrl+1…9 digit family (1 and 9 match, 0 does not)', () => {
    expect(matchCombo(ev({ key: '1', ctrlKey: true }), 'Ctrl+1…9')).toBe(true);
    expect(matchCombo(ev({ key: '9', ctrlKey: true }), 'Ctrl+1…9')).toBe(true);
    expect(matchCombo(ev({ key: '0', ctrlKey: true }), 'Ctrl+1…9')).toBe(false);
    expect(matchCombo(ev({ key: '1' }), 'Ctrl+1…9')).toBe(false);
    expect(matchCombo(ev({ key: '1', ctrlKey: true, shiftKey: true }), 'Ctrl+1…9')).toBe(false);
  });

  it('records nav keys and normalizes the digit family to a rebindable prefix', () => {
    expect(comboFromEvent(ev({ key: 'Tab', ctrlKey: true }))).toBe('Mod+Tab');
    expect(comboFromEvent(ev({ key: 'Dead', code: 'Backquote', ctrlKey: true }))).toBe('Mod+`');
    expect(comboFromEvent(ev({ key: '1', ctrlKey: true }))).toBe('Mod+1…9');
    expect(comboFromEvent(ev({ key: '9', ctrlKey: true }))).toBe('Mod+1…9');
    expect(comboFromEvent(ev({ key: '0', ctrlKey: true }))).toBe('Mod+0');
    // A bare digit (no modifier) records literally, not as the family.
    expect(comboFromEvent(ev({ key: '1' }))).toBe('1');
  });

  it('formats combos readably', () => {
    expect(formatCombo('Ctrl+Tab')).toBe('Ctrl + Tab');
    expect(formatCombo('Ctrl+Shift+Tab')).toBe('Ctrl + Shift + Tab');
    expect(formatCombo('Ctrl+PageUp')).toBe('Ctrl + PageUp');
    expect(formatCombo('Ctrl+PageDown')).toBe('Ctrl + PageDown');
    expect(formatCombo('Ctrl+`')).toBe('Ctrl + `');
    expect(formatCombo('Ctrl+1…9')).toBe('Ctrl + 1…9');
  });

  it('distinguishes Mod (⌘) from literal Ctrl on macOS', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    const mac = await import('../../webview/shortcuts');
    // Mod is ⌘ (meta), never control.
    expect(mac.matchCombo({ key: 'p', metaKey: true }, 'Mod+P')).toBe(true);
    expect(mac.matchCombo({ key: 'p', ctrlKey: true }, 'Mod+P')).toBe(false);
    // Ctrl is control, never ⌘ — so Cmd+Tab (OS-reserved) does NOT trigger nav.
    expect(mac.matchCombo({ key: 'Tab', ctrlKey: true }, 'Ctrl+Tab')).toBe(true);
    expect(mac.matchCombo({ key: 'Tab', metaKey: true }, 'Ctrl+Tab')).toBe(false);
    // The recorder emits the two tokens distinctly.
    expect(mac.comboFromEvent({ key: 'p', metaKey: true })).toBe('Mod+P');
    expect(mac.comboFromEvent({ key: 'Tab', ctrlKey: true })).toBe('Ctrl+Tab');
    vi.unstubAllGlobals();
    vi.resetModules();
  });
});
