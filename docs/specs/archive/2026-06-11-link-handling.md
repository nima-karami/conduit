# Spec — Link handling (wishlist E4)

**Tier:** LITE · **Type:** UI · **Slug:** link-handling

## Problem frame

**Job:** When I click a link inside the code editor / rendered Markdown, I want to
follow it **without losing my place** — the app must stay where it is.

**Today (bug):** Clicking a link navigates the whole Electron `BrowserWindow` to the
URL. The renderer (the entire app UI) is replaced by a chrome-less page: full screen,
no back button, no window menu (`autoHideMenuBar: true`, custom title bar) — the user
is stranded with no way back.

**Root cause:** `electron/main.ts` creates the `BrowserWindow` but never installs
`setWindowOpenHandler` or a `will-navigate` guard, so Electron's default in-window
navigation takes over on any `<a href>` activation rendered by `react-markdown`
(`webview/components/markdown-viewer.tsx`, which passes no custom `a` renderer).

**Actors:** Desktop-app user viewing a Markdown file with links.

**Success outcome:** External (`http`/`https`) links open in the user's real default
browser; the app window never navigates away; the editor stays exactly as it was.

**Non-goals:** Building an in-app browser/tab with its own chrome; handling `mailto:`
beyond delegating to the OS; deep-linking `file://` or in-repo doc navigation
(parked — see Out of Scope).

## Behavior & states

A link activation (click, or `window.open`) is classified by URL:

- **External** (`http:` / `https:`): open in the OS default browser via
  `shell.openExternal`; **prevent** the in-window navigation. App is untouched.
- **Other schemes** (`mailto:`, `tel:`, etc.): also delegated to the OS via
  `shell.openExternal` (the OS picks the handler); in-window navigation prevented.
- **Relative / hash / empty / `javascript:`**: do nothing special — never open
  externally, never navigate the window away. (Hash/relative are not meaningful in a
  `loadFile` app; treat as no-op rather than a destructive navigation.)

Two layers, defense in depth:

1. **Host guard (the real fix).** In `main.ts`, on the window's `webContents`:
   - `setWindowOpenHandler` → for `http/https` call `shell.openExternal` and return
     `{ action: 'deny' }`; deny everything else too (never spawn a chrome-less child
     window).
   - `will-navigate` → for any URL that is not the app's own loaded file, call
     `event.preventDefault()`; if `http/https`, also `shell.openExternal`.
   This makes the bug impossible regardless of renderer code.
2. **Renderer path (clean UX + correct for Markdown).** A custom `a` renderer in the
   Markdown viewer intercepts clicks, classifies the URL with a pure function, and
   for external URLs calls a new `openExternal` bridge method, calling
   `preventDefault()`. Guards for `window.agentDeck` undefined (plain-browser
   preview): falls back to a normal `target="_blank" rel="noreferrer"` anchor so
   preview still works and nothing is destructive.

## Data / interface contract

**Pure classifier** (`webview/links.ts`):
`classifyLink(href: string): 'external' | 'os' | 'ignore'`
- `external` → `http:`/`https:` absolute URL.
- `os` → other absolute scheme with a host/target the OS can handle (`mailto:`,
  `tel:`, etc.).
- `ignore` → empty, hash (`#…`), relative (no scheme), or `javascript:`.

**Bridge addition** (`electron/preload.ts` → `window.agentDeck.openExternal`):
`openExternal(url: string): void` → `ipcRenderer.send('open-external', url)`.

**Host handler** (`electron/main.ts`): `ipcMain.on('open-external', (_e, url) => …)`
validates `url` is `http/https` (or an allowed OS scheme) before
`shell.openExternal` — never pass arbitrary strings (`file:`/local-exec safety).

## Edge cases & failure modes

- `window.agentDeck` undefined (preview) → renderer falls back to plain anchor; no
  crash.
- `null`/empty/whitespace href → `ignore`, no-op.
- `javascript:` URL → `ignore` (never executed, never opened).
- Malformed URL that throws in `new URL()` → treated as `ignore` (no throw escapes).
- Untrusted scheme reaching the host IPC → host re-validates scheme allowlist before
  `openExternal`; drops anything else.
- Middle-click / ctrl-click → handled the same (still non-destructive; opens
  external once).

## Defaults vs settings

- **Default:** external links open in the real browser. No setting — this is the
  single safe, expected desktop behavior. (Rationale: a toggle for "where links
  open" is a divergent preference few want; adding it now is over-production.)

## Scope slicing

- **MVP (this pass):** host guard + renderer bridge path + pure classifier + unit
  test. External links non-destructive.
- **Out of scope:** in-app browser tab with chrome; `file://`/in-repo doc link
  navigation inside the editor; per-link context menu ("copy link", "open in app").

## Acceptance criteria

- AC1: Clicking an `http/https` link in rendered Markdown does **not** change the app
  window's contents (editor still visible) and triggers an external-open call.
- AC2: With the host bridge present, the renderer calls `openExternal(url)` rather
  than letting the anchor navigate.
- AC3: With the host bridge **absent** (preview), no full-screen takeover occurs; the
  anchor is a normal `_blank` link and the app is intact.
- AC4: At the host layer, `will-navigate` to an external URL is prevented and routed
  to `shell.openExternal`; `setWindowOpenHandler` denies new windows.
- AC5: `classifyLink` returns `external` for `https://x.com`, `ignore` for `''`,
  `'#frag'`, `'./rel'`, `'javascript:alert(1)'`; `os` for `mailto:a@b.com`.
- AC6: Host `open-external` IPC ignores non-allowlisted schemes.

## DECISIONS

- **Chosen approach: external-open via `shell.openExternal` (NOT an in-app browser
  tab).** Why: (1) it is the standard, least-surprising desktop behavior — a user
  following an external link expects their real browser with full history/extensions;
  (2) it is the smallest, safest change that matches the existing thin-bridge
  architecture (all real capability lives in the Electron main process; renderer holds
  no state); an in-app browser would mean a new chrome-bearing view, navigation state,
  and lifecycle — disproportionate for a LITE bug fix; (3) it makes the bug
  *impossible* at the host layer (`will-navigate`/`setWindowOpenHandler`) rather than
  only papering over it in the renderer.
- **Two layers, not one.** The host guard alone fixes the destructive takeover; the
  renderer path gives the correct UX for Markdown anchors and keeps preview working.
  Both are cheap; together they are belt-and-suspenders.

## Decisions Needed

- none

## Self-audit

Core spine: problem frame ✓, behavior/states ✓, contract ✓, edge cases ✓,
defaults ✓, scope ✓, acceptance ✓. UI module: states/interaction covered (link
activation, preview fallback); a11y — anchors remain real `<a>` elements (keyboard
focus/activation preserved), no custom widget introduced; i18n — no user-facing copy
added. No open template items.
