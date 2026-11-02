import type { DisplayFacts } from '../src/contracts/frames';
import type { AppSessionView, ServerMethods } from '../src/contracts/server-protocol';
import {
  APP_ATTACH_HISTORY_LINES,
  type AttachTarget,
  type FirstPaint,
  type TerminalLink,
  type TerminalLinkFactory,
} from '../src/contracts/terminal-link';
import type { HostToWebview, TermGeometry, WebviewToHost } from '../src/protocol';
import type { AppSessionStore } from './app-session-store';
import type { AppLog, ServerClient } from './server-client';

type StartResult = ServerMethods['sessions.start']['result'];

/** A mounted renderer pane: everything the host keeps to show one session's terminal in it. */
interface Pane {
  size: TermGeometry;
  link: TerminalLink | undefined;
  target: AttachTarget | undefined;
  generation: number | null;
  /** A program ended under this generation: no re-attach until the session runs a new one. */
  endedGeneration: number | null;
  starting: boolean;
  /** restartSeq bumped: the renderer remounts this pane, so it attaches nothing more. */
  retired: boolean;
  exitShown: boolean;
}

export interface TerminalHostDeps {
  /** The lifecycle's current connection; null while down, so the host survives reconnects. */
  client: () => Pick<ServerClient, 'call' | 'notify'> | null;
  links: TerminalLinkFactory;
  store: Pick<AppSessionStore, 'get' | 'generationOf'>;
  sendToOwner(sessionId: string, m: HostToWebview): void;
  log: AppLog;
}

/**
 * The renderer's `term:*` over C2 and C5: input, size and facts go to the server (the only active
 * viewer, D19); bytes come from an hc observer link. Status is read only from `sessions.changed`;
 * a link's CLOSE never changes it.
 */
