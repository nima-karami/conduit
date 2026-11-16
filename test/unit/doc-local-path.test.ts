import { describe, expect, it } from 'vitest';
import { isDocDirty, localPathOf, type OpenDoc } from '../../webview/docs';

/** A set that records every membership question asked of it. */
class RecordingSet extends Set<string> {
  consulted: string[] = [];
  override has(path: string): boolean {
    this.consulted.push(path);
    return super.has(path);
  }
}

const PATH = '/w/a.ts';
const remote: OpenDoc = {
  id: `remote-file@M1:${PATH}`,
  kind: 'remote-file',
  path: PATH,
  title: 'a.ts',
  sessionId: 'remote:M1:S1',
  machine: { machineId: 'M1', sessionId: 'S1' },
};
const local: OpenDoc = {
  id: `file:${PATH}`,
  kind: 'file',
  path: PATH,
  title: 'a.ts',
  sessionId: 'S',
};

describe('local path of a doc', () => {
  it('closing a remote tab never consults a dirty local file of the same path', () => {
    const dirty = new RecordingSet([PATH]);
    expect(localPathOf(remote)).toBeNull();
    expect(isDocDirty(remote, dirty)).toBe(false);
    expect(dirty.consulted).toEqual([]);

    // The same path as a local doc is the dirty file, so the check above is not vacuous.
    expect(localPathOf(local)).toBe(PATH);
    expect(isDocDirty(local, dirty)).toBe(true);
    expect(dirty.consulted).toEqual([PATH]);
  });
});
