# d2 · Bars and pop-ups
| Pattern | Its one job |
|---|---|
| **Bar item** (top bar = window, session bar = one session, status bar = whole app) | Show a count or state, and be the way in. Problems are bar items too: there are no banners |
| **Pop-up** | Hold one decision or focused task, attached to the item you clicked. No scrim, never centred |
| **Tab** | Long work: any pop-up's ⤢ opens the same content as a tab |
| **Panel** | Lists (Needs you, Changes, Messages, Files), opened from the top bar |
| **Toast** | Results of your own actions only (a send, a timed message you scheduled) |

1. Things arrive: the status bar "◉ 2 need you" and "↑ Update ready" change, claude-3's session bar gets "◉ Approve", and a toast says your timed message reached api-server. Nothing opens and the caret stays in the terminal.
2. Answering: click "2 need you" and a pop-up attached to it shows codex-4's A/B question (Header · Context · Answer · Footer) with an own-words field. The Needs you panel is the list.
3. New session: the sessions-header + opens a pop-up beside the sidebar (CLI, folders, space, role brief), with ⤢ for a tab. The toast confirms the answer from screen 2.
4. Something wrong: the status bar shows "⟳ Background service restarted · 7 of 8 terminals back" and clears by itself. api-server's session bar shows "✕ Launch failed", and its pop-up has Retry launch / Discard.

Decisions for the owner: (a) A session bar sits above every terminal: it's the one new strip, and it carries per-session state, including "◌ Reconnecting — input paused". (b) The Needs you count stays only in the status bar, and the top-bar "Needs you" toggle has no count. (c) The update is a status bar item, not a card. (d) Dialogs such as Settings and Confirm become pop-ups or tabs, so there's no centred modal at all.
