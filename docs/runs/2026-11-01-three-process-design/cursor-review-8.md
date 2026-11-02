The contracts are buildable for the launch reservation, the shim handshake, and the supervisor's restart loop. They are not buildable for two v0.51 behaviors the lanes are required to keep, so the verdict is REVISE.

## Blockers

**1. blocker — `src/protocol.ts` `timer:fired` (about line 552); `src/contracts/server-protocol.ts` `ServerEvents`; `docs/runs/2026-11-01-three-process-design/main-ts-ownership.md` host→renderer table**

`timer:state` cannot represent a fire. The protocol comment says so: a fire and an edit look the same, so the host sends `timer:fired` before `timer:state`. `webview/timer-store.ts` and `webview/app.tsx` use that pre-fire record for the missed, failed, and late toasts. C2's timer surface is `timers.changed` (`Reply<'timer:state'>`) plus RPC `timer:error`. The ownership map lists those and not `timer:fired`. W4 and W7 cannot keep today's timer toasts without inventing an event the other lane must share.

Direction: add a C2 event whose payload is today's `timer:fired`, emitted before the coalesced `timers.changed`, and name it in the ownership map.

**2. blocker — `src/scrollback-store.ts` `show`; `src/contracts/server-ports.ts` `ScrollbackPort`; architecture F2 and D3**

Host-composed terminal bytes are not PTY output. `show` sends them to the pane and appends them to the ring: the relaunch marker and ConPTY replay padding (`spawnPrelude` in `electron/main.ts`), role-brief banners (`electron/role-brief-host.ts`), and the "can't start" lines. D3 removes the server from the output path. `ScrollbackPort` can only `replayForColdStart` and `forget`. F2's `prelude` is that replay, plus `terminal.read` for a fast exit. W4 cannot put those strings on the pane and in the ring, and writing them through `TypingPort` would type them into the agent. The next cold replay would also drift, because the ring is required to hold what the pane was shown.

Direction: give `ScrollbackPort` the `show` operation (deliver to the app and append to the ring), and a C2 notification the app writes into the xterm the way it writes `prelude`. Keep refusal text for a start that never spawns on that same path, or define the exact pane string W7 formats from `StartRefusal`.

## Should-fix

**3. should-fix — `src/contracts/server-protocol.ts` `ServerErrorKind` and `SessionStartResult`; architecture F2 and D32**

`server_stopping` is both a JSON-RPC error kind ("a create or start") and an `ok: false` result on `sessions.start` / `sessions.retryLaunch`. `sessions.create` has nowhere to put it except the error channel. W3 and W7 will disagree on starts, and one side will drop the refusal.

Direction: result refusals for `sessions.start` and `sessions.retryLaunch`; the RPC error for `sessions.create` and MCP opens. One channel per method.

**4. should-fix — `src/contracts/terminal-runtime.ts` `reconcile` step 3; `hc.openrpc.json` `terminal.attach` error `finished`**

Step 3 says to active-attach each `live` token row. Attach to a terminal that has already exited returns `finished`. Treating that as "address hc no longer knows" records `exit` `lost` and revokes a row whose record is still there, with a real exit code. The `terminal.read` branch exists only on `spawn`.

Direction: if `terminal.get` or the snapshot says `state: finished`, skip attach, take `exit_code` and `reason`, `terminal.read` into the ring, emit `exit`, then `terminal.rm`. Reserve `lost` for `not_found` after the prune rules you already state.

**5. should-fix — `src/contracts/server-ports.ts` `allocateLaunch`; `src/contracts/session-identity.ts` `SessionRuntime`**

`allocateLaunch` must return a generation above the session's last persisted one. `SessionRuntime.generation` is never written to `sessions.json`, and a `TokenRecord` is revoked when the exit is recorded, so the counter disappears at the moment the next launch needs it. Today's `PtyHost` only avoids reuse because the counter dies with the app. Here the pane survives, and `term.input` is dropped only when the generation differs. A counter that restarts at 1 delivers in-flight input from the previous life of generation 1 into the new process.

Direction: persist the counter on the session record (not on `SessionRuntime`, not only on the token row). `allocateLaunch` reads that field.

**6. should-fix — architecture F4, F12, D32; `src/contracts/terminal-runtime.ts` `beginStopping`**

