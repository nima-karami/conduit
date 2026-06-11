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

## Hardening — the real black-screen cause (dispose guard + error boundary)

The `centerView` fix above handles a dangling Board/Canvas overlay over an empty
workbench. But the user's reported symptom — a literal **black stage** when closing
every session — had a separate, more direct cause:

> Closing a **running** session unmounts `TerminalPane`, whose React cleanup calls
> `Terminal.dispose()` and tears down the xterm **WebGL addon**. On GPU-less /
> blocklisted / headless machines (or after a lost GL context) that teardown throws
> `Cannot read properties of undefined (reading '_isDisposed')` — the addon reads
> internal state that was never initialized. With **no error boundary** around the
> center pane / app root, a throw out of React cleanup unmounts the entire tree and
> blanks the whole root to **black**.

Two defensive fixes harden against this (general resilience, not just this one bug):

### 1. Guarded terminal disposal (`webview/components/safe-dispose.ts`)

A pure `safeDispose(disposable, label)` helper runs a single `dispose()` inside
try/catch, swallows any throw (logs `console.warn`, never rethrows), and no-ops on
null. `disposeTerminal(term, addons)` disposes **addons before the terminal that owns
them**, each independently guarded, so one failing teardown can't skip the rest.
`TerminalPane`'s `useEffect` cleanup now routes through `disposeTerminal(term, [webgl,
fit])` (and the WebGL `onContextLoss` handler routes through the same guarded path),
so unmounting a terminal can **never** throw. The throwy WebGL addon goes first and is
isolated.

### 2. Error boundary around the center pane (`webview/components/error-boundary.tsx`)

A minimal class boundary (`getDerivedStateFromError` + `componentDidCatch`) wraps
`<CenterPane>` in `webview/app.tsx`. Any render/teardown throw under it is caught and
rendered as a **non-black** fallback panel (styled with `.center-empty`, which has
`background: var(--bg)`) — "Something went wrong" + a **Reload view** button whose
`onReset` falls back to `setCenterView('editor')`, i.e. the same editor start state.
So any future center-pane crash degrades to a recoverable panel, never a black void.
The fallback **decision** logic is split into a pure `error-boundary-state.ts` module
so it's unit-testable in the `node` vitest env (no DOM renderer needed).

### Tests

- `test/unit/safe-dispose.test.ts` — null/non-disposable no-op, success path, a
  throwing `dispose()` is swallowed (using the real `_isDisposed` error shape), and
  `disposeTerminal` order (addons-before-terminal, throw doesn't abort the rest).
- `test/unit/error-boundary.test.ts` — initial healthy state, derive-from-error (incl.
  non-Error normalization and the real WebGL throw), fallback gating, message fallback.

### Runtime proof

Reproduced the original crash in the Playwright preview (Chrome/swiftshader, the env
where the WebGL teardown actually throws): a host stub broadcast a **running** session
(mounts `TerminalPane` + WebGL), then dropped to **zero** sessions (unmounts). Result
**with the guards**: the console shows
`[conduit] xterm addon dispose threw (ignored): Cannot read properties of undefined
(reading '_isDisposed')` — the exact crash fired but was **caught**, not propagated.
The root stayed fully rendered on the editor empty start state (the error boundary did
**not** need to trip; the dispose guard alone caught it). Zero app-level console errors
(only an unrelated `favicon.ico` 404). The boundary is the second-line net for any
crash the dispose guard doesn't cover.

### Manual confirmation (real Electron app)

Preview runs swiftshader; the real app's GPU path may differ. The dispose guard and
boundary are environment-agnostic, but a final manual check in the packaged Electron
app — open a real session, then close the last one — is worth doing to confirm no
black screen there.

