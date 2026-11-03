import { describe, expect, it } from 'vitest';
import { createGpuVisibilityGate } from '../../webview/terminal-gpu-visibility';

function gate(initial: boolean) {
  const calls: boolean[] = [];
  return { g: createGpuVisibilityGate(initial, (v) => calls.push(v)), calls };
}

describe('GPU visibility gate', () => {
  it('releases as soon as the pane is hidden, before any intersection report', () => {
    const { g, calls } = gate(true);
    g.intersection(true);
    g.setWanted(false);
    expect(calls).toEqual([true, false]);
  });

  it('waits for the pane to intersect before attaching on show', () => {
    const { g, calls } = gate(true);
    g.intersection(true);
    g.setWanted(false);
    g.intersection(false);
    calls.length = 0;
    g.setWanted(true);
    expect(calls).toEqual([]);
    g.intersection(true);
    expect(calls).toEqual([true]);
  });

  it('attaches at once when xterm never saw the pane leave (hide and show between reports)', () => {
    const { g, calls } = gate(true);
    g.intersection(true);
    g.setWanted(false);
    g.setWanted(true);
    expect(calls).toEqual([true, false, true]);
  });

  it('attaches at once with no intersection report at all', () => {
    const { g, calls } = gate(false);
    g.setWanted(true);
    expect(calls).toEqual([true]);
  });

  it('an intersection while the pane is not wanted attaches nothing', () => {
    const { g, calls } = gate(false);
    g.intersection(true);
    expect(calls).toEqual([]);
  });

  it('a pane mounted hidden attaches once it is shown and intersects', () => {
    const { g, calls } = gate(false);
    g.intersection(false);
    g.setWanted(true);
    expect(calls).toEqual([]);
    g.intersection(true);
    expect(calls).toEqual([true]);
  });
});
