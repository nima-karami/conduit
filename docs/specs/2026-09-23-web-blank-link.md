---
status: active
date: 2026-09-23
---

# Feature Spec: `target=_blank` links open an in-app web tab

**Tier:** LITE   **Feature type:** UI (host routing + one renderer message; no new chrome)
Autonomous mode. Locked by the conductor: L1 a real left-click on a `target=_blank` http(s) link in
an in-app web tab opens a new **foreground** web tab owned by the same session; middle-click keeps
its background behaviour; Ctrl/Meta+click keeps going to the system browser. L2 only with a real
gesture seen by the HOST in the guest's own `input-event` stream (≤300 ms, one open per gesture);
the handler always returns `deny`. L3 HTML-preview guests untouched. L4 enabling popups widens
nothing else.

## 1. Problem frame

Clicking a `target=_blank` link (docs sites, GitHub "open in new tab" links) inside a web tab does
nothing. Success: that click opens the page as a new active web tab; nothing newly reachable
(script `window.open`, `el.click()`) creates a tab without a real gesture, and nothing newly
reachable ever reaches the system browser. (The pre-existing `background-tab` → system browser
path, which a script-dispatched Ctrl-click can already use, is unchanged — middle-click spec S14.)
Non-goals: popups as real windows; `window.open` return values; preview guests; a popup-blocked UI.

## 2. Current behaviour (measured)

Probe: standalone Electron 43.3.0 (repo binary), hidden window, `<webview>` over a local http
server, real input via `guest.sendInputEvent`, a logging `setWindowOpenHandler` that denies.

| # | Input | Popups off (today) | Popups on (host `disablePopups=false`) |
|---|---|---|---|
| M1 | left-click `target=_blank` | **handler never called** | `foreground-tab` |
| M2 | Shift+click plain link | `new-window` | `new-window` |
| M3 | Ctrl+Shift+click plain link | `foreground-tab` | `foreground-tab` |
| M4 | Ctrl+click plain link | `background-tab` | `background-tab` |
| M5 | left-click button → `window.open(u)` | never called | `foreground-tab` |
| M6 | script `window.open(u)`, no gesture | never called | `foreground-tab` |
| M7 | script `window.open(u,'x','width=300')` | never called | `new-window`, frameName `x` |
| M8 | script `a.click()` (with or without activation) | never called | `foreground-tab` |
| M9 | keyboard Enter on focused `_blank` link | never called | `foreground-tab` |

- M10: `will-attach-webview` receives `webPreferences.disablePopups === true` when the element has
  no `allowpopups`; setting it to `false` **in the host** behaves exactly like the attribute (M1–M9
  identical in both runs). So the host can own the switch; no renderer attribute is needed.
- M11: with popups on and the handler returning `deny`, no window is created (`BrowserWindow`
  count stayed 1, `did-create-window` never fired) in all nine cases.
- M12: the guest's `input-event` reports mouse events with **empty `modifiers`** even when the
  page saw Ctrl/Shift; `rawKeyDown` `Enter` is reported.
- Consequence: once popups are on, M3/M6/M8 are indistinguishable from M1 in `HandlerDetails`
  (same disposition, empty frameName/features). Only the host's gesture record can separate them.
