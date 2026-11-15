# d1 · sheets: five patterns, one job each

| Pattern | Its one job |
|---|---|
| **panel** | Lists and context in a side pane (Needs you, Changes, Files, Messages) |
| **tab** | Long work in the centre; any sheet becomes one with ⇱ Open as tab |
| **sheet** | One focused task over the centre only, opened only by your click (answer a request, New session) |
| **notice** | A one-line strip where the problem is (window, session or status bar), with its fix button |
| **toast** | Only the result of your own action, plus Undo when it can be undone |

1. Things arrive: the count goes to 2 need you. claude-3's approval is a session notice above its terminal. codex-4's A/B question shows only as the count and its sidebar row. The sent timed message is a toast. The update is a status-bar notice. Focus stays in the terminal.
2. Answering: the count opens the Needs you panel. Clicking app lane opens an Answer sheet: quoted ask, A/B with reasons, and a free-text field for dictation. Send + next. The panel and sidebar stay usable.
3. New session: the same sheet shape, with Launch, Space, Folders, Role brief, Launches as and Cancel / Start session. Starting it closes the sheet and shows a toast with Undo.
4. Something is wrong: a window notice (service restarted, clears by itself), session notices (Reconnecting, input paused; api-server's Retry launch / Discard), and a status-bar notice ("1 session didn't start · Show"). No sheet, no toast.

Owner decisions: (a) the update and a failed launch are notices, not requests. Needs you only holds what an agent is blocked on. (b) A toast with nothing to undo (a sent message) has no Undo button. (c) A sheet dims only the centre, never the sidebar or panes. (d) The window notice takes a second line in the top bar, so the layout shifts down while it's showing.
