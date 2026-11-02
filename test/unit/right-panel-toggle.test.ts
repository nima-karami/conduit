import { describe, expect, it } from 'vitest';
import { rightPanelTransition } from '../../src/right-panel-toggle';

describe('rightPanelTransition (sidebar-agent-tree spec §7)', () => {
  it('a pressed toggle click closes the panel and persists nothing', () => {
    expect(
      rightPanelTransition(
        { open: true, view: 'changes', remembered: 'changes' },
        { kind: 'toggle', view: 'changes' },
      ),
    ).toEqual({ open: false, view: 'changes', persist: null, userToggled: true });
  });

  it('an inactive toggle click on an open panel switches and persists the pick', () => {
    expect(
      rightPanelTransition(
        { open: true, view: 'files', remembered: 'files' },
        { kind: 'toggle', view: 'messages' },
      ),
    ).toEqual({ open: true, view: 'messages', persist: 'messages', userToggled: false });
  });

  it('a toggle click on a closed panel opens it, even on the current view', () => {
    expect(
      rightPanelTransition(
        { open: false, view: 'files', remembered: 'files' },
        { kind: 'toggle', view: 'files' },
      ),
    ).toEqual({ open: true, view: 'files', persist: null, userToggled: true });
    expect(
      rightPanelTransition(
        { open: false, view: 'files', remembered: 'files' },
        { kind: 'toggle', view: 'changes' },
      ),
    ).toEqual({ open: true, view: 'changes', persist: 'changes', userToggled: true });
  });

  it('an explicit open without remember does not persist', () => {
    expect(
      rightPanelTransition(
        { open: false, view: 'files', remembered: 'files' },
        { kind: 'open', view: 'changes', remember: false },
      ),
    ).toEqual({ open: true, view: 'changes', persist: null, userToggled: true });
  });

  it('an imperative open switches the view without persisting or counting as a user toggle', () => {
    expect(
      rightPanelTransition(
        { open: false, view: 'changes', remembered: 'changes' },
        { kind: 'imperative', view: 'files', open: true },
      ),
    ).toEqual({ open: true, view: 'files', persist: null, userToggled: false });
  });

  it('an imperative switch that does not open leaves a closed panel closed', () => {
    expect(
      rightPanelTransition(
        { open: false, view: 'files', remembered: 'files' },
        { kind: 'imperative', view: 'changes', open: false },
      ),
    ).toEqual({ open: false, view: 'changes', persist: null, userToggled: false });
  });
});
