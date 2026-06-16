# Conduit — Wishlist (inbox)

Raw, un-triaged ideas land here first. This is an **inbox, not a tracker** — it
holds things that haven't been built yet. Once an item is picked up it leaves
this file:

- **Promoted** → a spec in `docs/specs/` (see `docs/specs/INDEX.md`).
- **Shipped** → recorded in `docs/runs/<date>-<name>/report.md` with evidence + SHAs.
- **In a live build** → tracked in `.autoloop/tasks.yaml` (run state, gitignored).

So don't track status here — delete an item once it moves on. History of what
shipped lives in `docs/runs/`, not here.

## Captured

Daily-driver batch (2026-06-16, user list). Goal lens: [[conduit-daily-driver-goal]] —
make Conduit usable enough to live in. Triage / clustering at the bottom.

- **D1 · collapse-all (drop expand toggle).** Files view: the expand/collapse toggle's
  "expand" only expands already-loaded folders (useless). Replace the toggle with a single
  **Collapse all folders** action; remove expand.
- **D2 · Reveal in Explorer opens the folder itself.** Today `shell.showItemInFolder(path)`
  opens the *parent* and selects the folder. For a directory use `shell.openPath` (open the
  folder); keep `showItemInFolder` for files. (`electron/main.ts:452`)
- **D3 · Session icon: fix double-icon + user-chosen icon (DESIGN THIS PROPERLY).** The
  launched-app icon (e.g. Claude Code) doesn't replace the terminal/PowerShell glyph — both
  show; fix that first. Then add a **"Set icon"** entry to the session tab context menu opening
  an **icon-picker modal**. Requirements (user, explicit — do NOT cut corners, make it elegant):
  - **Full [Lucide](https://lucide.dev) icon set** (`lucide-react`), not a hand-picked few.
    Use **dynamic import** (`lucide-react/dynamicIconImports`) so the full set isn't bundled
    eagerly / doesn't blow the bundle or the dead-code gate.
  - **Categories** — group icons by Lucide's category/tag metadata, browsable as sections.
  - **Search bar at the top** filtering across the whole set by **name + tags** (Lucide ships
    per-icon tags), with sensible debounce and keyboard nav.
  - Polished, elegant layout: virtualized/paged grid (1000+ icons), hover labels, current
    selection highlighted, clear/reset to the auto-derived icon, esc-to-close, reduced-motion
    safe — consistent with the existing modal styling (`settings-modal`/`new-session-modal`).
  - The chosen icon is a **per-session override** persisted on the session (an icon *name*
    string); falls back to the auto-derived `iconForSession` kind when unset.
  - Rendering: `SessionGlyph` must render either the existing kind-glyph OR a Lucide icon by
    name; keep D4's status states working over both. (`src/session-icon.ts`,
    `webview/components/sidebar.tsx`, `webview/icons.tsx`)
- **D4 · Fold the status dot into the session icon.** Retire the separate green/blue/grey
  dot; express status on the icon itself: not-running = greyed, actively-working
  ("combobulating…") = pulsing, plus any other needed states (idle, needs-attention).
  Pairs with D3 (one icon rework). Ties to the busy/needs-attention machine in
  `electron/main.ts:217`.
- **D5 · Drag-and-drop files/folders in the Files view**, with modifier keys (Ctrl/Shift/Alt)
  to vary behavior (e.g. copy vs move vs link) — standard file-manager DnD. Host fs moves
  must go through the existing path-guard (`src/path-guard.ts`). Expand the modifier matrix
  to platform-standard semantics.
- **D6 · Long file path overflows the session card.** Constrain/ellipsize so a long
  `projectPath` can't flow outside the card.
- **D7 · Search-match jump works in rendered Markdown view, not just the editor.** Clicking a
  search hit (`file.md > 115`) scrolls to/highlights the match in the editor but does nothing
  in markdown *rendered* view. Map the match to the rendered output and scroll/anchor to it.
  (`webview/components/markdown-viewer.tsx`; reuse the `setReveal`/`takeReveal` seam.)
