# Three-process architecture and contracts review

**Verdict: REVISE.** The ownership split addresses the stated lifetimes, but the contracts are not ready to freeze for W1/W3/W5/W6/W7. C3 disagrees with hc 0.1.16, terminal streams and gated typing lack implementable public interfaces, and the update/reconnect paths contain concrete failure cases. This is an advisory review, not authorization to implement.

Reviewed the five requested design/ownership documents, every `src/contracts/*.ts` file, the complete vendored OpenRPC schema, `test/unit/contracts.test.ts`, and the supplied `hc-schema-README.md`. Findings below were checked against the existing Electron host, shim, endpoint, main-process handlers, and relevant `src/conduit-mcp/*` modules. No `critique-*.md` files were read. Repository paths below are relative to `G:/awby/projects/conduit`; README anchors refer to the supplied local protocol notes. No application, installer, or tests were run: this is a read-only preimplementation review, not runtime verification.

| Dimension | Rating | Evidence |
|---|---|---|
| Requirement and quality-attribute fidelity | Yellow | Durability and UX constraints are explicit; several contracts cannot preserve the described behavior. |
| Boundary quality | Yellow | Ownership is clear, but W6/W7 must invent stream capabilities outside C3 and W5 must invent typing semantics outside C1. |
| Pattern restraint | Green | The three lifetimes and direct viewer path have stated forces; no wholesale redesign is needed. |
| Data and state modeling | Red | Repaints, uncertain mutations, handshake completion, and reconnect ownership are incompletely modeled. |
| Change tolerance | Yellow | Frozen cross-version edges are justified, but the tests freeze names rather than full compatibility. |
| Failure realism | Red | Core reconnect, NSIS updates, runtime GC, and C6 interruption paths have concrete failures. |
| Decision capture and legibility | Green | ADR, ownership map, alternatives, flows, and spike decisions give implementers a useful map. |

## Blockers

### B1 — C3 has incorrect hc response envelopes and an invalid attach parameter

**Severity:** blocker. **Lanes:** W1, W6, W7.

**Anchor:** `src/contracts/hc.ts:70`, `:76`, `:83`; `src/contracts/hc/hc.openrpc.json`, methods `terminal.run`, `terminal.get`, `terminal.attach`, and schemas `RunResult`/`Terminal`.

**Why:** hc returns a flat `RunResult` from `terminal.run` and a flat `Terminal` from `terminal.get`. C3 declares `{ terminal: HcTerminal }` for both. A conforming client consuming those declared results will read `undefined` where it expects the terminal. `terminal.attach.history` is an unsigned integer number of scrollback lines, whereas C3 declares `boolean`; sending `true` does not request valid history. These are wire incompatibilities with the pinned API, not spike-dependent questions. The existing test at `contracts.test.ts:25` checks only method/parameter names and misses all three.

**Direction:** Make C3 match the flat results and numeric history input. If W1 intentionally normalizes responses, explicitly distinguish its normalized API from the wire API and test that mapping. Also account for the schema's nullable subscription channel (`channel?: number | null`) rather than promising only absence or a number.

### B2 — C3 exposes channel numbers without the stream operations its consumers need

**Severity:** blocker. **Lanes:** W1, W6, W7.

**Anchor:** `src/contracts/hc.ts:155` (`HcClient`), `terminal.attach.result`; `src/contracts/terminal-link.ts:19` (`TerminalLinkEvents`); supplied README, “Framed mode” and “Attach streams.”

**Why:** `HcClient` exposes RPC calls, event subscriptions, connection notifications, and close. There is no public way to receive terminal-channel DATA/CLOSE, send DATA/RESIZE/FOCUS/FACTS, return CREDIT, or detach one stream. W6 cannot build an observer and W7 cannot build `TerminalLink` against this interface. `frames.ts` describes bytes but provides no ownership or transport API. In addition, C5's `data(data): void` cannot acknowledge when the renderer actually consumed output. hc requires credit for consumed bytes; forwarding IPC is not consumption by xterm. Existing `webview/components/terminal-pane.tsx:991` queues asynchronous `term.write` and has no host consumption acknowledgment.

**Direction:** Add a public ordered stream abstraction to W1's contract, including stream lifetime, frame operations, and byte consumption acknowledgment. Define how C5 bridges credit to xterm completion, including UTF-8 byte counts. Otherwise the 50 MB M5 test can pass bytes into an unbounded renderer queue while hc incorrectly believes they have been consumed.

