# F2 — Working app chrome / navigation

## Goal
Make the three dead top-bar buttons real: collapse/expand the sidebar, and
browser-style Back / Forward through the views you've visited.

## Part A — Collapse sidebar
- The sidebar-toggle button collapses and expands the left panel.
- Collapsed: left grid column → 0, sidebar hidden, left resize handle hidden,
  center widens (terminal refits automatically via its ResizeObserver).
- State is ephemeral app state (not persisted) for now.
- Button reflects state (title "Collapse/Expand sidebar").

## Part B — Back / Forward navigation history
Model the center "view" as a **location**: `{ sessionId?, docId: string|null }`
where docId null = the session's terminal tab. As the user navigates (switches
sessions, opens/switches/closes document tabs), distinct consecutive locations are
recorded onto a history stack. Back/Forward move through it like a browser — moving
does NOT record new history; opening something new after going Back truncates the
forward entries.

### Pure module `src/navHistory.ts` (unit-tested)
- `NavLoc { sessionId?: string; docId: string | null }`
- `NavState { stack: NavLoc[]; index: number }`, `EMPTY_NAV = { stack: [], index: -1 }`
- `record(state, loc)`: if loc equals current → unchanged; else drop forward
  entries (`stack.slice(0, index+1)`), append loc, index = end.
- `back(state)` / `forward(state)`: move index within bounds.
- `canBack(state)` / `canForward(state)`, `current(state)`.

### Hook `webview/useNavHistory.ts`
Inputs: current `{sessionId, docId}` + `apply(loc)` callback. Internally holds NavState.
- Effect on [sessionId, docId]: if a back/forward just applied (ref flag), clear flag;
  else `record`.
- `goBack`/`goForward`: set flag, compute new state, `apply(current(newState))`.
- Returns `{ goBack, goForward, canBack, canForward }`.

### App wiring
- `apply(loc)`: `setActiveId(loc.sessionId)`; activate `loc.docId` only if that doc
  still exists, else terminal (null) — guards against navigating to a closed tab.
- Pass `onBack/onForward/canBack/canForward` + `onToggleSidebar/sidebarCollapsed` to TopBar.

## TopBar
- Wire the three buttons. Back/Forward disabled (greyed) when not available.

## CSS
- `.shell--sidebar-collapsed { grid-template-columns: 0 1fr var(--right-w); }`
  hide `.sidebar` and `.resizer--left` in that state.
- Disabled icon button style.

## Acceptance criteria
1. Toggle button hides the sidebar; toggling again restores it; terminal stays usable (refits).
2. Open file A, file B, switch to terminal, switch session → Back walks those in reverse; Forward returns.
3. Back/Forward are disabled at the ends of history.
4. After going Back then opening a new doc, Forward is cleared (no stale forward).
5. Navigating to a doc that was since closed lands on the terminal, not a blank pane.
6. navHistory unit tests cover record/dedupe/truncate/back/forward/bounds.
7. typecheck + build + tests green.
