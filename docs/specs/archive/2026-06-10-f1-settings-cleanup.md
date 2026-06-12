# F1 — Settings depth + customization cleanup

## Goal
Remove the non-functional customization buttons from the sidebar, and turn Settings
from "appearance only" into a real, organised, fully-wired settings system with
behaviour settings that actually change how the app works.

## Part A — Customization cleanup
- Remove the entire **Customizations** collapsible section from the sidebar
  (agents / skills / instructions / hooks / mcp). Not needed for now.
- Remove the now-dead threading: `customizations` prop into Sidebar, the
  `mergedCustomizations` memo in App, and the `customizations`/`customIcon` imports
  that become unused. Leave host-side count computation alone (harmless) but stop
  consuming it in the renderer.
- Sidebar now: head (Sessions + New + search) → session list (flex-grows) →
  footer (Settings). The reclaimed space goes to the session list.

## Part B — Settings system depth
New **General** tab (before Appearance) with behaviour settings, all persisted and
wired to real behaviour:

| Setting | Type | Default | Wired effect |
|---|---|---|---|
| `defaultAgentId` | select (detected shells) + "Ask each time" | '' | Seeds the terminal choice in the New-session modal when a repo has no remembered shell |
| `restoreSessions` | toggle | true | Host only restores persisted sessions on launch when true |
| `autoSwitchSession` | toggle | true | App auto-switches to a newly created session only when true |
| `confirmCloseRunning` | toggle | true | Closing a *running* session asks for confirmation first |
| `reduceMotion` | toggle | false | Disables background animation (sets data-reduce-motion; CSS halts .bgfx) |

Appearance tab keeps theme / fonts / density / background. (sessionCard control moves
to F3; leave the field in settings for now.)

## Data model (src/settings.ts)
Add fields: `defaultAgentId: string`, `restoreSessions: boolean`,
`autoSwitchSession: boolean`, `confirmCloseRunning: boolean`, `reduceMotion: boolean`.
restore() validates booleans (default-on where noted) and string.

## Host (electron/main.ts)
- Gate `mgr.restore(...)` on `settings.restoreSessions`.
- (defaultAgentId is consumed in the renderer New modal; no host change needed beyond
  it being in settings.)

## Renderer
- `SettingsProvider.applyToDom`: also set `data-reduce-motion`.
- CSS: `:root[data-reduce-motion="true"] .bgfx, ... { animation: none !important; }`.
- App auto-switch effect: respect `settings.autoSwitchSession`.
- Kill flow: when target session status === 'running' and `confirmCloseRunning`, show a
  confirm dialog (reusable `ConfirmDialog` component) before posting `kill`. Applies to
  both the sidebar kill button and the context-menu "Close session".
- NewSessionModal: when a repo has no `lastAgentId`, preselect `defaultAgentId` if set.

## New component
`webview/components/ConfirmDialog.tsx` — title, message, confirm/cancel, danger style,
Esc/backdrop to cancel, Enter to confirm. Reused later for other destructive actions.

## Acceptance criteria
1. No Customizations section renders; no console errors; session list fills the space.
2. General tab shows all 5 settings; changing each persists (settings.json) and survives reload.
3. Turning OFF auto-switch: creating a session does NOT change the active session.
4. With confirm-close ON: closing a running session shows a dialog; Cancel keeps it, Confirm removes it. With it OFF: closes immediately.
5. reduceMotion ON: background stops animating (verify computed/console) even with aurora selected.
6. restoreSessions OFF: relaunch starts with no restored (stale) sessions.
7. defaultAgentId set: New modal preselects it for a repo with no remembered shell.
8. typecheck + build clean; unit tests updated (settings restore covers new fields) and green.
