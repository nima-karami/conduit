# Terminal ergonomics (L4)

The terminal (`webview/components/terminal-pane.tsx` — xterm.js + fit + WebGL
addons, PTY over the host bridge) is the app's core surface but had zero
ergonomics. This adds find-in-terminal, clear, and a right-click context menu,
all reusing existing primitives (portal `ContextMenu`, toast store, guarded
`disposeTerminal`).

## 1. Find in terminal

- **Addon:** `@xterm/addon-search` pinned `^0.15.0` — the release line built for
  the installed `@xterm/xterm@^5.5.0` (peer `@xterm/xterm@^5.0.0`). Matches the
  caret style of the sibling addons (`addon-fit ^0.10.0`, `addon-webgl ^0.19.0`).
- **Overlay:** `webview/components/term-search-bar.tsx` — a small find bar
  (input + prev/next + close) absolutely positioned top-right inside `.termhost__body`.
  Styled with the existing menu/overlay tokens (`--panel-2`, `--border-2`,
  `--accent-soft`) — same visual language as `.ctxmenu`.
- **State machine** is a pure module, `webview/term-search.ts`
  (`termSearchReducer`), unit-tested: open / close / setQuery / next / prev. The
  component is a thin shell binding the reducer to the `SearchAddon`
  (`findNext` / `findPrevious`).

### Scoping (the key decision)

Mod+F is **terminal-local only**. It is NOT added to `shortcuts.ts`
(`SHORTCUT_ACTIONS`) — that registry is the global window-level handler in
`app.tsx`, and Monaco already owns Mod+F when the editor has focus. Adding a
global Mod+F would either fight Monaco or fire when no terminal is focused.

Instead the open is a `keydown` handler on the terminal container
(`.termhost__body`, capture phase). It only triggers when the keydown originates
from inside that container (the terminal/its overlay has focus), so each terminal
pane opens **its own** find bar and nothing else. This mirrors the existing
typing-guard philosophy ("Monaco handles its own"): scope the binding to where
focus is rather than globally gating.

- **Enter** = next, **Shift+Enter** = prev, **Escape** = close + refocus the
  terminal. These are handled on the input element itself (not globally).
- xterm's own keybinding for the focused terminal never sees Mod+F because the
  container handler `preventDefault`s and stops it before xterm's `onData`.

## 2. Clear

`term.clear()` — keeps the current prompt line, drops scrollback. Reachable from
the context menu. Not added as a palette command: the palette has no clean handle
on "the active terminal" (sessions can be split; the palette targets docs), so a
terminal-scoped action belongs on the terminal's own menu, not the global palette.

## 3. Right-click context menu

Built by a pure builder `buildTerminalMenuItems(ctx)` in
`webview/term-menu.ts` (unit-tested), consumed by the shared portal
`ContextMenu` (`webview/components/context-menu.tsx`). Items:

- **Copy** — enabled only when `term.hasSelection()`; copies `term.getSelection()`
  to the clipboard.
- **Paste** — reads `navigator.clipboard.readText()` (guarded) and writes the
  text to the PTY through the existing input path (`post({ type: 'term:input' })`).
  On failure (no clipboard API / permission denied / browser preview) it raises an
  error toast via `pushToast` rather than throwing. The menu item is disabled when
  `canPaste` is false (no clipboard API present at menu-open time).
- **Clear** — `term.clear()`.
- **Find** — opens the find bar.

### xterm right-click handling (the gotcha)

xterm attaches its own `contextmenu`/`mousedown` handling and on Windows the
right mouse button can extend/alter the selection before the menu opens. To keep
the menu predictable:

- The `contextmenu` listener is attached to the **container** (`.termhost__body`),
  not the xterm canvas, and calls `preventDefault()` so neither the OS menu nor
  xterm's default fires.
- We snapshot `hasSelection()` at the moment the menu opens (before any
  right-click selection mutation can matter) and build the item enablement from
  that snapshot — so "Copy" reflects the selection the user sees.
- xterm's `rightClickSelectsWord` option is left at its default (false); we do not
  enable word-select-on-right-click, so right-click is purely "open menu".

## 4. Teardown safety

The `SearchAddon` is registered in the **same** guarded teardown path as the
other addons: `disposeTerminal(term, [webgl, fit, search])`
(`webview/components/safe-dispose.ts`). Addons are disposed before the terminal,
each isolated, so a throw in any one (historically the WebGL addon's dispose,
which caused a black-screen regression) cannot skip the others or escape React
cleanup. The search addon is added to the existing addon array — no new teardown
code path.

## Tests (pure logic)

- `test/unit/term-search.test.ts` — reducer state machine: open/close/query/nav,
  query preserved across nav, close resets.
- `test/unit/term-menu.test.ts` — menu item list + enablement rules (Copy gated by
  selection, Paste gated by clipboard availability, stable order).

## Preview note

The browser-preview fake shell (`webview/bridge.ts`) mounts a real xterm with a
mocked PTY echo, so the find bar, context menu, and clear are all drivable for
screenshots. Paste in preview surfaces the guarded clipboard path (permission
prompt / error toast) — that is expected; the real PTY exists only in the app.
