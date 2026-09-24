import { describe, expect, it } from 'vitest';
import { AgentScopeTracker } from '../../electron/agent-scope-tracker';
import type { AgentScope } from '../../src/agent-scope';
import type { Session } from '../../src/types';

const flush = () => new Promise((r) => setTimeout(r, 0));

function rig(folders: Pick<Session, 'home' | 'roots'> & Partial<Session>) {
  let session: Session = {
    id: 's',
    name: 's',
    agentId: 'claude',
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
    ...folders,
  };
  const changes: string[] = [];
  const pending: { path: string; resolve: (v: boolean) => void }[] = [];
  let manualExists = false;
  const tracker = new AgentScopeTracker({
    get: (id) => (id === session.id ? session : undefined),
    exists: (p) =>
      manualExists
        ? new Promise<boolean>((resolve) => pending.push({ path: p, resolve }))
        : Promise.resolve(true),
    onChange: (id) => changes.push(id),
  });
  return {
    tracker,
    changes,
    pending,
    manual: () => {
      manualExists = true;
    },
    set: (patch: Partial<Session>) => {
      session = { ...session, ...patch };
    },
  };
}

const scope = (cwd: string, dirs: string[] = [], external: string[] = []): AgentScope => ({
  cwd,
  dirs,
  external,
});

describe('AgentScopeTracker', () => {
  it('captured with an unseen root publishes a view and calls onChange once', async () => {
    const r = rig({ home: '/h', roots: ['/d'] });
    r.tracker.captured('s', scope('/h'));
    await flush();
    expect(r.tracker.view('s')).toEqual({ unseen: ['/d'], stillSeen: [], typeable: ['/d'] });
    expect(r.changes).toEqual(['s']);
  });

  it('captured with no drift publishes nothing and does not call onChange', async () => {
    const r = rig({ home: '/h', roots: [] });
    r.tracker.captured('s', scope('/h'));
    await flush();
    expect(r.tracker.view('s')).toBeUndefined();
    expect(r.changes).toEqual([]);
  });

  it('recompute with no drift change does not call onChange', async () => {
    const r = rig({ home: '/h', roots: ['/d'] });
    r.tracker.captured('s', scope('/h'));
    await flush();
    r.tracker.recompute('s');
    await flush();
    expect(r.changes).toEqual(['s']);
  });

  it('recompute without a scope is a no-op', async () => {
    const r = rig({ home: '/h', roots: ['/d'] });
    r.tracker.recompute('s');
    await flush();
    expect(r.tracker.view('s')).toBeUndefined();
    expect(r.changes).toEqual([]);
  });

  it('an older recompute resolving after a newer one is discarded', async () => {
    const r = rig({ home: '/h', roots: [] });
    r.manual();
    r.tracker.captured('s', scope('/h', ['/old']));
    // First recompute: /old is stillSeen-candidate; resolve it LAST with true.
    r.set({ roots: ['/old'] });
    r.tracker.recompute('s');
    // The second recompute has no candidates at all (/old is a root again) → resolves at once.
    await flush();
    expect(r.tracker.view('s')).toBeUndefined();
    const first = r.pending.shift();
    first?.resolve(true);
    await flush();
    expect(r.tracker.view('s')).toBeUndefined();
    expect(r.changes).toEqual([]);
  });

  it('latest-wins across two pending stats', async () => {
    const r = rig({ home: '/h', roots: [] });
    r.manual();
    r.tracker.captured('s', scope('/h', ['/a']));
    r.tracker.recompute('s');
    expect(r.pending).toHaveLength(2);
    r.pending[1].resolve(false);
    await flush();
    r.pending[0].resolve(true);
    await flush();
    expect(r.tracker.view('s')).toBeUndefined();
    expect(r.changes).toEqual([]);
  });

  it('ended while a stat is pending: the late result publishes nothing', async () => {
    const r = rig({ home: '/h', roots: [] });
    r.manual();
    r.tracker.captured('s', scope('/h', ['/a']));
    r.tracker.ended('s');
    r.pending[0].resolve(true);
    await flush();
    expect(r.tracker.view('s')).toBeUndefined();
    expect(r.changes).toEqual([]);
  });

  it('a stat from before ended + re-capture cannot publish into the new scope', async () => {
    const r = rig({ home: '/h', roots: [] });
    r.manual();
    r.tracker.captured('s', scope('/h', ['/a']));
    r.tracker.ended('s');
    r.tracker.captured('s', scope('/h', ['/b']));
    r.pending[0].resolve(true);
    await flush();
    expect(r.tracker.view('s')).toBeUndefined();
    r.pending[1].resolve(true);
    await flush();
    expect(r.tracker.view('s')?.stillSeen).toEqual(['/b']);
  });

  it('ended with a view drops it and calls onChange; without one it stays quiet', async () => {
    const r = rig({ home: '/h', roots: ['/d'] });
    r.tracker.captured('s', scope('/h'));
    await flush();
    r.tracker.ended('s');
    expect(r.tracker.view('s')).toBeUndefined();
    expect(r.changes).toEqual(['s', 's']);
    r.tracker.ended('s');
    expect(r.changes).toEqual(['s', 's']);
  });

  it('dismiss hides the current lists; a later add shows only the new folder (AC-10)', async () => {
    const r = rig({ home: '/h', roots: ['/g'] });
    r.tracker.captured('s', scope('/h'));
    await flush();
    r.tracker.dismiss('s');
    await flush();
    expect(r.tracker.view('s')).toBeUndefined();
    r.set({ roots: ['/g', '/k'] });
    r.tracker.recompute('s');
    await flush();
    expect(r.tracker.view('s')).toEqual({ unseen: ['/k'], stillSeen: [], typeable: ['/k'] });
  });

  it('removing a dismissed folder and adding it back shows it again', async () => {
    const r = rig({ home: '/h', roots: ['/g'] });
    r.tracker.captured('s', scope('/h'));
    await flush();
    r.tracker.dismiss('s');
    await flush();
    r.set({ roots: [] });
    r.tracker.recompute('s');
    await flush();
    r.set({ roots: ['/g'] });
    r.tracker.recompute('s');
    await flush();
    expect(r.tracker.view('s')?.unseen).toEqual(['/g']);
  });

  it('delivered path leaves unseen', async () => {
    const r = rig({ home: '/h', roots: ['/d', '/e'] });
    r.tracker.captured('s', scope('/h'));
    await flush();
    r.tracker.delivered('s', '/d');
    await flush();
    expect(r.tracker.view('s')?.unseen).toEqual(['/e']);
    r.tracker.delivered('s', '/e');
    await flush();
    expect(r.tracker.view('s')).toBeUndefined();
  });

  it('typeable: undefined without a scope, [] when nothing typeable', async () => {
    const r = rig({ home: '/h', roots: [] });
    expect(r.tracker.typeable('s')).toBeUndefined();
    r.tracker.captured('s', scope('/h'));
    await flush();
    expect(r.tracker.typeable('s')).toEqual([]);
    r.set({ roots: ['//srv/share'] });
    r.tracker.recompute('s');
    await flush();
    expect(r.tracker.view('s')?.unseen).toEqual(['//srv/share']);
    expect(r.tracker.typeable('s')).toEqual([]);
  });

  it('captured clears previous dismissals', async () => {
    const r = rig({ home: '/h', roots: ['/g'] });
    r.tracker.captured('s', scope('/h'));
    await flush();
    r.tracker.dismiss('s');
    await flush();
    r.tracker.captured('s', scope('/h'));
    await flush();
    expect(r.tracker.view('s')?.unseen).toEqual(['/g']);
  });
});