- ASSUMED (Electron source, not run; `electron.d.ts` documents `allowpopups` only as "the guest
  page will be allowed to open new windows"): `disablePopups` is read only by `CanCreateWindow`.
  What it changed was measured: M1/M5–M9 now reach the handler; M2–M4 are identical; M11.

## 3. Contract

**Attach** (`hardenWebviewPrefs`): `disablePopups = !isHttpUrl(src)`, overriding whatever the
renderer's element asked for. http(s) guests may reach the open handler; preview guests are
forced to `true` (today's value, now host-owned). The value is fixed at attach, so it stays right
only while `will-navigate` keeps web guests on http(s) and preview guests on preview.

**Gate** (`createGuestOpenGate()` in `src/webview-guard.ts`, one per guest, fed by the host's
`input-event`): `middleAt` = last `mouseUp` middle (unchanged); `activationAt` = last `mouseUp`
left **or** `rawKeyDown`/`keyDown` `Enter` (both fire for one press; harmless). Fresh = ≤300 ms.

| disposition | Condition | Route |
|---|---|---|
| `background-tab` | http(s) + fresh middle | in-app-background |
| `background-tab` | otherwise | external (unchanged, pre-existing path) |
| `foreground-tab`, `new-window`, `new-popup` | http(s) + fresh activation | in-app-foreground |
| `foreground-tab`, `new-window`, `new-popup` | otherwise (no gesture, or `mailto:`, `about:blank`, `javascript:`, …) | **deny** |
| `default`, `other`, anything unknown | always | **deny** |

Every route other than `deny` **consumes both** gestures, so one gesture buys at most one open.
Nothing newly reachable routes to `openExternalUrl`. The handler still returns `deny` always.

**Host → renderer:** `web:openBackgroundTab` is renamed `web:openTab { guestId, url, background }`
(`src/protocol.ts`, `electron/main.ts`, e2e comment). `WebView`'s `onOpenInBackground` becomes
`onOpenLink(url, background)`; center-pane maps it to
`openWeb(url, d.sessionId, background ? 'background' : undefined)`. Preview branch unchanged.

## 4. Edge cases

- One gesture, two opens (page `onclick` `window.open` + the link's own `_blank`): the first to
  reach the host wins — normally the page's `window.open`, since `onclick` runs before the default
  action — and the second is denied.
- A real Ctrl+click sets `activationAt` (M12); its own `background-tab` open consumes it.
- URL already open as a web tab (same exact string; `idOf` keys by path, no URL normalisation):
  the reducer activates it, no duplicate. A `_blank` link to the current page re-activates itself.
- Only the visible web tab can receive real input, so the owner is the displayed session.
- An open landing while a Retried guest has not yet re-adopted its id is dropped (as middle-click).
- Stale gesture (>300 ms): a script open after a click is denied.

## 5. Decisions Needed

- **[normal] D1 Shift+click and Ctrl/Cmd+Shift+click now open an in-app foreground tab**, not the
  system browser (M2/M3 are indistinguishable from page `window.open`, and M12 hides modifiers).
  Routing them external would let any real click plus page script launch the OS browser with a
  page-chosen URL. Plain Ctrl+click still goes external (L1).
- **[normal] D2 Keyboard Enter counts as a gesture** (beyond L2's "left mouseUp") so Enter on a
  focused `_blank` link works (M9). Space on a button is not counted (unmeasured); gap accepted.
- **[normal] D3 Narrowing:** non-http(s) `_blank`/Shift/Ctrl+Shift opens (e.g. `mailto:`) and
  script-dispatched Shift/Ctrl+Shift clicks went external before; now denied. Plain `mailto:`
  links in a web tab are already blocked by `will-navigate`.
- **[normal] D4 Residual, unchanged reach:** during a real Ctrl+click, a page's `onclick`
  `window.open` is also `background-tab` and goes external — the same reach as the page choosing
  that link's `href`.

## 6. UI checklist

States: no new UI; the new tab is the normal web tab (loading → titled → error panel on failure).
a11y: keyboard parity via D2; focus follows the existing foreground web-open path (not changed
here). i18n: no strings. Tokens: none. No overlay over `.topbar`.

## 7. Acceptance criteria

- **AC1** Real left-click on a `_blank` http link: exactly one new web tab, **active**, owned by
  the same session; `openExternal` 0. (Also measures that the left `mouseUp` reaches `input-event`
  before the open handler.)
- **AC2** Real middle-click: background tab as before (middle-click-web e2e stays green).
- **AC3** Real Ctrl+click: `openExternal` once, no tab (unchanged).
- **AC4** Script `window.open(u)`, `window.open(u,'x','width=300')` and `a.click()` with no real
  gesture: no tab, `openExternal` 0, no extra BrowserWindow.
- **AC5** Real Enter on a focused `_blank` link: one new active tab.
- **AC6** Preview guests: attach forces `disablePopups=true` (unit, incl. a renderer asking for
  `false`); their handler branch is untouched.
- **AC7** Unit: the §3 table for every disposition, non-http cases, the 300/301 ms boundary, one
  open per gesture.
