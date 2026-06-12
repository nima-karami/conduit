# Spec: menu-toggle-on-trigger

**Status:** Implemented (branch `r3/menu-toggle-on-trigger`)

## Problem

When a button-anchored context menu (e.g. the sessions sort/filter three-dot) is
open and the user clicks its trigger button again, the menu closes and immediately
**reopens** instead of staying closed. The user has to click elsewhere to dismiss.

**Root cause:** `ContextMenu` closes on `mousedown` (capture phase). The trigger
button's `click` event fires after `mousedown`, so the sequence on second click
was:

1. `mousedown` (capture) → ContextMenu's dismiss listener → `onClose()` → menu
   state set to `null`
2. `click` → trigger's `onClick` → unconditionally calls `setMenu(...)` → menu
   reopens

## Mechanism chosen: `triggerRef` prop + `menuToggleIntent` helper

**Single shared implementation** — no per-call-site copy-paste.

### `ContextMenu` change (`webview/components/context-menu.tsx`)

Added optional `triggerRef?: RefObject<Element | null>` prop. The `mousedown`
dismiss listener now skips close when the event target is inside `triggerRef.current`:

```ts
if (triggerRef?.current?.contains(target)) return;
```

This means the menu stays open through the mousedown on the trigger, and the
trigger's `onClick` can observe the true pre-click open state.

### Pure helper (`src/menu-toggle.ts`)

```ts
export function menuToggleIntent(wasOpenAtMousedown: boolean): 'open' | 'close'
```

Deterministic, DOM-free, fully unit-tested. The trigger's `onMouseDown` snapshots
`menu !== null` into a ref; `onClick` calls `menuToggleIntent(wasOpenRef.current)`
and opens or stays-closed accordingly.

### Toggle protocol at the call site

```
onMouseDown → wasOpenRef.current = menu !== null
onClick     → if menuToggleIntent(wasOpenRef.current) === 'close': setMenu(null); return
             else: build items + setMenu({ ... })
```

## Call sites audited

| Trigger type | Location | Button-anchored? | Fixed? |
|---|---|---|---|
| Sessions sort/filter three-dot | `webview/components/sidebar.tsx` | Yes | Yes |
| Session right-click context menu | `webview/app.tsx` `onSessionContextMenu` | No (cursor) | N/A |
| Doc tab right-click context menu | `webview/app.tsx` `onTabContextMenu` | No (cursor) | N/A |
| File tree right-click | `webview/components/right-pane.tsx` | No (cursor) | N/A |
| Change row right-click | `webview/components/right-pane.tsx` | No (cursor) | N/A |
| Architecture canvas node/pane right-click | `webview/components/architecture-view.tsx` | No (cursor) | N/A |
| Board card right-click | `webview/components/board-view.tsx` | No (cursor) | N/A |
| Panel show/hide (right-click panel surface) | `webview/app.tsx` `onPanelTogglesMenu` | No (cursor) | N/A |

Only the sessions sort/filter three-dot is a **button-anchored** menu. All other
menus open at the cursor coordinates of a right-click or contextmenu event, so
the dismiss→reopen race cannot occur (the trigger is not a button with an onClick).

## Files touched

- `src/menu-toggle.ts` — new pure helper
- `test/unit/menu-toggle.test.ts` — 4 unit tests
- `webview/components/context-menu.tsx` — `triggerRef` prop + guard in dismiss handler
- `webview/components/sidebar.tsx` — trigger ref, `onMouseDown` snapshot, toggle handler

## Tests

Baseline: 632. After: 636 (+4 unit tests for `menuToggleIntent`).
Gates: `npm run verify` ✓  `npm run build` ✓
