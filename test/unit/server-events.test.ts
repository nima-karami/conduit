import { describe, expect, it } from 'vitest';
import { AppSessionStore } from '../../electron/app-session-store';
import * as serverEvents from '../../electron/server-events';
import { createServerEventRouter, type ServerEventRouterDeps } from '../../electron/server-events';
import type {
  ServerEventEnvelope,
  ServerEvents,
  ServerSnapshot,
  SessionView,
} from '../../src/contracts/server-protocol';
import type { HostToWebview } from '../../src/protocol';
import { DEFAULT_SETTINGS } from '../../src/settings';

const view = (id: string): SessionView => ({
  id,
  name: id,
  agentId: 'claude',
  home: '/w',
  roots: [],
  status: 'running',
  createdAt: 0,
  lastActiveAt: 0,
  runtime: { generation: 1, spawn: 'live', reportedStatus: null, lastSize: null },
});

let seq = 0;
const ev = <E extends keyof ServerEvents>(type: E, data: ServerEvents[E]): ServerEventEnvelope =>
  ({ seq: ++seq, type, data }) as ServerEventEnvelope;

function rig(over: Partial<ServerEventRouterDeps> = {}) {
  const trace: string[] = [];
  const store = new AppSessionStore();
  const owners = new Map<string, number>();
  const states: string[][] = [];
  let osAttention = true;
  const deps: ServerEventRouterDeps = {
    store,
    terminals: { sessionsChanged: () => {}, show: () => {} },
    broadcastState: () => {
      const ids = store.list().map((s) => s.id);
      states.push(ids);
      trace.push(`state:${ids.join(',')}`);
    },
    broadcast: (m: HostToWebview) => trace.push(`broadcast:${m.type}`),
    sendToWindow: (id, m) => trace.push(`window${id}:${m.type}`),
    ownerWindowOf: (id) => owners.get(id),
    raiseWindow: (id) => trace.push(`raise:${id}`),
    openFileInEditor: () => trace.push('openFile'),
    sessionsApplied: () => {},
    onServerSettings: () => {},
    onStores: () => {},
    onRuntime: () => {},
    osAttention: () => osAttention,
    anyWindowFocused: () => false,
    notifyAttention: (id, kind) => trace.push(`notify:${id}:${kind}`),
    flash: (id) => trace.push(`flash:${id}`),
    place: (e) => {
      owners.set(e.sessionId, 2);
      trace.push(`place:${e.sessionId}:${e.focus}`);
    },
    log: () => {},
    ...over,
  };
  const router = createServerEventRouter(deps);
  return {
    router,
    trace,
    owners,
    states,
    setOsAttention: (v: boolean) => {
      osAttention = v;
    },
  };
}

const snapshot = (sessions: SessionView[]): ServerSnapshot => ({
  seq: 0,
  sessions,
  settings: {
    conduitMcp: DEFAULT_SETTINGS.conduitMcp,
    mcpToolPolicy: DEFAULT_SETTINGS.mcpToolPolicy,
    mcpToolPolicyByCli: DEFAULT_SETTINGS.mcpToolPolicyByCli,
    mcpGateMigrated: DEFAULT_SETTINGS.mcpGateMigrated,
    autoResumeOnLimit: DEFAULT_SETTINGS.autoResumeOnLimit,
    autoRelaunchStale: DEFAULT_SETTINGS.autoRelaunchStale,
    restoreSessions: DEFAULT_SETTINGS.restoreSessions,
    scrollbackPersistence: DEFAULT_SETTINGS.scrollbackPersistence,
    trackCwd: DEFAULT_SETTINGS.trackCwd,
  },
  stores: { agents: [], launchers: [], projects: [] },
  runtime: { state: 'starting' },
  timers: { schedules: [], offer: null },
  mcp: { sessions: {}, unread: {}, threads: [] } as unknown as ServerSnapshot['mcp'],
  pendingAsks: [],
});