D32's residual says a launch still `unconfirmed` after `stopAll` can register after the process exits and the next server adopts it. F12 then has the supervisor call `hc server stop` when no other terminal is live. A `keep:false` run that has not registered yet is not a live terminal, so the core stop destroys it. The same check is the idle-exit path. The next server keeps the row `unconfirmed` and the pane offers Retry launch for a process that is already gone.

Direction: `hc server stop` waits until no `reserved` or `unconfirmed` row remains, or `stopAll` discards those rows before it exits. Idle exit treats a `reserved` or `unconfirmed` row as still busy.

**7. should-fix — `src/contracts/server-protocol.ts` `SessionStartResult.spawned`; architecture F2; `src/protocol.ts` `suppressAutoSwitch`**

F2's return shape is `{target, generation, prelude?}` or `finished`. C2 adds a required `spawned` boolean and does not say what the app does when a session is already live (today's attach path: ring replay, "— attached —", no second spawn). `sessions.opened.focus: false` is how an MCP open stays in the background, but today's `suppressAutoSwitch` is sent before the session is posted (`electron/main.ts` around the create path, and the comment on `suppressAutoSwitch` in `protocol.ts`). C2 does not order `sessions.opened` ahead of `sessions.changed`.

Direction: `spawned: false` means prelude absent, observer attach with `history: 2000`, no second `terminal.run`. Emit `sessions.opened` before the creating `sessions.changed`, and have the app apply `focus: false` before that session is shown.

**8. should-fix — program W4 and W6; `src/contracts/terminal-runtime.ts` `tailLines`; `electron/main.ts` `scanForLimitNotice` and `pasteModes`**

`tailLines` is documented as the feed for `lastLine` and the limit-notice detector. The limit detector arms W4's timers from `autoResumeOnLimit` (`scanForLimitNotice`). W6's lane text also claims "limit scan" as an attention heuristic, but `SessionActivity` has no limit scan. Bracketed-paste state is tracked from output in `main.ts` and required by `runAddDir` (`src/add-dir-delivery.ts`). `sessions.changed` is documented to carry `lastLine`, busy, and attention, while W4 is not given `AttentionPort`. Each lane can subscribe to C1 `data` and both will, or neither will.

Direction: W6 records activity only. W4, on C1 `data`, updates `lastLine` from `tailLines`, scans the limit notice, and tracks bracketed paste. `compose.ts` merges `AttentionPort.statusOf` into `sessions.changed`.

**9. should-fix — `src/contracts/shim-protocol.ts` `ShimResume.initialized` and `SHIM_ERRORS.reinitialize_required`; `test/fixtures/contracts/shim-hello.json` local-answer transitions**

`initialized` means the client sent `notifications/initialized`. The local-answer fixtures all send `"initialized": true`, and the resume comment says the server treats every accepted resume as initialized and does not reply to `initialize`. W5 cannot tell whether to wait for the notification. `reinitialize_required` is specified for a hello that would exceed 64 KiB and is not in the state table, so the shim's next state (permanent fallback, or exit) is undefined.

Direction: local fallback sets `initialized` from whether that notification has actually been read. The server waits for it when the flag is false. On `reinitialize_required`, enter `permanent_fallback` after that one reply.

**10. should-fix — `src/contracts/terminal-runtime.ts` `retire`; `src/contracts/terminal-link.ts` `closed`; `webview/app.tsx` running→exited transition**

