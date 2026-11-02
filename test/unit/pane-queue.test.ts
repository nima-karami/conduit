import { describe, expect, it } from 'vitest';
import { createPaneQueue } from '../../webview/pane-queue';

describe('createPaneQueue — imperative right-panel work waits for the mounted pane', () => {
  it('holds actions until a pane is mounted and open, then runs each once in order', () => {
    const q = createPaneQueue<string[]>();
    const pane: string[] = [];
    q.push((p) => p.push('a'));
    q.push((p) => p.push('b'));
    q.drain(null, true);
    expect(pane).toEqual([]);
    q.drain(pane, true);
    expect(pane).toEqual(['a', 'b']);
    q.drain(pane, true);
    expect(pane).toEqual(['a', 'b']);
  });

  it('a collapsed panel drops what was queued, so a later open never replays stale work', () => {
    const q = createPaneQueue<string[]>();
    const pane: string[] = [];
    q.push((p) => p.push('stale'));
    q.drain(null, false);
    q.drain(pane, true);
    expect(pane).toEqual([]);
  });
});
