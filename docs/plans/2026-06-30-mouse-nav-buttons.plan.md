# Plan: VS Code-style mouse buttons (middle-click close, thumb/keyboard Back/Forward)

Spec: `docs/specs/2026-06-30-mouse-nav-buttons.md`. The nav subsystem already exists; this builds only the input edges + reducer hardenings. Test-first throughout.

## Step 1 — Reducer hardenings (`src/nav-history.ts`)
- Add `export type IsAlive = (loc: NavLoc) => boolean;` and `export const NAV_STACK_CAP = 50;`.
- `back`/`forward` take an optional `isAlive`; step in the direction skipping `!isAlive` entries, landing on the nearest live one, else return state unchanged (no index move). Omitted `isAlive` = single-step identical to today.
- `record` caps the stack at `NAV_STACK_CAP`, dropping oldest and decrementing index.
- **Tests (extend `test/unit/nav-history.test.ts`):** existing pass unchanged; single-dead skip back/forward; run-of-dead; all-dead → no-op (index unchanged); dead at multiple occurrences; cap evicts oldest with index pointing at tip; cap + back reaches exactly 50 most-recent.

## Step 2 — Hook threads liveness (`webview/use-nav-history.ts`)
- `useNavHistory(loc, apply, isAlive?)`; `goBack`/`goForward` pass `isAlive` to `back`/`forward`, detect no-op via `next === s`, set `navigating` only on a real move.

## Step 3 — App wiring (`webview/app.tsx`)
- Build `isAlive(loc)`: session present in `sessions` AND (docId null OR a doc with that id exists). Pass to `useNavHistory`.
- Drop `applyNav`'s dead-docId fallback (landed loc is guaranteed alive) — apply `l.docId` directly.
- `isAnyModalOpen` predicate over palette/settingsOpen/menu/confirm/newSession/webPromptOpen/iconPicker.
- Window-level **capture** listeners (mousedown + auxclick): buttons 3→goBack, 4→goForward; `preventDefault` on the triggering events; suppressed when `isAnyModalOpen` or focus is inside the `<webview>` guest; **gated off on Windows** for buttons 3/4 (host app-command is authoritative there).
- New `subscribe` effect for `{type:'appCommand'}` → goBack/goForward (same modal guard; no webview-focus gate — the guest can't surface app-command to the host window in a way that should be ignored, and on Windows it is the sole source).
- `actionMap.navBack=goBack`, `actionMap.navForward=goForward`.
- aria-live polite region announcing landed location on each traversal (reuse pattern).

## Step 4 — Keyboard parity (`webview/shortcuts.ts`)
- Add `navBack` (Alt+ArrowLeft) and `navForward` (Alt+ArrowRight) to `SHORTCUT_ACTIONS`; add `isWindows`.

## Step 5 — Middle-click close (`webview/components/doc-tabs.tsx`)
- `onAuxClick` (button===1) on the doc tab `<div>` → `onClose(d.id)`. Terminal `<button>` untouched.

## Step 6 — Middle-click explorer file (`webview/components/right-pane.tsx`)
- `onAuxClick` (button===1, file only) → `onOpenFile(node.path, 'permanent')`.

## Step 7 — Host app-command (`electron/main.ts`, `src/protocol.ts`)
- `HostToWebview` gains `{ type:'appCommand'; command:'back'|'forward' }`.
- `createWindow`: `w.on('app-command', …)` forwards `browser-backward/forward` to `w.webContents` via `to-webview`. Per-window.

## Step 8 — e2e (write, do NOT run): `test/e2e/mouse-nav.e2e.mjs`
- Middle-click clean tab closes; dirty tab → confirm; Alt+Left/Right traverse; middle-click explorer file → permanent. Physical thumb + Windows app-command = human-smoke (header note).

## Step 9 — Verify
- `npm run verify` to EXIT 0 in the worktree; commit.
</content>
</invoke>
