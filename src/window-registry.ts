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

/** A point in global SCREEN coordinates (DragEvent.screenX/screenY are screen-relative). */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** A window's outer bounds in screen coordinates (electron `BrowserWindow.getBounds()`). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectContains(r: Rect, p: ScreenPoint): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

/**
 * Cross-window drag hit-test (multi-window Slice C): the id of the window whose bounds
 * contain `point`, EXCLUDING `excludeId` (the drag source — a drop back over the source is
 * handled separately by the caller as a no-op). Returns null if no other window covers the
 * point (→ caller tears out a new window at the drop).
 *
 * Electron gives us no reliable cross-window z-order here, so input order is treated as
 * topmost-first: the FIRST containing window wins. Callers should pass windows
 * focus-ordered when possible; first-match is acceptable otherwise.
 */
export function windowAtPoint(
  point: ScreenPoint,
  wins: { id: number; bounds: Rect }[],
  excludeId: number,
): number | null {
  for (const w of wins) {
    if (w.id === excludeId) continue;
    if (rectContains(w.bounds, point)) return w.id;
  }
  return null;
}

/**
 * Bounds for a NEW window torn out at a drop point (multi-window Slice C). The window's
 * top-left is offset slightly up/left of the pointer so the (renderer-drawn) titlebar lands
 * near the cursor rather than the content. When a `display` work area is given, the result is
 * clamped to stay on-screen (a drop near a screen edge never spawns a mostly-off-screen
 * window) — best-effort off-screen guard. Pure.
 */
export function tearOutBounds(
  point: ScreenPoint,
  size: { width: number; height: number },
  display?: Rect,
): Rect {
  // Place the titlebar a little above-left of the pointer so the cursor sits inside the
  // window's chrome, matching the "the window appears under your drop" expectation.
  const TITLEBAR_OFFSET = 16;
  let x = point.x - TITLEBAR_OFFSET;
  let y = point.y - TITLEBAR_OFFSET;
  if (display) {
    const maxX = display.x + display.width - size.width;
    const maxY = display.y + display.height - size.height;
    x = Math.min(Math.max(x, display.x), Math.max(display.x, maxX));
    y = Math.min(Math.max(y, display.y), Math.max(display.y, maxY));
  }
  return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height };
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