- **D8 · Changes tab attention indicator when inactive.** If a session has git changes, the
  **Changes** tab should signal "needs attention" even when another tab (e.g. Files) is
  active — a badge/dot, not just visible once you're on it.
- **D9 · Hide the close "✕" while renaming a session.** During inline rename the close button
  appears and looks like a cancel affordance but actually *closes the session*. Suppress the
  ✕ (and any close hit-target) for the duration of the rename.
- **D10 · Per-session file opening + per-session recents.** Global search → clicking a file
  that belongs to a *non-active* session opens it in the **current** session; it should open
  in (and switch to) its **owning** session. Further: the **recent-files list is currently
  global** (`app.tsx:109`) — make recents **per-session** so two sessions' `CLAUDE.md`
  entries don't collide. Builds on the round-8 editor-per-session model.

- **T1A · OS-level attention routing (Tier-1, user-approved for this batch).** When a session
  finishes work or blocks on input while Conduit is **backgrounded/hidden**, raise OS
  attention: **taskbar flash** (`win.flashFrame(true)`), an **OS notification**
  (Electron `Notification`), and optionally a **tray/overlay badge** (`win.setOverlayIcon` /
  `app.setBadgeCount`). Drive it off the existing busy→idle "needs-attention" edge
  (`electron/main.ts:217`) but **only when the window is not focused** (and clear on focus).
  Make it setting-gated (on by default). None of the OS-notification plumbing exists yet
  (verified: no `flashFrame`/`Notification`/`Tray`). See [[conduit-daily-driver-goal]].
- **T1B · Session durability across restart (Tier-1, user-approved — after T1A).** Today
  `src/persistence.ts` restores sessions as `status: 'stale'` (PTY gone, scrollback lost,
  manual relaunch). Make a restart not lose your running agents: **auto-relaunch stale
  sessions on open** (with a clear "restarted" marker) and/or **persist & restore each
  session's scrollback** so a relaunch shows its history. At minimum a one-click "relaunch
  all stale". Relaunch IPC already exists (`electron/main.ts:428`).

### Triage & clustering (build order)

Daily-driver friction, grouped by shared code so a build can batch them:

1. **Quick papercuts (low risk, high felt-value — do first):** D1, D2, D6, D9. Independent,
   small, each touches one spot.
2. **Per-session correctness:** D10 (open-in-owning-session + per-session recents) and
   **D8** (Changes-tab attention) — things you hit every session; D8 is the in-app slice of
   my "attention routing" theme.
3. **Session-icon rework (one coherent feature):** D3 + D4 together — custom icon + status
   folded into the icon. Biggest of the batch but the thing you stare at all day.
4. **Search depth:** D7 (markdown rendered-view jump).
5. **File DnD:** D5 — largest/riskiest (host fs mutations + DnD UX); do last and verify on the
   real app, not just the mock (see [[playwright-electron-real-app-verification]]).
6. **Tier-1 trust (user-approved for this batch):** **T1A** OS attention routing *first*, then
   **T1B** session durability. Both are mostly host/pure-logic; both want real-app
   verification (notifications + relaunch cross the Electron boundary the mock can't exercise).

Recommended overall order: cluster 1 (D1/D2/D6/D9) → **T1A** → cluster 2 (D10/D8) → cluster 3
(D3/D4 icon rework) → D7 → **T1B** → D5. (T1A early because it's high-value and pairs with the
D4/D8 attention work; T1B and D5 last because they most need real-app smoke.)

_Prior batches (round-6/7, 2026-06-15) shipped — see `docs/runs/2026-06-15-wishlist-r6/` and
`-r7/`. Open follow-ups live in those reports (r7's "rename Conduit→Claude Code" deferred as a
keystroke-injection footgun; the CLI-/rename ambient-title tradeoff; focus-restore-flash human
smoke)._
