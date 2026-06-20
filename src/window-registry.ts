// Pure session↔window ownership logic for multi-window (Slice A). Kept free of
// `electron`/`BrowserWindow` so it unit-tests without an Electron runtime; the host
// (electron/main.ts) holds the live `Map<windowId, BrowserWindow>` and calls these.

import type { Session } from './types';

/** Mutable map of sessionId → owning window id. */
export type OwnerMap = Map<string, number>;

/** Assign (or reassign) a session's owner window. */
export function assignOwner(owners: OwnerMap, sessionId: string, windowId: number): void {
  owners.set(sessionId, windowId);
}

/** Drop a session's ownership (on kill/dispose). */
export function removeOwner(owners: OwnerMap, sessionId: string): void {
  owners.delete(sessionId);
}

/** The window id that owns `sessionId`, or undefined if none. */
export function ownerOf(owners: OwnerMap, sessionId: string): number | undefined {
  return owners.get(sessionId);
}

/** The sessions (from `all`) owned by `windowId`, order preserved. */
export function sessionsForWindow(owners: OwnerMap, windowId: number, all: Session[]): Session[] {
  return all.filter((s) => owners.get(s.id) === windowId);
}

/** One window's entry in the "Move to window…" picker (multi-window Slice B). */
export interface WinListEntry {
  id: number;
  title: string;
  sessionCount: number;
}

/**
 * Assemble the `win:list` payload (multi-window Slice B): for each open window id, its
 * owned-session count and a human title — the first owned session's name, else `Window N`
 * (a per-process monotonic counter so empty windows stay distinguishable). Pure so it
 * unit-tests without an Electron runtime; the host passes its live window ids + a name
 * lookup. Order follows `windowIds`.
 */
export function buildWinList(
  windowIds: number[],
  owners: OwnerMap,
  all: Session[],
  ordinalOf: (windowId: number) => number,
): WinListEntry[] {
  return windowIds.map((id) => {
    const owned = sessionsForWindow(owners, id, all);
    return {
      id,
      title: owned[0]?.name ?? `Window ${ordinalOf(id)}`,
      sessionCount: owned.length,
    };
  });
}

/**
 * Group a session list by its stable `projectPath` key. A local analogue of
 * SessionManager.groupByProject that operates on an already-filtered (per-window)
 * list, so a window's `state` only carries groups for the sessions it owns.
 */
export function groupByProject(
  sessions: Session[],
): { projectPath: string; sessions: Session[] }[] {
  const map = new Map<string, Session[]>();
  for (const s of sessions) {
    const arr = map.get(s.projectPath) ?? [];
    arr.push(s);
    map.set(s.projectPath, arr);
  }
  return [...map.entries()].map(([projectPath, group]) => ({ projectPath, sessions: group }));
}
