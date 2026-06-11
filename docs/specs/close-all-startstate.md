# Spec — Closing the last session returns to the initial start state (J3)

## Context

On first launch with no sessions, the app shows a clean **initial start state**: the
editor's empty state in the center pane ("No active session. Click **New** to start a
terminal."), the Sessions sidebar prompt ("No sessions yet. Hit New."), and the top-bar
view switcher on **Editor**.

When the user closes **all** sessions (closes the last one), the app was expected to fall
back to that same initial start state. Instead it could land on a "weird empty / black"
page that did not match a fresh launch.

## Root cause

The center pane shows exactly one of three views — Editor / Feature Board / Architecture
Canvas — selected by a single `centerView` state in `webview/app.tsx`
(`useState<CenterView>('editor')`). The Board and Canvas views render as **full overlays**
(`{centerView === 'board' && <BoardView/>}`, `{centerView === 'canvas' && <ArchitectureView/>}`)
that are **independent of the session count**.

At first launch `centerView` is always `'editor'`, so the editor empty state shows. But
`centerView` is **never reset when the session count transitions 1 → 0**. So if the user
had switched to Board or Canvas and then closed the last session, the overlay kept
rendering over an empty workbench — a view that has no analogue at fresh launch, hence
"not the initial start state". (The editor's own zero-session empty state, in
`CenterPane`, was already correct; the divergence was entirely the dangling `centerView`.)

The `activeId` side was already handled — an existing effect clears `activeId` to
`undefined` when `sessions.length === 0`. Only the `centerView` was left dangling.

## Fix

Add a pure helper `nextCenterView(current, sessionCount)` to `webview/center-view.ts`
(the existing single source of truth for view logic, already unit-tested) and a
`INITIAL_CENTER_VIEW` constant:

```ts
export const INITIAL_CENTER_VIEW: CenterView = 'editor';
export function nextCenterView(current: CenterView, sessionCount: number): CenterView {
  return sessionCount === 0 ? INITIAL_CENTER_VIEW : current;
}
```

Wire it into the existing "keep a valid active session" effect in `webview/app.tsx`, which
already special-cases `sessions.length === 0`:

```ts
setCenterView((v) => nextCenterView(v, sessions.length));
```

So the transition-to-zero now both clears the active id **and** falls the center view back
to the editor — making post-close render the same initial start state as a fresh launch.
With ≥ 1 session the user's chosen view is preserved (no behavior change).

## Edge cases

- Closing the last session while on **Board** or **Canvas** → overlay removed, editor empty
  state shown (the fix).
- Closing a non-last session → count stays ≥ 1, `centerView` preserved (unchanged).
- Fresh launch with zero sessions → `centerView` is already `'editor'`; the helper is a
  no-op (`nextCenterView('editor', 0) === 'editor'`).
- State lives in the Electron main process; closing round-trips `kill` → `mgr.remove` →
  re-broadcast `state` with the smaller session list. The renderer reflects host state, so
  the fix triggers off the broadcast session array — no renderer source of truth assumed,
  and it works with `window.agentDeck` absent (browser preview).

## Acceptance criteria

- [x] Closing the last session returns to the editor empty start state, matching a fresh
      launch — not a black/empty page or a floating Board/Canvas overlay.
- [x] Closing the last session **while Board/Canvas is open** resets the view to Editor.
- [x] With ≥ 1 session, switching views is unchanged.
- [x] Pure selection logic (`nextCenterView`) covered by unit tests in
      `test/unit/center-view.test.ts`.
- [x] `npm run verify` and `npm run build` both green; runtime verified via Playwright
      (post-close DOM matches fresh-launch: `centerEmpty: true`, `board/arch: false`).
</content>
</invoke>
