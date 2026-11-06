# Contracts review 7

The three-process decision stands. The server boundary fits the product intent, but the contracts are not ready to freeze: windowless creation conflicts with retained policy behavior, and launch recovery can discard identity or execute a launch twice.

Reviewed the requested documents, all C1–C7 files, the complete vendored OpenRPC schema, contract tests and fixtures, with `product-intent.md` read first. Checked relevant implementation paths in the tagged hc v0.1.16 source. This was a static, read-only review; tests were not run. No critique or prior review files were read.

| Dimension | Assessment |
|---|---|
| Requirement fidelity | Red — F3's windowless MCP creation cannot pass the retained gate. |
| Boundaries | Green — session/domain state and durable messaging have server ownership and explicit ports. |
| Pattern restraint | Green — the split addresses stated lifetime problems without building the deferred stores or cloud system. |
| Data and state | Red — a negative hc lookup is treated as sufficient evidence to revoke an unresolved launch. |
| Change tolerance | Yellow — future stores fit; app authority and local transport assumptions must change for shared or remote clients. |
| Failure realism | Yellow — shutdown admission, shim promotion and fast exits need additional contract semantics. |
| Decision capture | Green — trade-offs, rollback and empirical spike gates are explicit. |

## Findings

### 1. blocker — F3 cannot create workers without a ready app window

**Anchors:** `docs/specs/archive/2026-11-01-three-process-architecture.md`, F3 (line 226); `docs/specs/archive/2026-11-01-three-process-program.md`, “Lane rule” and W0b/W5; `src/conduit-mcp/tool-policy.ts:385`, `gateToolCall`; `electron/conduit-mcp-host.ts:827`, the `ownerReady` argument.

F3 promises windowless MCP `open_session`/`open_terminal`. The program imports the existing MCP modules unchanged, while W0b promises no behavior change. That gate rejects **every non-messaging tool** when `ownerReady()` is false, including an open configured with `access:on` and `when:always`. The host derives readiness from the owner window; the ownership map explicitly makes missing presence fail closed. Consequently, the call fails with `window_not_ready` before reaching W4's server-side creation.

This directly blocks the product's unattended lead-agent workflow, even though existing agents can continue exchanging messages.

**Direction:** specify which existing server actions can execute without UI when policy permits them, separately from visibility checks, approval waits and renderer actions. Assign the necessary shared policy change to an authorized lane; do not leave W5 to invent an exception to the import rule. The accepted five-second denial of unattended asks can remain.

### 2. blocker — D21 has no safe negative proof for an unresolved launch

