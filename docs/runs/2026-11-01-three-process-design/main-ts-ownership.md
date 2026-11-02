# `electron/main.ts` message ownership (inventory, 2026-11-01, revision 9.1)

Source: `handle()` at main.ts:2917 (switch 2927–4750), `ipcMain.on('to-host')` at 4758. Classes:
**app** stays in the app; **server** becomes a C2 call; **split** means the app does the UI part and
the server does the state part. C2 names are in `src/contracts/server-protocol.ts`.

## Server / split

| Renderer message | Line | Class | C2 |
|---|---|---|---|
| `rename`, `setSessionIcon` | 3853/3857 | server | `sessions.mutate{rename / setIconOverride}` |
| `term:title` | 3860 | removed | Titles have one producer: the server, from hc `title` events (N1). W7 removes the renderer route |
| `reorderSessions{order[]}` | 3921 | server | `sessions.reorder{order}` |
| `session:addRoot/removeRoot/setHome/setProject` | 2962–2968, 3056 | server | `sessions.mutate{…}` → `{reason?}` relayed as `session:opResult` |
| `session:locateFolder` | 2971 | split | app: picker + stat; server: `sessions.mutate{replaceRoot}` |
| `relaunch{id}` | 3863 | server | `sessions.relaunch` |
| `session:restart` | 2992 | split | app: owner check; server: `sessions.restart` → `agentScope:result` (C1 `retire`: no exit, status stays `running`, `restartSeq` bumps; the remounted pane's `sessions.start` spawns; the old observer's CLOSE is not an exit) |
| `session:addDirsToAgent` | 2991 | split | app: owner check; server: `sessions.addDirs` (the `runAddDir` guards live server-side in W4; `runAddDir` calls W5's `DraftPort.noteHostInput` itself, as main.ts:3019 does today, then writes through the plain `TypingPort.write`) |
| `session:dismissAgentScope` | 3052 | split | `sessions.dismissScope` |
| `duplicate` | 3907 | split | server: `sessions.duplicate`; app: places it in the source's window |
| `kill` | 3881 | server | `sessions.remove` |
| `openRepo` | 2959 → 2652 | split | app: window, repo tracking, brief dialog; server: `sessions.create` |
| `term:start` | 4325–4520 | split | server: `sessions.start` (W4 allocates the launch ids from the record's persisted `lastGeneration`, then W5's `LaunchPort.prepareLaunch`, then C1 `spawn`; an already-live session returns `spawned: false`: no prelude, no second run; refusals in the result, their text via `term.show`); app: attach + first paint, or an exited session with its output on a `finished` start |
| Retry launch / Discard on an unconfirmed session | new | server | `sessions.retryLaunch`, `sessions.discardLaunch` (D21) |
| `term:input`, `term:resize` | 4591/4599 | server | `term.input{sessionId, generation, data}` → `onRendererInput` → the server's PtyWriter; focus has one producer, xterm's focus-report bytes inside `term:input`, as today. `term.resize` → the server's active attach (D19). The app's xterm sizes itself first. While C2 is down the app drops `term:input` and shows "Reconnecting — input paused" (D29) |
| `term:facts{sessionId, facts}` | new | server | `term.facts`, sent before `sessions.start` like a resize; the server keeps the last per session and passes it as `display` on every attach. A lead-owned renderer protocol change; W7 implements it |
| `term:dispose` | 4606 | app | closes the observer link; the move-window swallow stays in the app |
| server notices, timed messages, add-dir paste | 1720–1740, 3011–3026 | server | all on the server's PtyWriter, each with its own policy: notices gate at the queue slot, timed messages submit bare, add-dir keeps `runAddDir`'s gate (architecture F8) |
| `visible` | 3884 | split | `ui.presence{windows}` (visible + owners + ready; never typing), which W5 forwards to `AttentionPort.setVisible`/`dropWindow` (`clearAll` on app disconnect); app keeps git demand / repo tracker hooks |
| `project:create/rename/delete/reorder` | 3059–3115 | server | `projects.*` |
| `launchers:rescan`, `launcher:addCustom/removeCustom` | 3122–3139 | server | `launchers.*` |
| `launch:preview`, `folder:probe` | 3211/3188 | server | `launchers.preview`, `sessions.probeFolders` |
| `brief:probe`, `brief:agentPreview` | 3164/3177 | server | `briefs.probe`, `briefs.agentPreview` |
| `timer:set/offer/cancel/renew/sendNow/sendOnce/test` | 4535–4575 | server | `timers.*` (`test` is the e2e clock seam) |
| `updateSettings` | 3924 | app | UI keys only, incl. `osAttention` (gates the OS-notification sweep at 1826 and flashFrame at 1990) and `logging`/`logLevel` (the app's logger at 1856/3936, plus C2 `server.setLogging{logging, logLevel}` on connect and on every change). The app writes `settings.json` and mirrors the server keys there on every `serverSettings.changed`; it never strips them in this program (D7, D26) |
| `updateServerSettings{patch}` | new | server | `serverSettings.patch{patch}`, key-scoped and coerced server-side, so a stale window can't revert another window's change. A lead-owned renderer protocol change; W7 implements it (D7) |
| `settings:initial` (sync IPC) | 5095 | app | answered from `settings.json` alone: its server keys are the app's mirror (v0.51's values on the first launch). The app never reads `server-settings.json` (D7) |
| `mcp:*` (10 types) | 4579–4588 | server | `mcp.fromRenderer` |
| `mcpInstall:status/act` (ipcMain.handle) | 5030/5033 | server | `mcp.installStatus`, `mcp.installAct`; W5 imports the install module W0b moved from `electron/mcp-install.ts` to `src/` |
| `ready` | 2928 | split | app: presence, docs, marks; server state from the snapshot |

## Internal subscribers

`main.ts` subscribers on PTY output and folder state that no renderer message carries. Exactly one
subscriber per concern; "consumes" is the event it reads after the split.

| Subscriber (main.ts) | Line | Owner | Consumes |
|---|---|---|---|
| `mcpHost.onOutput` (notice-gate screen model) | 1584 | W6 | its own active stream (C1 `data`), coalesced |
| `countBareBells` + `scanInertOutput` → `activity.recordOutput` (busy, attention, bells) | 1590–1599 | W6 | its own active stream; never `paint` |
| `scrollbacks.append` | 1618 | W6 | its own active stream; host-composed bytes via `ScrollbackPort.show` |
| `trackBracketedPaste` → `pasteModes` (read by `runAddDir`, 3016) | 1605 | W4 | C1 `data` |
| `scopes.output`; `scopes.ended` on exit | 1607, 1638 | W4 | C1 `data`, `exit` |
| `scanForLimitNotice` (arms timers per `autoResumeOnLimit`) | 1612, 1774 | W4 | C1 `data` → `tailLines` |
| `pty.lastLine` in the state broadcast | 2186 | W4 | C1 `data` → `tailLines` |
| `CwdScanner` → `cwdGate` → `mgr.setCwd` | 1359–1375, 1622–1633 | W4 | C1 `foreground.cwd` (M27); on a fail, a ported `CwdScanner` + `cwdGate` on C1 `data` |
| `setAutoRepo` on a cwd change, `repo:pin`/`repo:unpin`/`repo:context`, `repoScanner` → `setRepos` | 1373, 3837–3851, 1527 | W7 (app) | `cwd` in `sessions.changed`; its own scans and `repo:*`; an overlay keyed by sessionId, merged with `mergeAppOverlay` (D39) |
| `detectTyped` (host, typed CLI in a shell) | host 1174 | W5 | C1 `foreground.argv` (M27); on a fail, `term.input` as today |
| `endProcessEpisode` (scanner state drop, `activity.recordExit`, ring flush, limit episodes) | 1657 | W6 (activity, ring), W4 (scopes, limit episodes, paste state), W5 (`mcpHost.onExit`) | C1 `exit` |
| `folders.onFoldersChanged` → `scopes.recompute` | 2522 | W4 | its own session ops (`sessions.mutate`) |
| `SessionFolderRuntime` health (`FolderHealth` → `mgr.setFolderHealth`) and `folders.focused()` recheck | 2453, 2535 | W4 | its own session ops; a `ui.presence` focus change for the focused window's visible session; C2 `folders.suspect{sessionId, path}`, only for that session's own folders |
| `SessionFolderRuntime.suspect` (watch loss or rename) | `session-folder-runtime.ts` 176 | W7 (app) | its own watchers; sends C2 `folders.suspect` per affected session and path |
| `SessionFolderRuntime` watchers, repo scans, plan reconcile; `folders.onFoldersChanged` → `pruneFileIndexes` | 2453, 2523 | W7 (app) | home/roots changes in `sessions.changed` |

## App only

Window plumbing, update/quit, logs, filesystem/editor (`readDir`, `readFile`, `writeFile`, `fs-*`,
`watchFiles`, `persistDocs`, `lsp`, `indexProject`, search), git/repo/review (`readDiff`, `git:*`,
`repo:*`, `review:*`), `.conduit/*` artifacts (board, plan, spec, architecture, pipeline), skills,
native pickers (`file:pick`, `folder:pick`), `session:move` / `session:dragEnd` (the owner map).

## Host → renderer messages from server state

| Message | Server event |
|---|---|
| `state.sessions` (+ lastLine, agentScope, restartSeq, startRefusal, busy/attention) | `sessions.changed`, the only source of session status; compose merges `AttentionPort.statusOf` in |
| `term:data` from host-composed bytes (`scrollbacks.show`: relaunch marker, ConPTY padding at 4522–4528, role-brief banners at 4497, can't-start lines at 4422/4448) | `term.show` (C7 `ScrollbackPort.show`: pane + ring), written like `prelude` |
| `suppressAutoSwitch` (2366) | `sessions.opened{focus:false}`, emitted before the creating `sessions.changed` |
| `state.projects/agents/launchers` | `data.changed` + snapshot |
| `state.settings` | the app's UI settings merged with `serverSettings.changed` |
| `timer:fired` | `timers.fired`, today's payload, emitted before the coalesced `timers.changed` (a fire and an edit look alike in `timer:state`; the toasts read the pre-fire record) |
| `timer:state`, `timer:error` | `timers.changed`; errors as RPC results |
| `mcp:state/thread/sent/askClosed/ui`, `mcp:toolPolicyResult`, `activateSession`, `openFileInEditor` | `ui.post{route}` |
| OS notification / flashFrame (sweep at 1809–1832) | `attention.edge`, `attention.flash`, emitted unconditionally; the app applies `osAttention` |
| `session:opResult`, `agentScope:result`, `project:created`, `launcher:added`, `brief:*`, `launch:previewResult`, `folder:probeResult`, `openRepo:result` | RPC results the app turns into replies with the same `requestId` |

## `ControlDeps` members

All of them are server-local (homeOf, resolvePath, kindOf, agentIds, resolveCommand, claimHandle,
now, info, foldersOf, addRoot, git, targets) except the four below. W4 provides the domain members
(homeOf, resolvePath, kindOf, agentIds, resolveCommand, openSession, foldersOf, addRoot, git), with
the host's registry and settings reads (defOf, projectName, installState, messagingOn, toolPolicy),
as C7 `DomainPort`; claimHandle, now, info and targets are W5's own.

| Member | How the server gets it |
|---|---|
| `ownerWindowOf`, `windowReady` | Server mirror of the latest `ui.presence` owners/ready, keyed by C2 connection. Missing or stale means fail closed for window actions, as today; server actions with policy `on` don't need a ready window (D8, W0b's `gateToolCall` split). |
| host `onSessionMoved` (main.ts:2312), `onWindowReset` (main.ts:5175) | W5 derives them from presence: a session's owning window changed; a window disappeared or went `ready: false` (F7). |
| `activateSession(id, raise)`, `openFile` | `ui.post` to the owner window, fire-and-forget. |
| `openSession` | The server-internal create behind `sessions.create` (`openedBy`, `command`, `placement{nearSessionId, focus}`). The app places the session on `sessions.opened{sessionId, openerSessionId?, focus}`; one created with no app running goes to the focused (else first) window at launch. MCP-opened sessions get no brief dialog, their brief comes from the agent definition. |
