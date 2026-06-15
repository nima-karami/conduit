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

| Item | Type | Notes |
|------|------|-------|
| Copy/paste in editors **and** terminal via multiple methods — keyboard shortcuts (Ctrl/Cmd+C/V), right-click menu, standard selection — working consistently across both surfaces | Feature | Terminal right-click copy/paste landed in round 3 (L4); this is the broader "works everywhere, incl. shortcuts" pass |
| Interface font-size setting has no effect — changing it doesn't resize UI text | Bug | The setting exists but is dead |
| Increase/decrease the **font size in the terminal and editor** via keyboard shortcuts (e.g. Ctrl/Cmd +/−/0) | Feature | Distinct from the interface-font bug above: that's the UI-chrome setting; this is per-surface zoom of terminal + editor content. Shortcuts are the primary mechanism |
| Focus-restore flash — after Conduit is minimized for a long time, bringing it back to focus shows a brief flash in the background | Bug | Likely the shader/WebGL background re-initializing on restore; reproduce on un-minimize after idle |
| Session icon reflects the running app's logo — launching Claude Code (or any app with its own mark) updates that session's icon to match | Feature | For known agents, adopt the agent's icon from its definition; arbitrary apps would need detection. Pairs with the session-name item below |
| Session name syncs with the running app — adopt the app's session name on launch, and reflect an in-app rename (Claude Code `/rename`) back onto the Conduit session | Feature | Natural hook: listen to terminal title-change (OSC 0/2) escape sequences from the pty and sync the session label live |
| Markdown rendered view needs a context menu too — select / copy / paste etc. on the rendered content | Feature | Right-click menu parity for the markdown DocView surface |
| Select text in the code editor or markdown viewer/editor and **mention/reference it in the terminal** | Feature | "Eventually" — Cursor-style add-to-context / @-mention of a selection into the active agent session |
| Right-click a **terminal tab** → context menu: close/duplicate session, close that session's editor tabs, reveal the session directory in Explorer, etc. | Feature | Tab-level menu for terminal sessions (parity with editor-tab / session-card menus) |
| `'Toggle Explorer'` → `'Toggle explorer'` (sentence case) | Copy | One-line fix in `webview/shortcuts.ts:52`; every sibling label is already sentence case |