`retire` exists so an in-place restart emits no exit (today's `session:restart` kills, bumps `restartSeq`, leaves status `running`, and the remounted pane sends `term:start`). The app's observer is a separate hc connection and still receives CLOSE `killed`. If W7 turns that into status `exited`, the running→exited path offers to close the session and its editor tabs.

Direction: session status comes only from `sessions.changed`. `sessions.restart` retires, keeps status `running`, and bumps `restartSeq`. The pane remount's `sessions.start` is the spawn. A CLOSE on the old link is not an exited session.

**11. should-fix — architecture F8 versus D18; `src/contracts/terminal-runtime.ts` `screen`**

Past `SCREEN_BACKLOG_MAX_BYTES` the model is discarded and `screen()` stays null until a later paint. Credit is granted on ring append, so a slow parse does not by itself produce the >4 MiB gap paint. F8 says the reseed is a re-attach. Nothing in C1 or W6 says to re-attach when the backlog drains, so the notice gate stays fail-closed until some unrelated reconnect.

Direction: when the backlog drains, W6 drops the active attach and attaches again, and that `paint{cause:'attach'}` reseeds the model.

**12. should-fix — `src/contracts/server-ports.ts` `TokenStorePort.revoke`; C1 `discardLaunch`; program W6**

`revoke({sessionId})` does not say whether it removes every row for that session (`live`, `unconfirmed`, and `superseded`). Reconcile step 6 kills a labelled terminal with no row only at reconcile time. `discardLaunch` says a later registration is killed as an orphan. A `created` event between reconciles has no rule, so a discarded launch, or an agent-labelled `hc run`, keeps running until the next core reconnect.

Direction: `revoke({sessionId})` removes every row for that session. On `created`, a `conduit.role=session` terminal with no row is killed immediately. Skip `conduit.role=server` in that kill and in reconcile step 6.

**13. should-fix — program W8; architecture D17 and M17**

W8 says `launchElectron` / `finishScenario` stop the server and the hc session. Task Manager End task and `taskkill /T` on the app do not stop an hc-hosted supervisor. A tree-kill leaks the session on the runner, or a name-based kill hits the user's own hc session, which the invariants forbid.

Direction: `finishScenario` calls `server.stopAll` for that userData, then `hc kill` of `conduit.role=server` and `hc server stop` only in that `HC_SESSION`.

## Nits

**14. nit — `src/contracts/session-identity.ts` `serverEndpoint` versus `src/conduit-mcp/endpoint-path.ts`**

The server lock is specified only as `\\.\pipe\conduit-server-<h>`. The MCP endpoint already has a POSIX socket path, and `npm run verify` runs on Ubuntu. W3 needs that path or an explicit "Windows listen, POSIX tests inject the listener."

**15. nit — `src/contracts/server-protocol.ts` `generation_mismatch`**

Stale `term.input` is dropped and returns false. No method produces `generation_mismatch`.

**16. nit — architecture F6 "server older"**

`hello` carries version strings. The order used to decide restart versus the downgrade offer is not defined.

## (B) Reuse of hc

No violation of "reuse hc first." The audit's three local copies match a need the pin does not cover: the ring, because hc drops finished records and nothing survives reboot; the headless model, because `terminal.read` has no per-cell dim styling; the supervisor, because `keep` does not rerun a command. OSC 7501 is the primary attention source. `terminal.send` and `keep` are unused for reasons the design states.

**17. nit — architecture §Reuse audit**

`doc.get` / `doc.set` are in the vendored schema and survive core restart. Tokens, bindings, and server settings stay in local files. That is the right call, because F1 answers `hello` before hc is up and a down core must not take identity with it. Add that row so a later lane does not move `tokens.json` into hc documents.

## (C) What a later server would have to undo

These are already listed and do not need a new design: the app restarting the server on a version mismatch, `AttentionPort.clearAll` on disconnect, the app supplying presence, the app copying and garbage-collecting runtimes, and the app attaching to hc's local pipe (`TerminalLinkFactory`).

An intent/task store and long-running lead agents that are hc terminals fit the split. Sessions, tokens, policy, and timers are already server-owned. C2 can grow methods. The accepted limit stays: if the supervisor gives up or dies while no app is open, the bus stays down until the next launch.

Not listed, and would have to be undone:

- **Report/artifact store.** The ownership map gives board, plan, architecture, and review files to the app. A store that remains true while no window is open has to move that row to the server.
- **Remote app, cold settings.** D7 paints server settings from the local `settings.json` mirror and never waits for the server. A remote client has no such mirror. It has to paint defaults or wait for the snapshot.
- **A second client typing or resizing.** `term.resize` and `term.facts` keep one last value per session, with no focused client. Two clients fight. Presence is already per connection, so this is the part that does not extend.
- **Reachable MCP and C2.** Both endpoints are Windows named pipes. C6's bytes can stay. The shim's dial path cannot. That is a `runtime/shim-2/` migration, which D2b already allows, not a change to the three processes.

## Verdict

REVISE