describe('server-events router', () => {
  it('matches an openerless opened event to the create that resolved its session id', () => {
    expect(serverEvents.createPendingAppCreateMatcher).toBeTypeOf('function');
    const placed: Array<{ sessionId: string; windowId?: number }> = [];
    const matcher = serverEvents.createPendingAppCreateMatcher((event, windowId) =>
      placed.push({ sessionId: event.sessionId, windowId }),
    );
    const first = matcher.begin(1);
    const second = matcher.begin(2);
    const opened = (sessionId: string) => ({ sessionId, focus: true });

    matcher.opened(opened('s2'));
    expect(matcher.isHeld('s2')).toBe(true);
    matcher.resolve(second, 's2');
    expect(matcher.isHeld('s2')).toBe(false);
    matcher.resolve(first, 's1');
    matcher.opened(opened('s1'));
    expect(placed).toEqual([
      { sessionId: 's2', windowId: 2 },
      { sessionId: 's1', windowId: 1 },
    ]);
    const third = matcher.begin(3);
    matcher.opened(opened('external'));
    matcher.cancel(third);
    expect(placed.at(-1)).toEqual({ sessionId: 'external', windowId: undefined });
  });

  it('matches an opened event that arrives after its create reply', () => {
    const placed: Array<{ sessionId: string; windowId?: number }> = [];
    const matcher = serverEvents.createPendingAppCreateMatcher((event, windowId) =>
      placed.push({ sessionId: event.sessionId, windowId }),
    );
    const token = matcher.begin(4);
    matcher.resolve(token, 'later');
    expect(placed).toEqual([]);
    matcher.opened({ sessionId: 'later', focus: true });
    expect(placed).toEqual([{ sessionId: 'later', windowId: 4 }]);
  });

  it('falls back for openerless events when no app create can match', () => {
    const placed: Array<{ sessionId: string; windowId?: number }> = [];
    const matcher = serverEvents.createPendingAppCreateMatcher((event, windowId) =>
      placed.push({ sessionId: event.sessionId, windowId }),
    );
    matcher.opened({ sessionId: 'external', focus: true });
    expect(placed).toEqual([{ sessionId: 'external', windowId: undefined }]);
  });

  it('sessions.opened{focus:false} applied before the session first appears in state', () => {
    const r = rig();
    r.router.snapshot(snapshot([]));
    r.trace.length = 0;
    r.router.event(ev('sessions.opened', { sessionId: 'n1', focus: false }));
    r.router.event(ev('sessions.changed', { sessions: [view('n1')] }));
    expect(r.trace).toEqual(['place:n1:false', 'state:n1']);
  });

  it('timers.fired → timer:fired before timer:state', () => {
    const r = rig();
    r.router.event(
      ev('timers.fired', { id: 't', sessionId: 's', at: 1, late: false, delivered: true }),
    );
    r.router.event(ev('timers.changed', { schedules: [], offer: null }));
    expect(r.trace).toEqual(['broadcast:timer:fired', 'broadcast:timer:state']);
  });

  it('ui.post owner route resolves owner window; raise focuses it', () => {
    const r = rig();
    r.owners.set('s1', 3);
    r.router.event(
      ev('ui.post', {
        route: { kind: 'owner', sessionId: 's1' },
        message: { type: 'activateSession', sessionId: 's1' },
        raise: true,
      }),
    );
    expect(r.trace).toEqual(['window3:activateSession', 'raise:3']);
    // An owner the app doesn't know is dropped, never broadcast.
    r.trace.length = 0;
    r.router.event(
      ev('ui.post', {
        route: { kind: 'owner', sessionId: 'gone' },
        message: { type: 'activateSession', sessionId: 'gone' },
      }),
    );
    expect(r.trace).toEqual([]);
  });

  it('attention.edge with osAttention off → no Notification', () => {
    const r = rig();
    r.setOsAttention(false);
    r.router.event(ev('attention.edge', { sessionId: 's1', kind: 'run-end' }));
    r.router.event(ev('attention.flash', { sessionId: 's1' }));
    expect(r.trace).toEqual([]);
    r.setOsAttention(true);
    r.router.event(ev('attention.edge', { sessionId: 's1', kind: 'bell' }));
    expect(r.trace).toEqual(['notify:s1:bell']);
  });

  it('a snapshot re-posts pending asks to their owners', () => {
    const r = rig();
    r.owners.set('caller', 4);
    const ask = {
      askId: 'a1',
      callerSessionId: 'caller',
    } as unknown as ServerSnapshot['pendingAsks'][number];
    r.router.snapshot({ ...snapshot([view('caller')]), pendingAsks: [ask] });
    expect(r.trace).toContain('window4:mcp:ask');
    expect(r.trace.at(-1)).toBe('state:caller');
  });
});
