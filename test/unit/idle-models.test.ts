import { describe, expect, it } from 'vitest';
import { createIdleModels } from '../../webview/idle-model-lru';

const CAP = 50;

function setup() {
  const disposed: string[] = [];
  const dirty = new Set<string>();
  const models = createIdleModels({
    cap: CAP,
    canDispose: (path) => !dirty.has(path),
    dispose: (path) => disposed.push(path),
  });
  let open = new Set<string>();
  const sync = () => models.syncOpenPaths(open);
  const openTab = (p: string) => {
    open = new Set(open).add(p);
    sync();
  };
  const closeTab = (p: string) => {
    open = new Set(open);
    open.delete(p);
    sync();
  };
  return { disposed, dirty, openTab, closeTab, sync };
}

const others = (n: number) => Array.from({ length: n }, (_, i) => `/other${i}.ts`);

describe('createIdleModels', () => {
  it('a tab switch — the viewer unmounts, the tab stays open — never makes its model idle', () => {
    const t = setup();
    t.openTab('/a.ts');
    // Visiting files: each opens (and, as a preview, may close) while /a.ts's tab stays open and
    // its viewer is unmounted the whole time.
    for (const p of others(CAP * 2)) {
      t.openTab(p);
      t.closeTab(p);
    }
    expect(t.disposed).not.toContain('/a.ts');
    expect(t.disposed.length).toBe(CAP);
  });

  it('re-syncing the same open set queues nothing', () => {
    const t = setup();
    for (const p of others(CAP * 2)) t.openTab(p);
    for (let i = 0; i < 5; i++) t.sync();
    expect(t.disposed).toEqual([]);
  });

  it('a dirty model is never disposed, even far past the cap', () => {
    const t = setup();
    t.openTab('/dirty.ts');
    t.dirty.add('/dirty.ts');
    t.closeTab('/dirty.ts');
    for (const p of others(CAP * 3)) {
      t.openTab(p);
      t.closeTab(p);
    }
    expect(t.disposed).not.toContain('/dirty.ts');
  });

  it('a model that turns dirty while queued is spared when its turn comes', () => {
    const t = setup();
    t.openTab('/late.ts');
    t.closeTab('/late.ts');
    t.dirty.add('/late.ts');
    for (const p of others(CAP)) {
      t.openTab(p);
      t.closeTab(p);
    }
    expect(t.disposed).not.toContain('/late.ts');
  });

  it('closing a clean tab makes its model eligible; it goes first, oldest-idle out', () => {
    const t = setup();
    t.openTab('/a.ts');
    t.closeTab('/a.ts');
    for (const p of others(CAP - 1)) {
      t.openTab(p);
      t.closeTab(p);
    }
    expect(t.disposed).toEqual([]);
    t.openTab('/one-more.ts');
    t.closeTab('/one-more.ts');
    expect(t.disposed).toEqual(['/a.ts']);
  });

  it('reopening a closed tab takes its model out of the queue', () => {
    const t = setup();
    t.openTab('/a.ts');
    t.closeTab('/a.ts');
    t.openTab('/a.ts');
    for (const p of others(CAP * 2)) {
      t.openTab(p);
      t.closeTab(p);
    }
    expect(t.disposed).not.toContain('/a.ts');
  });
});