### B3 — C1 does not distinguish raw input from guarded submission

**Severity:** blocker. **Lanes:** W5, W6, W7.

**Anchor:** `src/contracts/terminal-runtime.ts:61` (`write` and `WriteOutcome`); architecture F8/D13 and spike M11; `electron/conduit-mcp-host.ts:595–644`; `src/pty-writer.ts`, `SubmitHooks`/`createPtyWriter`; `electron/main.ts:3011–3021`; `src/add-dir-delivery.ts`, `addDirInput`.

**Why:** Existing notice submission serializes text and Enter separately, checks the gate before text, waits for positive echo evidence, checks for intervening human input, and can withhold Enter after text has already been written. Add-dir deliberately pastes a bracketed command without Enter. C1 offers one `write(..., data)` with no operation mode, no recheck hooks, and no partial-submit result. hc's `terminal.send` always pastes and submits; its `timeout` applies to a requested wait, not a bounded raw write. It cannot implement those semantics by itself. Choosing `terminal.send` in M11 would silently submit add-dir and bypass the existing echo gate; choosing raw DATA still needs a defined home for the serialized submit transaction.

**Direction:** Freeze separate raw-input and guarded-submit semantics, or a single explicit operation union. Assign ownership of the writer queue and before-text/before-Enter checks, including the “text written, Enter withheld” result. M11 must prove the actual notice and add-dir behavior through that interface, not just that text arrives without resizing.

### B4 — F10 waits for a program-replacement event after a core reconnect

**Severity:** blocker. **Lanes:** W1, W6, W7.

**Anchor:** architecture F10 (`reattach after restarted`); `src/contracts/hc.ts:165`; `src/contracts/terminal-runtime.ts:40–41`; supplied README, event table, keep recovery, and sequence reset rules.

**Why:** hc's `restarted` event replaces a lost kept program with a new shell. It is not a “core is back” event. Conduit uses `keep:false`; a program that survived in a holder after a core crash/restart need not receive `restarted`. Following F10 literally leaves its app link and server observer detached indefinitely. Sequence numbers also restart with the core. C1's `resynced` says consumers re-read state, but its only enumeration API, `adopt()`, is documented as once at server start; `get()` does not provide the new snapshot or missing exit facts.

**Direction:** After reconnect and a fresh subscription snapshot, reconcile terminal records and reattach every surviving live target without waiting for program replacement. Define C1's repeatable reconciliation/snapshot surface and handling of terminals that finished while disconnected. Reserve `restarted` for an actual replacement program.

### B5 — The proposed uninstall hook also executes during normal updates

**Severity:** blocker. **Lanes:** W3, W7, W9.

**Anchor:** architecture “Processes and installs → Uninstall” and F6; `build/installer.nsh:customUnInstall`; installed `node_modules/app-builder-lib/templates/nsis/uninstaller.nsh:156–164`; `package.json:79–88`.

