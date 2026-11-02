Verdict: REVISE

Independent app review of 3c65d47faa50ca5d346968125bae8e0b233c371b..325ad040769dbe1fad39adba47bd5332d4a2548c.
The branch advanced to 99cdaec8 during review; this verdict remains pinned to 325ad040.
Scope: the requested Electron modules, renderer changes, C2/C5 contracts and their direct consumers.
Compared against the architecture flows/decisions, W7 plan and Lead decisions, ownership map, and v0.51 source.

1. [blocker] electron/terminal-host.ts:159, electron/terminal-host.ts:284 — A finished cold start runs again on C2 reconnect.
   The finished result shows output and an exit line but never marks the pane ended. Both generation fields remain null.
   CenterPane retains an exited agent's pane, and serverConnected calls sessions.start again because it has no link.
   The server's preflight only reuses live terminals; an exited session cold-spawns. Reconnecting can repeat a command with side effects without a user launch.
   In-memory reproduction against createTerminalHost: one finished start followed by serverConnected produced two sessions.start calls.
   Fix: record completion independently of observer CLOSE and distinguish reconnecting an existing run from an explicit new launch; cover finished -> reconnect -> no spawn.

2. [blocker] electron/main.ts:1981, electron/main.ts:2207 — Closing a secondary window can orphan its live agents.
   Session removal is fire-and-forget and the window closes immediately. With C2 down beyond the connection wait, removeSession only logs failure.
   Its sessionOwner entries still reference the closed window. A reconnect snapshot with the same sessions produces no folder diffs, so the added-only assignment never repairs them.
   The sessions disappear from every remaining window while their processes keep running. The real store/ownership helpers reproduced zero visible sessions after this sequence.
   Fix: finish removals before closing, surface failures, and reconcile surviving sessions whose owner window no longer exists.

3. [blocker] electron/main.ts:1964 — Quit-and-stop quits even when stopping agents failed.
   Both {ok:false} and a rejected stop lead straight to finish(). During C2 reconnect, lifecycle.stopAll returns {ok:false} immediately; agents can all remain alive.
   The user's explicit stop action is silently dropped, with only an app log indicating failure. The same occurs after the 20 s answer bound.
   Fix: keep the bound, but expose stop failure and let the user retry or explicitly choose to quit while leaving agents running. Do not silently treat failure as success.

4. [blocker] electron/server-lifecycle.ts:123 — An unanswered hc lookup bypasses the app's connection bound.
   startRule and lostConnection await supervisorLive before opening C2. NodeHcClient.call has no request/hello timeout while its socket stays open.
   An hc endpoint that accepts but stalls can therefore leave the app connecting forever, even if the Conduit server can answer C2. Retry repeats the same unbounded lookup.
   In-memory reproduction with an unanswered terminal.get: startup remained pending with zero C2 connection attempts.
   Fix: bound the supervisor lookup and reach the defined unavailable state; preserve the separate D21 rule that terminal.run is not resolved by a clock.

5. [blocker] electron/server-lifecycle.ts:375 — Reconnect swallows hello timeouts forever.
   Unlike connect(), lostConnection catches ServerCallError('timeout') and merely increases the retry delay. A live supervisor with a hung server never reaches unavailable/Retry.
   This violates F1.6/D25's defined hello-timeout recovery and leaves an unbounded wait behind the reconnect overlay.
   A fake-connection probe returned two consecutive hello timeout errors; the lifecycle remained reconnecting with no unavailable transition.
   Fix: handle an actual hello timeout as unavailable, while retaining backoff for connection-refused gaps during supervisor recovery.

6. [should-fix] webview/settings.tsx:147, webview/settings.tsx:155 — A rejected server-settings edit permanently blocks hydration.
   update() makes the whole settings object dirty; the later updateSettings post includes the optimistic server values, although main now preserves its authoritative mirror for those keys.
   If serverSettings.patch fails, the mirror broadcast can never equal posted.current.value. decideHydrate keeps dirty=true and rejects every subsequent authoritative update.
   The UI can keep showing a rejected MCP policy/restore setting, and other windows' changes stop arriving. Three successive failure echoes reproduced this stuck gate.
   Fix: acknowledge/reconcile server patches separately from the UI-settings echo gate, including rejection; make server-owned controls read-only while unavailable as D25 requires.

