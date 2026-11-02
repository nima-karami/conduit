# Contracts review 6

The process boundaries and most ownership decisions are clear. The contracts are not ready to freeze: same-name retry does not provide the promised spawn idempotency once the first program has finished. Several smaller gaps also require implementers to choose cross-lane interfaces or handshake behavior.

Reviewed the requested ADR, architecture, program, spike, ownership inventory, contracts, vendored schema, contract tests, fixtures, and supplied protocol notes. hc implementation claims below were checked against v0.1.16 source. Measurements already assigned to M1–M25 are not findings.

| Dimension | Rating | Reason |
|---|---|---|
| Requirements and quality attributes | 🟢 | Durability, existing behavior, degraded operation and trust limits are explicit. |
| Boundary quality | 🟡 | Ownership is mostly coherent, but C7 omits several necessary provider interfaces. |
| Pattern restraint | 🟢 | The supervisor, separate lifetimes and single writer each answer a stated failure or concurrency problem. |
| Data and state modeling | 🔴 | The spawn retry rule mistakes live-name exclusivity for persistent launch idempotency. |
| Change tolerance | 🟢 | Frozen cross-version surfaces are narrow, and the terminal runtime remains replaceable. |
| Failure realism | 🟡 | Restart authority and update waiting are explicit; pre-initialize reconnects and readiness timeouts remain underspecified. |
| Decision capture | 🟢 | Decisions, rejected alternatives and accepted trade-offs are recorded in detail. |

## Blocker

### B1 — A completed launch can execute again after its reply is lost

**Anchors:** `docs/specs/2026-11-01-three-process-architecture.md`, F2.2.3 and D21; `src/contracts/terminal-runtime.ts`, `TerminalRuntime.spawn`; `src/contracts/hc.ts`, `terminal.run.params.name`.

**Why:** The prescribed recovery blindly retries `terminal.run` with the original name and treats success as proof that the earlier run never registered. hc v0.1.16 checks name collisions only among **live** terminals. Its own test explicitly finishes a terminal and successfully creates another terminal with the same name. A command can therefore complete, lose its reply, and execute again when Conduit retries. This affects short commands and launchers that perform work before exiting, not merely long-running agents.