**Anchors:** `src/contracts/terminal-runtime.ts:99`, `reconcile` step 3, and lines 111–116, the list-then-retry algorithm; architecture F2.2.3 and D21; `src/contracts/session-identity.ts`, `TokenRecord`; hc v0.1.16 [`api/run.rs`, `start`](https://github.com/herdrdev/herdr-core/blob/v0.1.16/crates/herdr-core/src/api/run.rs#L78).

The pinned implementation awaits holder preparation and environment acquisition **before** registering the named terminal (`start`, lines 83–96 versus 145). A reconnecting server can therefore receive `terminal.get(launchId) → not_found` while the original request is still preparing. C1 then revokes its token row. If the request subsequently registers, its identity has been discarded: it becomes an orphan for cleanup, and its shim can receive permanent `unknown_token` fallback.

The spawn retry has the corresponding race: listing finds nothing; a retry registers, runs and finishes while the original request is still preparing; the original then acquires the now-free name and runs too. Keeping the retry's finished record does not prevent that original request from executing.

There is also a concrete schema/implementation mismatch: the same tagged `start` timeout branch retains a pending claim only under `keep:true`; its `keep:false` branch removes the record (lines 168–179). C1's fixed flags therefore cannot rely on the schema's general `spawn_pending` description to supply the promised confirmation path.

Finally, Conduit is not the only record remover: hc expires finished records after a day and caps them at 500 ([`terminals.rs`, `expired`](https://github.com/herdrdev/herdr-core/blob/v0.1.16/crates/herdr-core/src/terminals.rs#L348)); pruning runs at startup, completion and listing ([`runtime.rs`, `prune`](https://github.com/herdrdev/herdr-core/blob/v0.1.16/crates/herdr-core/src/runtime.rs#L684)). “We never call rm before recording the outcome” is insufficient as a retention guarantee.

**Direction:** preserve unresolved reservations across negative lookups and reconnects, and stop authorizing retries from absence alone. Resolve the upstream claim/timeout semantics, or explicitly retain an uncertain outcome without re-execution. Define late confirmation and explicit resolution of the same launch. These are source-proven counterexamples to the normative recovery rules; a successful M24 sample cannot establish the missing guarantee.

### 3. should-fix — stop-all and update shutdown do not settle in-flight launches

**Anchors:** architecture F12 (line 350), F6.3 and F4; `src/contracts/server-protocol.ts:172`, `server.stopAll`; architecture F2's asynchronous `sessions.start`; program W3/W4/W5/W6.

F12 persists, kills the enumerated session terminals, removes identity, replies and exits. It does not first stop admission or settle launches already preparing. An MCP open can register after the kill enumeration, or another start can enter while asynchronous kills run. The supervisor then sees that surviving terminal and deliberately leaves hc running. “Stop all agents” has returned while an agent survives. A pending run crossing an update can likewise register after the replacement server's initial reconciliation.

**Direction:** define a server stopping transition shared by C2, MCP creation and runtime spawning. Refuse new starts, settle or explicitly retain outstanding reservations, and establish the final kill/persistence boundary before replying or handing over. Specify how the replacement handles any deliberately retained uncertain launches. W3 cannot implement this solely as endpoint close plus process exit.

### 4. should-fix — C6 can promote a socket whose hello no longer matches the shim's initialization state

**Anchors:** `src/contracts/shim-protocol.ts:62`, FALLBACK and transition table, especially lines 73–84; `SHIM_INITIAL_CONNECT_DEADLINE_MS` versus `SHIM_WELCOME_TIMEOUT_MS`; `test/fixtures/contracts/shim-hello.json`, `transitions`; `test/unit/contracts.test.ts`, “resumes in each recorded transition”.

A connection attempt can send `hello{resume:null}` while the shim is idle. Before its welcome arrives, the two-second deadline can answer a buffered initialize locally, changing the phase to `init-done`; the welcome timeout is three seconds. The same ordering is possible during FALLBACK retries when initialize arrives between hello and welcome. The accepted socket has never delivered initialize or resume to the server, although the client has received a successful local initialize. The rule “first successful connect, phase init-done → hello with resume” cannot change the hello already sent.

The fixtures only describe separate hello lines; their test checks phase labels and resume presence, not this ordering. Implementers must choose an additional transition to avoid either an uninitialized promoted connection or a second initialize response reaching the client.

**Direction:** define promotion relative to the initialization snapshot actually sent on that attempt. If local initialization changes it, explicitly abandon/re-hello or complete an internal initialization exchange before relaying. Pin the hello → local initialize → welcome ordering, including exactly one client response.

### 5. should-fix — a command finishing before attach has no output/display contract

**Anchors:** architecture F2.2.3–F2.3; `src/contracts/terminal-runtime.ts:31`, `RuntimeTerminal.state`, and `spawn`; `src/contracts/server-protocol.ts:203`, `sessions.start` result; `src/contracts/hc.ts`, `HcMethods`; vendored `hc.openrpc.json`, `terminal.attach` and `terminal.read`; program W6's removal of recorded exits.

A short command can finish before the server obtains its active attach, including between the run reply and attach. hc only attaches to live programs. C1 explicitly handles a recovered finished record, but C2's successful start always supplies a live attach target, and F2 always observer-attaches. There is no completed-start result or final-output transfer. `prelude` is previous scrollback; this run produced no active-stream bytes for its ring. C3 omits `terminal.read`, although hc provides it for finished terminals. Recording the exit and removing the terminal can then erase the only retained output.

**Direction:** define completion-before-attach through C1 and C2, capture the retained final output before removal, and give W7 a completed display path without requiring a live observer attach. Cover a normal fast exit, not only lost-reply recovery.

## Product fit and bounded future reversals

The server's session/domain ownership, durable MCP inbox/attachments and independent lifetime are suitable foundations for intent/task and report/artifact stores. Adding those stores does not require undoing C7. Keeping the human editor and existing repository `.conduit` documents in the app does not itself prevent a separate authoritative server store. Finding 1 is the concrete obstruction to windowless lead agents in this program.

### 6. nit — shared clients will require replacing app-driven server-version authority

**Anchors:** architecture “Cross-version edges”, F6 and D26; `src/contracts/server-protocol.ts`, frozen `hello`/`server.restart`, `WindowPresence`, `UiRoute`, `ui.presence`; `src/contracts/server-ports.ts`, `AttentionPort.clearAll` on app disconnect.

The current app can restart an older server to match its own version, supplies the complete owner-window map, and clears all visibility on disconnect. Several app clients cannot independently exercise those rules: one client's version or disconnect would affect the others' service and presence. This is a specific future reversal of client authority and connection scope, rather than a need to replace the server's domain stores.

**Direction:** record these rules as single-app assumptions that must change before multi-client support. No multi-operator implementation is needed in this program; keep them out of any claimed enduring shared-client contract.

### 7. nit — cloud deployment will require replacing the local bootstrap and direct-access edges

**Anchors:** architecture F1 and D25; `src/contracts/session-identity.ts`, `InstanceNames`; `src/contracts/terminal-link.ts`, `AttachTarget`; `src/contracts/server-protocol.ts`, `SERVER_SETTINGS_FILE`.

The app currently starts and garbage-collects the server/hc runtimes under its own userData, reads the server's settings file directly, and reaches hc separately using a target containing only session and terminal identifiers. Moving just C2 to a remote endpoint would leave these operations local. Those bootstrap, settings-read and terminal-access assumptions must be replaced for a remote server; the server stores and domain ports can remain.

**Direction:** identify these concrete local edges in the deferred-cloud boundary. Keep their locality confined to bootstrap/client transport code instead of making local filesystem access a server-domain requirement. This does not call for a cloud design now.

The other M-table outcomes remain spike decisions. No finding is based on unmeasured paint boundaries, resize convergence, GC rename behavior, Windows job survival, environment isolation or handover performance.

Verdict: REVISE