7. [should-fix] electron/server-events.ts:190, electron/server-events.ts:156 — Re-subscription does not reconcile pending approvals.
   Every snapshot re-posts every pending ask, but mcp-ask-store appends mcp:ask without deduplicating askId. Reconnect or missed-event recovery duplicates an already visible request.
   Conversely, a snapshot with no asks never removes requests whose askClosed was lost. approvals.changed is ignored too, leaving stale approval cards after a server restart or missed event.
   Fix: reconcile an authoritative ask set per owner window, removing absent IDs and upserting existing ones; cover repeated snapshots and a lost close notification.

8. [should-fix] webview/components/server-banner.tsx:50 — F11 has no recovery action.
   Runtime unavailable, including 'terminal engine update pending', renders text and a log path only. There is no 'Restart agents to update' action in electron/ or webview/.
   Restarting only the background service preserves agents and the incompatible core, so the existing palette action does not implement F11.
   Fix: expose the explicit F12-and-fresh-core action for this runtime condition, with its destructive intent visible to the user.

9. [should-fix] electron/session-folder-runtime.ts:165 — Lost watches are reported only for projectsByWindow.
   arm() also watches visible sessions and hidden sessions with tracked repos, but suspect() excludes those sessions unless a window has requested their project.
   A hidden tracked root can disappear without sending its server any folders.suspect notification; missing-folder health stays stale until another recheck.
   An in-memory watcher probe armed /w for a hidden tracked session and produced zero suspect notifications when /w was lost.
   Fix: derive affected sessions from the same complete folder ownership used to arm watches, and notify only the matching owned paths.

10. [should-fix] plan:Lead decisions / Logs and diagnostics; electron/main.ts:2479, electron/main.ts:4306 — Diagnostics omit the server log.
    Reveal logs opens the app's logs directory, and buildDiagnostics only includes the app logger's tail. Neither includes <userData>/server.log.
    Most new lifecycle/MCP failures now occur outside Electron, so the promised diagnostic bundle loses their evidence.
    Fix: include a bounded server-log tail in diagnostics and make the server log reachable from Reveal logs.

11. [should-fix; W9 integration dependency] electron/main.ts:2330; server/main.ts:158 — The prepared immutable shim is not used.
    prepareRuntime returns runtime/shim as shimDir, but the app discards that result. The launched server still builds shim commands from process.execPath and ../../resources/conduit-mcp.
    From runtime/<version>/server this resolves to <userData>/runtime/resources/conduit-mcp, which preparation never creates. It also uses the versioned server Node instead of the write-once shim Node.
    Packaged MCP launches/install entries therefore do not satisfy D2b. W7 explicitly defers packaged acceptance to W9, so this is carried as an integration dependency rather than a W7 blocker.
    Fix: wire the prepared shim directory into the server's per-launch command and install-entry configuration; verify the packaged layout before shipping.

Simplify:

12. [nit] electron/server-lifecycle.ts:225, electron/main.ts:2385 — Supervisor argv is constructed twice.
    The lifecycle passes supervisorArgs to spawnDetachedSupervisor, but production ignores the argument and rebuilds the same argv; the test callback consumes the argument.
    Delete one construction and make the production callback consume the same launch description that tests inspect.

Evidence and limits:
- Read-only review; no edits except this report, no gate/build/install, no real-agent or hc process actions.
- In-memory probes imported the real app modules with esbuild transformation; dependencies were fake connections/watchers. These establish the stated state transitions, not desktop/e2e coverage.
- Integrity scan of all 31 scoped added/modified text blobs at pinned HEAD: no NUL, BOM, invalid UTF-8, mixed/lone line endings or stray controls. Numstats show no wholesale whitespace rewrite.
- No tautological assertions or mocked replacement of the subject identified in the inspected tests; missing combined failure sequences explain the blockers above.
- Rubric: plan fidelity findings (10/11); spec coverage findings (1–9); tests findings (missing failure sequences); mock-subject clear; encoding clear; placement/naming clear; scaffolding findings (12); evidence checked; security boundary clear for app hc-session selection; deviation/contract handling findings (6/7).
- No app hc operation targeting a session outside instanceNames(userData).hcSession was found in the scoped paths.

REVIEW: REVISE
BLOCKERS: 5
FINDINGS: 12