The implementation evidence is `Registry.create`, `live_named`, `resolve`, and `ids_are_never_reused_and_names_follow_their_live_holder` in [hc v0.1.16 terminals.rs](https://github.com/herdrdev/herdr-core/blob/v0.1.16/crates/herdr-core/src/terminals.rs#L218). Name lookup can recover a retained finished terminal, but the specified retry runs before making that distinction.

M24 tests collisions while the original terminal is live or preparing. Passing that measurement does not address completed-name reuse.

**Direction:** Replace the unconditional retry rule with an explicit recovery protocol covering retained finished records and outcomes that remain uncertain. Do not claim that a successful same-name run proves the earlier launch never happened. If arbitrary lost replies must be safely retried, require a durable launch receipt/idempotency mechanism or retain an unresolved outcome instead of automatically executing again. Update C1, D21 and the recovery tests together.

## Should-fix

### S1 — W4 has no contracted way to obtain W6’s cold-start scrollback replay

**Anchors:** `src/contracts/server-protocol.ts`, `sessions.start.result.prelude`; `src/contracts/terminal-runtime.ts`, `TerminalRuntime`; `src/contracts/server-ports.ts`; program workstreams W4 and W6; existing `src/scrollback-store.ts:62`, `replayForColdStart`.

**Why:** W4 owns `sessions.start` and must return the replay. W6 owns the scrollback ring and files. Neither C1 nor C7 exposes the replay operation: `tailLines` is explicitly limited to approximately 4 KiB and cannot supply the segmented cold-start replay.

Reading a file independently is not equivalent to the existing operation. `ScrollbackStore.replayForColdStart` chooses the current in-memory ring when available and records the replay tail. Independent implementations would either share W6 internals or invent an additional interface.

**Direction:** Add a lead-owned scrollback replay port, including its cold-start timing and state effects, and identify how W4 receives it through composition.

### S2 — The attention owner cannot receive visibility changes through C7

**Anchors:** `src/contracts/server-ports.ts:55`, `AttentionPort`; `src/contracts/server-protocol.ts`, `ui.presence` and `WindowPresence.visibleSessionIds`; architecture D27; program W5/W6; existing `src/session-activity.ts:183` and `:191`, `setVisible` and `dropWindow`.

**Why:** W6 owns attention; W5 owns the presence mirror. Existing attention behavior depends on visibility updates to acknowledge watched sessions and suppress attention episodes. `AttentionPort` exposes input/output reporting, reads and edges, but no presence update or equivalent subscription.

Consequently the prescribed ports cannot carry a required producer-to-consumer flow. W6 would need access to W5’s private mirror or an undeclared interface.

**Direction:** Contract the visibility update or presence subscription, including clearing visibility when the app disconnects. Keep the resulting attention decisions inside W6.

### S3 — Token-store mutation crosses W5/W6 ownership without an interface

**Anchors:** Program W5, W6 and the “import, don’t fork” lane rule; `src/contracts/terminal-runtime.ts`, `reconcile` steps 1–5; `src/contracts/session-identity.ts`, `TokenRecord`; `src/contracts/server-ports.ts`, `McpHostDeps`; architecture F2 and D21.

**Why:** W5 owns the hashed token store, while W6’s prescribed reconciliation loads it, deletes rows and persists resolved addresses. Spawn requires durable creation before `terminal.run` and an address update afterward. C7 provides no shared store interface or mutation ownership for these operations.

The imported host currently owns token minting and its private registry. W0b is described as a behavior-preserving port refactor, while W5 must add persistence and resume behavior without editing that host. The current lane and contract descriptions do not establish how those changes meet.

**Direction:** Define one authoritative token-store owner and a narrow interface for mint/reserve, resolve-address, read and revoke operations. Explicitly assign the host changes or extension points needed for durable identity and resume. W5 and W6 should not independently update the same JSON file.

### S4 — C6 does not finish defining reconnect behavior before initialize succeeds

**Anchors:** `src/contracts/shim-protocol.ts:45–49`, `:57–78`, and `SHIM_ERRORS`.

**Why:** Three connected cases remain ambiguous:

- A connection receives welcome, relays `initialize`, then drops before the result. The phase remains `init-pending` and the request must be resent. However, only the first `CONNECTING` has the fallback deadline; pre-initialize `RECONNECTING` has no stated bounded escape. The client can therefore wait indefinitely without ever obtaining its handshake.
- The outstanding-request map is failed on disconnect, while the initialize request must survive and be resent with the same ID. The contract does not expressly exempt that request from `outcome_unknown`; emitting that error and later forwarding a successful replay would produce conflicting responses.
- FALLBACK can begin before stdin supplies any initialize request. Its first successful connection is nevertheless prescribed to carry the cached initialize as `resume`, which does not exist in phase `idle`.

These are local state-machine gaps, independent of hc measurements.

**Direction:** Specify connection transitions for each initialize phase. Preserve a pending initialize without fabricating a terminal response, define a bounded pre-initialize recovery path, and use `resume:null` when no successful initialize exists. Add recorded transition cases alongside the existing hello fixtures.

### S5 — The hello timeout does not clearly bound runtime startup

**Anchors:** Architecture F1.4–F1.6 and D17; `src/contracts/server-protocol.ts:33–36`, `APP_HELLO_TIMEOUT_MS`; `ServerMethods.hello`; `RuntimeHealth`.

**Why:** F1 says C2 is served immediately with `runtime: starting`, and the app subsequently calls hello and subscribes. The hello result contains version and identity, not readiness. If W3 answers hello immediately and then stalls during hc connection or reconciliation, the 20-second hello timeout has already succeeded; it cannot produce the promised startup-unavailable state.

Alternatively, W3 could withhold hello until startup settles, but that behavior is not specified. W3 and W7 therefore need to invent which event the timeout actually bounds.

**Direction:** State whether hello waits for startup to settle, or introduce a separate deadline for leaving `starting`. Specify the resulting unavailable transition without adding another restart authority.

## Scope notes

The supervisor as sole restart authority, pipe-based instance lock, exhaustion marker, explicit hung-service recovery and waiting for the old supervisor’s terminal to finish are consistent at the design level. Their Windows survival, child-job behavior, runtime-directory liveness and resize assumptions have explicit spike measurements and are not findings here.

**Verdict: REVISE**
