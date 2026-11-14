# d3 · Inbox: no overlays at all

| Pattern | Its one job |
|---|---|
| **Inbox panel** (right pane, toggled from the top bar) | The one place anything arrives: requests (Approve · Answer · Review), problems, updates and results of your own actions, newest first, with filters |
| **Task tab** (centre, beside the session it belongs to) | Every focused task: answering a request, starting a session, fixing a problem. Close it or finish the task and it goes away |
| **Marks** | The only signals outside the Inbox: the unread count on the Inbox toggle, `N need you` / `⚠ N problem` / update / service state on the status bar, and a tag on the session's own tab |

1. Things arrive: four items land in the Inbox, and claude-3's tab gets a `◉ 1 request` tag. The dictation keeps going into the terminal, untouched.
2. Answering: clicking app lane's item opens an `Answer · app lane` tab next to its terminal tab, with the A/B options, a free-text field for dictation, the context, and Send / Later.
3. New session: a `New session` tab with the same layout (launcher, space, folders, role brief, Launches as). It's a draft, so you can switch tabs and come back to it.
4. Something is wrong: both problems are in the Inbox. The service problem cleared itself; api-server's opens a `Problem · api-server` tab with the output, Retry launch / Discard. Its terminal tab says `⚠ not running`, and the status bar shows the problem count and the service state. No banner.

Decisions for the owner: the Inbox replaces the floating stack, the toasts, the server banner, the request pop-up and the dialogs, and it absorbs Needs you (that count stays on the status bar). The cost is that a quick approval takes two clicks, Inbox then tab. Notifications come with no preview unless the Inbox is open. The sidebar is locked, so its existing ◉ marks stand in for the sidebar-row marks.