export function createTerminalHost(d: TerminalHostDeps) {
  const panes = new Map<string, Pane>();
  const facts = new Map<string, DisplayFacts>();

  const writePaint = (sessionId: string, paint: FirstPaint) => {
    if (paint.data)
      d.sendToOwner(sessionId, {
        type: 'term:data',
        sessionId,
        data: paint.data,
        replay: paint.replay,
      });
  };

  const showExit = (sessionId: string, pane: Pane, code: number | null | undefined) => {
    if (pane.exitShown) return;
    pane.exitShown = true;
    if (typeof code === 'number') d.sendToOwner(sessionId, { type: 'term:exit', sessionId, code });
    else
      d.sendToOwner(sessionId, {
        type: 'term:data',
        sessionId,
        data: '\r\n\x1b[2m[process exited]\x1b[0m\r\n',
      });
  };

  const current = (sessionId: string, pane: Pane) => panes.get(sessionId) === pane;

  async function attach(
    sessionId: string,
    pane: Pane,
    target: AttachTarget,
    generation: number | null,
    history: number,
  ): Promise<void> {
    let held: TerminalLink | undefined;
    const early: string[] = [];
    let link: TerminalLink;
    try {
      link = await d.links.attach(sessionId, target, pane.size, history, {
        data: (data) => {
          // First-paint completion resolves the attach promise on a microtask; later data in the
          // same stream turn must wait so it cannot be emitted ahead of the first paint.
          if (!held) early.push(data);
          else if (pane.link === held)
            d.sendToOwner(sessionId, { type: 'term:data', sessionId, data });
        },
        size: () => {},
        closed: (reason, exitCode, restartable) => {
          d.log('info', 'terminal link closed', { sessionId, reason, exitCode, restartable });
          if (pane.link !== held) return;
          pane.link = undefined;
          if (!restartable) pane.endedGeneration = pane.generation;
        },
      });
    } catch (error) {
      d.log('warn', 'terminal attach failed', { sessionId, err: String(error) });
      return;
    }
    if (!current(sessionId, pane) || pane.retired) {
      link.close();
      return;
    }
    pane.link?.close();
    pane.link = link;
    pane.target = target;
    pane.generation = generation;
    pane.exitShown = false;
    writePaint(sessionId, link.firstPaint);
    for (const data of early.splice(0))
      d.sendToOwner(sessionId, { type: 'term:data', sessionId, data });
    held = link;
  }

  /** `sessions.retryLaunch` answers like `sessions.start`, so a retry takes this same path (W7 S4). */
  async function run(
    sessionId: string,
    pane: Pane,
    method: 'sessions.start' | 'sessions.retryLaunch' = 'sessions.start',
  ): Promise<void> {
    const c = d.client();
    if (!c || pane.starting || pane.retired) return;
    pane.starting = true;
    try {
      // One ordered pipe: these shape the server's first attach (term.facts doc, C2).
      c.notify('term.resize', { sessionId, ...pane.size });
      const f = facts.get(sessionId);
      if (f) c.notify('term.facts', { sessionId, facts: f });
      let r: StartResult;
      try {
        r = await c.call(method, { sessionId });
      } catch (error) {
        d.log('warn', `${method} failed`, { sessionId, err: String(error) });
        return;
      }
      if (!current(sessionId, pane)) return;
      if (!r.ok) {
        if (r.prelude) writePaint(sessionId, r.prelude);
        d.log('info', 'start refused', { sessionId, reason: r.refusal.reason });
        return;
      }
      if ('finished' in r) {
        writePaint(sessionId, r.prelude);
        showExit(sessionId, pane, r.finished.exitCode);
        return;
      }
      if (r.prelude) writePaint(sessionId, r.prelude);
      await attach(sessionId, pane, r.target, r.generation, APP_ATTACH_HISTORY_LINES);
    } finally {
      pane.starting = false;
    }
  }

  const wantsAttach = (pane: Pane, v: AppSessionView) =>
    v.status === 'running' &&
    v.runtime.spawn === 'live' &&
    !pane.retired &&
    !pane.starting &&
    v.runtime.generation !== pane.endedGeneration &&
    (!pane.link || pane.generation !== v.runtime.generation);

  return {
    /** A pane mounted; a remount in another window replaces the previous pane's link. */
    async start(m: Extract<WebviewToHost, { type: 'term:start' }>): Promise<void> {
      if (!d.store.get(m.sessionId)) return;
      panes.get(m.sessionId)?.link?.close();
      const pane: Pane = {
        size: { cols: m.cols, rows: m.rows },
        link: undefined,
        target: undefined,
        generation: null,
        endedGeneration: null,
        starting: false,
        retired: false,
        exitShown: false,
      };
      panes.set(m.sessionId, pane);
      await run(m.sessionId, pane);
    },

    /** A person's Retry launch on an unconfirmed spawn; with no mounted pane, sessionsChanged attaches. */
    async retryLaunch(sessionId: string): Promise<void> {
      const pane = panes.get(sessionId);
      if (pane) {
        await run(sessionId, pane, 'sessions.retryLaunch');
        return;
      }
      const c = d.client();
      if (!c) return;
      try {
        await c.call('sessions.retryLaunch', { sessionId });
      } catch (error) {
        d.log('warn', 'sessions.retryLaunch failed', { sessionId, err: String(error) });
      }
    },

    /** D29: dropped, never buffered, while down or before the session has a generation. */
    input(sessionId: string, data: string): void {
      const known = [panes.get(sessionId)?.generation, d.store.generationOf(sessionId)].filter(
        (g): g is number => typeof g === 'number',
      );
      if (!known.length) return;
      d.client()?.notify('term.input', { sessionId, generation: Math.max(...known), data });
    },

    resize(sessionId: string, g: TermGeometry): void {
      const pane = panes.get(sessionId);
      if (pane) pane.size = { cols: g.cols, rows: g.rows };
      d.client()?.notify('term.resize', { sessionId, cols: g.cols, rows: g.rows });
    },

    facts(sessionId: string, f: DisplayFacts): void {
      facts.set(sessionId, f);
      d.client()?.notify('term.facts', { sessionId, facts: f });
    },

    /** The pane unmounted: detach only; the program keeps running in hc. */
    dispose(sessionId: string): void {
      const pane = panes.get(sessionId);
      panes.delete(sessionId);
      facts.delete(sessionId);
      pane?.link?.close();
    },

    /** Host-composed bytes (C7 ScrollbackPort.show), already in the server's ring. */
    show(sessionId: string, data: string): void {
      d.sendToOwner(sessionId, { type: 'term:data', sessionId, data });
    },

    sessionsChanged(prev: AppSessionView[], next: AppSessionView[]): void {
      const before = new Map(prev.map((s) => [s.id, s]));
      const after = new Map(next.map((s) => [s.id, s]));
      for (const [id, pane] of panes) {
        const v = after.get(id);
        if (!v) {
          pane.link?.close();
          panes.delete(id);
          continue;
        }
        const p = before.get(id);
        if (p && (p.restartSeq ?? 0) !== (v.restartSeq ?? 0)) {
          pane.retired = true;
          pane.link?.close();
          pane.link = undefined;
          continue;
        }
        if (p?.status === 'running' && v.status === 'exited') showExit(id, pane, v.exitCode);
        if (wantsAttach(pane, v)) void run(id, pane);
      }
    },

    /** Every (re)connect: the new server's attach needs each pane's size and facts. */
    serverConnected(): void {
      const c = d.client();
      if (!c) return;
      for (const [sessionId, pane] of panes) {
        if (pane.endedGeneration !== null && pane.generation === pane.endedGeneration) continue;
        if (!pane.link) {
          void run(sessionId, pane);
          continue;
        }
        c.notify('term.resize', { sessionId, ...pane.size });
        const f = facts.get(sessionId);
        if (f) c.notify('term.facts', { sessionId, facts: f });
      }
    },

    /** F10: history 0, so the scrollback already in the xterm isn't written twice. */
    hcReconnected(): void {
      for (const [sessionId, pane] of panes) {
        if (pane.link || !pane.target || pane.retired) continue;
        if (pane.endedGeneration !== null && pane.generation === pane.endedGeneration) continue;
        void attach(sessionId, pane, pane.target, pane.generation, 0);
      }
    },

    closeAll(): void {
      for (const pane of panes.values()) pane.link?.close();
      panes.clear();
    },
  };
}

export type TerminalHost = ReturnType<typeof createTerminalHost>;