**Why:** The design puts `--stop-all` and `hc server stop` in `customUnInstall`. The installed electron-builder template invokes that macro unconditionally, before its `${isUpdated}` branch. Once this uninstaller ships, a subsequent one-click update runs the old uninstaller and stops the agents that F6/M16 promise to preserve. The first update onto the architecture may not expose the problem because it runs the previous version's uninstaller. This lifecycle is also documented by [electron-builder's NSIS documentation](https://www.electron.build/nsis/).

**Direction:** Specify an explicit `${ifNot} ${isUpdated}` guard for real-uninstall stop behavior, with prompt cancellation preventing uninstall and with a defined silent-uninstall policy. M16 must include an update from a version that already contains the new uninstall hook.

### B6 — An open Node `.inuse` file is not the Windows deletion lock described by the design

**Severity:** blocker. **Lanes:** W3, W9; affects W5/W6 survival.

**Anchor:** architecture “Processes and installs → GC” and “The server is pure JS”; program W9.

**Why:** Ordinary Node file opens use libuv's Windows open path, which permits `FILE_SHARE_DELETE`; retaining an fd does not make unlink fail. GC can therefore delete a live process's marker and begin removing its resources, then fail partway through on another file. `wx` prevents duplicate creation; it does not establish the required share-mode lock. The unmodified hc core and old draining holders also have no specified owner that creates and retains these markers. The relevant behavior is explicit in [libuv's Windows filesystem source](https://raw.githubusercontent.com/libuv/libuv/v1.51.0/src/win/fs.c).

**Direction:** Replace deletion-of-an-open-file as the liveness test with a realizable lease/locking protocol. Specify exclusion between launching and GC, cover hc cores and draining holders, and establish that a directory is unused before deleting anything in it. Resolve this against the pure-JS/no-native-module constraint.

### B7 — C6 confuses cached initialize input with a completed client handshake

**Severity:** blocker. **Lanes:** W5, W3.

**Anchor:** `src/contracts/shim-protocol.ts:9–22`, `:41–53`; existing shim `answer('initialize')`; `src/conduit-mcp/json-rpc.ts`, `createMcpServerCore`; `electron/conduit-mcp-host.ts:981–1005`.

**Why:** If initialize reaches the server but its reply is lost, C6 tells the shim to fail the in-flight request and then silently resume. The client has never received a successful initialize result. Conversely, `ShimResume.initialized:false` is representable while the comment says every accepted resume makes the connection initialized. Initial FALLBACK can answer initialize before the first successful connection, but `resume` is documented only for reconnects. That fallback currently advertises `tools:{}` and no instructions, while the real host advertises `listChanged:true` and instructions. Sending a later list-changed notification does not repair an initialization result the client never received or capabilities it was never told about.

**Direction:** Define states for initialize unsent, sent/unanswered, successful response delivered, and initialized notification received, plus local-fallback initialization. Define exactly which phase resume restores and when a response or list-changed notification may be emitted. Make fallback initialization compatible with eventual promotion to the real host, or explicitly require a fresh client handshake.

## Should-fix

### S1 — In-flight failures are marked retryable even when mutations may have committed

**Severity:** should-fix. **Lanes:** W5.

**Anchor:** `src/contracts/shim-protocol.ts:34–44` (`HOST_UNAVAILABLE_ERROR`); architecture F6; `src/conduit-mcp/tools.ts:285` (`store.append`); `electron/main.ts:2600` (`createMcpSession`).

**Why:** The pipe can close after `send_message` persists or `open_session` creates a session but before its response reaches the shim. Returning `host_unavailable` with `retryable:true` for every in-flight call implies that retrying is safe and can duplicate messages or terminals. This differs from a new request rejected before forwarding. Server-side cancellation on connection close cannot undo a committed side effect. The existing shim also returns tool failures as `ToolCallResult.isError`, whereas the new constant is a JSON-RPC error; the comment that this is the same fallback shape is incorrect.

**Direction:** Separate definitely-unsent failures from unknown outcomes. Specify an uncertain-outcome response and reconciliation behavior, or use persisted operation identity/deduplication for mutations. Explicitly settle the MCP error envelope and verify client behavior; do not treat the existing shim as evidence that the new envelope is already handled.

### S2 — C6 has no transition rules for welcome rejection, silent acceptance, or shutdown

**Severity:** should-fix. **Lanes:** W5, W3.

**Anchor:** `src/contracts/shim-protocol.ts:26–28`, `:41–48`; existing shim `process.stdin.on('end')` and socket handlers; `electron/conduit-mcp-host.ts:958–976` (tokenless clients list no tools).

**Why:** The named states do not say what follows `unknown_token`, `unsupported_generation`, or `draining`. A pipe can accept a connection and never send welcome, leaving CONNECTING buffered indefinitely despite the backoff rule. `token:null` is allowed by hello and is a normal existing out-of-session client, but the contract does not say whether that is accepted without tools or rejected. EOF during connecting/reconnecting must cancel retries and flush/terminate; otherwise a dead CLI can leave a shim retrying forever. Error and close often describe the same failure and must not create duplicate retry loops.

**Direction:** Add a state/event table covering each rejection, connection and welcome timeouts, missing endpoint, EOF, stdout failure, and error-plus-close. Specify bounded input buffering and one retry owner. Distinguish permanent invalid identity from transient draining, and preserve a deliberate tokenless behavior.

### S3 — Resuming an accepted initialize can exceed the relocated endpoint's hello limit

**Severity:** should-fix. **Lanes:** W5.

**Anchor:** `ShimResume.initialize` (`Record<string, unknown>`, verbatim); `electron/conduit-mcp-endpoint.ts:7–8`, `:121–129`.

**Why:** The current endpoint accepts a 4 MiB ordinary input line but limits hello to 4 KiB. An initialize with client capabilities/metadata larger than 4 KiB can succeed initially, then become a permanently rejected hello when embedded in `resume`. The arbitrary-record contract imposes no smaller limit. Reconnecting forever cannot fix this deterministic rejection.

**Direction:** Specify compatible byte limits for initial initialize and the expanded resume hello, and an explicit oversized-cache outcome. Update both shim and endpoint parsing rules together rather than carrying the old hello bound into W5.

### S4 — C6 in-flight tracking lacks cancellation and connection-epoch rules

**Severity:** should-fix. **Lanes:** W5.

**Anchor:** `src/contracts/shim-protocol.ts:41–44` (`tracks in-flight request ids`); `src/conduit-mcp/json-rpc.ts`, cancellation dispatch; `src/conduit-mcp/call-flow.ts`, `cancelled`/`connectionClosed` and its typed-ID maps.

**Why:** A cancelled MCP call deliberately receives no response from the current host. A shim that only removes IDs when a response arrives retains that ID and later fabricates a host-unavailable response on disconnect. A partially received response at socket loss, a late callback from the old socket, or reuse of an ID after a local error can likewise deliver duplicate/mismatched responses unless buffers and outstanding calls belong to a particular connection attempt. Numeric `1` and string `"1"` must remain distinct, as the existing call flow already does.

**Direction:** Define terminal handling of `notifications/cancelled`, per-attempt request maps and parser buffers, and exactly-once local failure emission. Only complete responses from the current attempt may settle a current request; partial data and callbacks from abandoned attempts must not cross into the next connection.

### S5 — Boolean draft state cannot replace the existing typed-command producer

**Severity:** should-fix. **Lanes:** W5, W7.

**Anchor:** `src/contracts/server-protocol.ts:173`; ownership map `term:input` row (`ui.inputActivity`, which is not a C2 method); `electron/conduit-mcp-host.ts:1174–1203`, `:1413–1418`; `src/conduit-mcp/typed-command.ts`.

**Why:** The current host uses actual input for more than draft state: it detects a CLI typed into a plain shell, starts the no-initialize grace, binds the corresponding MCP connection, and unbinds on Ctrl+Z. C2 carries only `hasDraft`; that cannot distinguish `claude\r`, another shell command, an empty Enter, or suspension. `initialize.clientInfo` does not replace this binding rule when several clients run in one shell. Moving the host with only the documented C2 wiring drops existing connection diagnostics and notice-adapter selection.

**Direction:** Keep the typed-line tracker app-side and transmit its semantic outputs/control events, or define another sufficient input feed. Name the producer and consumer in C2 and correct the ownership map's nonexistent method.

### S6 — Direct hc input and the C2 draft mirror have no ordering guarantee

**Severity:** should-fix. **Lanes:** W5, W6, W7.

**Anchor:** architecture F2.5–6/D14; `server-protocol.ts:167–173`; `electron/main.ts:4591–4594`; `electron/conduit-mcp-host.ts:610–619`, `:1165–1171`.

**Why:** Today `onRendererInput` increments the input sequence before the same main-process handler writes the key to the PTY. In the proposed topology the key and draft update travel on independent connections. The server can still see `hasDraft:false`/an unchanged input sequence while a human key is in flight to hc, and approve a notice Enter using stale screen evidence. “Send on edges and at most once per second” does not establish the original intervening-input check. After server reconnect there is also a window before the app resends current drafts.

**Direction:** Specify an ordering/barrier or arbitration rule between human input and guarded server submissions, including input sequence/epoch and fail-closed state until reconnect synchronization completes. Merely sending a C2 notification before a write on another socket is not a processing-order guarantee.

### S7 — An observer stream is not a lossless raw-output source for D18

**Severity:** should-fix. **Lanes:** W1, W6.

**Anchor:** architecture F8/D18; program W6; `RuntimeEvent.data`; supplied README “Attach streams”; `electron/main.ts:1582–1636`, especially `:1614–1618`.

**Why:** Every observer attach starts with a synthetic paint, so the resize-reattach fallback produces repeated paints. hc also replaces backlog with a fresh repaint when a viewer falls more than 4 MiB behind. D18 feeds that stream into a ring intended to record terminal output; the existing main callback explicitly excludes replay from that append path. C1 has only `data:string`, with no paint/reset/gap distinction. Re-recording paints as fresh output can duplicate screen history and create false activity; output discarded by hc cannot be reconstructed as the original history. The supplied README describes newer ordered resize negotiation, but the pinned schema exposes neither the attach opt-in nor its confirmation, so that path cannot be assumed for 0.1.16.

**Direction:** Define how first/replacement paints reset the screen model without becoming ordinary scrollback/activity input, and how gaps are represented. Prove the fallback against the pinned API. If the required lossless history cannot be obtained from it, qualify the guarantee or obtain an upstream capability before treating M19/M8 as solved. Also define first-paint completion; the supplied framing has no explicit end-of-paint marker for C5's `firstPaint` promise.

### S8 — The holder does not supply an automatic restart owner for a crashed server

**Severity:** should-fix. **Lanes:** W3, W7.

**Anchor:** ADR decision 7; architecture F3/F4/F9/D17 and `keep:false` invariant; supplied README “run --keep” recovery.

**Why:** Running Node inside an hc terminal protects its lifetime from the app's process tree. It does not specify who reruns `server/main.js` if Node itself crashes while no app is open. With `keep:false` the server terminal finishes; even `keep:true` starts a shell rather than rerunning the original command. F9 delegates restart to the app, which F3/F4 explicitly allow to be absent while agents and timers remain active. Shims retrying cannot restart the server under C6, so the message bus can stay down until a person reopens Conduit.

**Direction:** Name a restart owner independent of the window, with a bounded crash-loop policy, or explicitly narrow the headless availability guarantee. Do not describe terminal lifetime protection as command supervision/restart.

### S9 — Stop-all can kill the server before it finishes stopping everything

**Severity:** should-fix. **Lanes:** W3, W6, W7.

**Anchor:** `server-protocol.ts:99` (“kill every labelled terminal of this instance”); architecture F12 and F4 idle stop; `session-identity.ts`, `conduit.role=server`.

**Why:** The server is itself a labelled terminal in that hc session. An ordinary labelled-terminal kill loop can kill the process servicing `server.stopAll` before siblings are stopped, persistence is finished, or `{killed}` is returned. Stopping hc also stops that server terminal. The same self-reference matters when deciding whether there are “none left” for idle shutdown.

**Direction:** Specify exclusion of the server role from agent counts/kills and the final shutdown sequence: persist, stop session terminals, respond/drain, then arrange hc stop and server termination. Define the `--stop-all` control invocation's behavior when the daemon lock is already held or C2 is unavailable.

### S10 — The stable shim swap is a multi-step transaction with an executable-path gap

**Severity:** should-fix. **Lanes:** W5, W7, W9.

**Anchor:** architecture “Processes and installs → Shim path” and D2b.

**Why:** “Rename the new executable into place and the old one to `.old`” is not an atomic swap. Moving the old executable aside and then installing the new one leaves a crash/failure interval in which every stored CLI entry points at a missing `node.exe`. Renaming the new executable over an occupied mapped destination is a different operation from renaming the running executable away. Open-handle share modes can also prevent a rename; Windows permitting some running-executable renames is not a universal success guarantee. [Microsoft's CreateFile documentation](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea) specifies the relevant delete/rename sharing requirement.

**Direction:** Define swap order, exclusive preparation, recovery from each `.new`/`.old`/missing-target state, and how headless agents launching new shims avoid observing the gap. Extend the installer spike to an interrupted shim-runtime upgrade, not only an uninterrupted NSIS update.

### S11 — The new endpoint hash specification differs from the current Windows algorithm

**Severity:** should-fix. **Lanes:** W3, W5, W7, W9.

**Anchor:** architecture “Processes and installs → Endpoints” (`sha256(userData)[0..16]`, MCP “unchanged”); `src/conduit-mcp/endpoint-path.ts:14–18`; `session-identity.ts`, `InstanceNames`.

**Why:** Existing Windows MCP endpoints hash `userData.toLowerCase()`. Implementing the new algorithm literally changes the supposedly unchanged MCP endpoint for ordinary mixed-case profile paths and gives differently cased spellings of the same directory distinct server/hc names. A lock derived from the same unnormalized string can then permit two daemons over one token/settings store. The slice notation also leaves the endpoint's exact 16-hex-character convention implicit.

**Direction:** Freeze one Windows path normalization and 16-character hash algorithm, preserving existing MCP naming. Reuse it for daemon locking, server/MCP endpoints, hc session selection, CLI migration, tests, and uninstall.

### S12 — `sessions.create` cannot express the creation flows assigned to it

**Severity:** should-fix. **Lanes:** W4, W5, W7.

**Anchor:** `server-protocol.ts:102–113`; ownership map `openSession` row; `src/conduit-mcp/control-tools.ts`, `McpOpenRequest`/`McpLaunch`; `electron/main.ts:2330–2383`, `:2600–2628`; `src/types.ts`, `BriefRequest`.

**Why:** The map says MCP `openSession` becomes `sessions.create` with `openedBy`, but C2 has no `openedBy`, command launch, caller placement, or focus field. Existing `open_terminal` creates a `SessionCommand`, and focus=false suppresses auto-switch before the owner sees the new session. `Session.openedBy` in the response cannot create those missing facts. Human opens also carry a structured `BriefRequest` (agent/none/text/file); C2 has only an ambiguous `brief?:string`. A coalesced `sessions.changed` list supplies neither an explicit creation placement/focus instruction nor a representation of that brief request.

**Direction:** Extend the creation/placement contract to preserve these inputs, or name a separate server-internal creation API for MCP and define its app event. Settle what `brief` means and preserve explicit no-brief/file requests. Do not leave W5 and W7 to choose incompatible interpretations of the ownership map.

### S13 — Approval grace reconnects need a window-identity rebind rule

**Severity:** should-fix. **Lanes:** W3, W5, W7.

**Anchor:** architecture F4/F7 (5-second grace); `server-protocol.ts:33`, `:85`, `:177–180`; `src/conduit-mcp/call-flow.ts:241–278`, `answer`; `src/conduit-mcp/window-waits.ts`, `Wait.windowId`/`answer`.

**Why:** Existing pending waits bind a numeric BrowserWindow ID, and only that original ID may answer. An app can reconnect during the grace with different window IDs, while the snapshot carries only the renderer's `mcp:ask` payload. Merely redisplaying the card in the new owner window does not rebind its saved wait; its answer can be rejected. A reused numeric ID in a new app lifetime has the reverse ambiguity. Existing `windowReset` cancels immediately and the current ask path returns window-not-ready immediately when no owner exists; relocating those methods unchanged does not implement the new grace or `ui_unavailable` thread record.

**Direction:** Define connection/window epochs, whether and how a pending ask rebinds after a fresh presence snapshot, and cancellation when a session moves during grace. Assign the grace timer and terminal outcome record to W5's call-flow changes. Snapshot restoration must restore an answerable wait, not just its visual card.

### S14 — Spawn uncertainty and adoption ties have no settled recovery rule

**Severity:** should-fix. **Lanes:** W1, W3, W6.

**Anchor:** architecture F1.4.5/F2; `terminal-runtime.ts`, `spawn`/`RuntimeTerminal.live`; `session-identity.ts`, generation labels/`TokenRecord`; supplied README, `spawn_pending`.

**Why:** hc explicitly permits an initial spawn to time out while the holder may already be starting the program. A lost RPC response has the same uncertainty. C1 has no pending/unknown-spawn state or documented reconciliation obligation; a normal rejected promise followed by a retry can launch another agent and rotate the token out from under the first. “One start in flight” only prevents concurrent calls while that promise exists. Adoption's highest-generation rule also does not decide between two live records with the same generation, or state how an unused newer token row is reconciled with the actually live generation.

**Direction:** Define spawn-pending and lost-response handling: reconcile by a stable launch identity before retrying, retain the corresponding token/generation until the outcome is known, and settle deterministic equal-generation handling. Make unavailable attach/input during `spawn_pending` distinguishable from a final failed spawn.

### S15 — The freeze tests allow wire-breaking changes while remaining green

**Severity:** should-fix. **Lanes:** contract lead, W1, W5.

**Anchor:** `test/unit/contracts.test.ts:25–33`, `:49–57`, `:74–79`; `FROZEN_SHAPES`/`SHIM_FROZEN_FIELDS`.

**Why:** The hc check proves only that listed names exist, not input types, requiredness, response shape, or schema compatibility; B1 is an existing counterexample. The frozen-surface checks compare `keyof` sets and field-name arrays. Changing a field's type, nullability, requiredness, literal/discriminant value, accepted rejection reasons, or error envelope need not change those names. These are exactly the changes that can strand a live shim after an update. `HcStatus.state`/`kind` also narrow schema strings to closed unions even though hc stores program-supplied words verbatim; unrecognized valid reports need an explicit normalization path.

**Direction:** Add executable compatibility fixtures for old C6 peers and frozen C2 calls, including negative/reconnect cases above, and validate the hc wire subset against schema types/results. Preserve unknown hc status words at the wire boundary and normalize them deliberately for the domain. Do not call these field-name checks a compatibility gate.

Only `./contracts-review.md` was written. No repository files were changed.
