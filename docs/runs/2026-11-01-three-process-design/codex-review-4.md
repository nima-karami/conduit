REVISE — The process boundaries are justified, but crash recovery and typing still contain contract gaps that independent lanes cannot resolve consistently.

| Dimension | Rating | Assessment |
|---|---|---|
| Requirements and quality attributes | 🟢 | Durability, unchanged UX and containment are explicit and ordered; reboot survival is clearly excluded. |
| Boundaries | 🟡 | Server/app/runtime ownership is mostly clear; attached-writer ownership is not represented in C2. |
| Pattern restraint | 🟢 | The server and supervisor each address stated lifetime constraints; hc remains an unmodified dependency. |
| Data and state completeness | 🔴 | Null-address launch recovery, pending spawn exposure and typing transitions lack complete producer/consumer rules. |
| Change tolerance | 🟡 | Frozen shim boundaries are appropriate, but downgrade shutdown depends on an unfrozen operation. |
| Failure realism | 🔴 | Several Windows risks have explicit measurements, but the proposed lease API does not exist in stock Node and crash-window recovery can kill surviving agents. |
| Decision legibility | 🟢 | ADR, numbered decisions, flows, workstreams and ownership inventory make trade-offs unusually inspectable. |

### Blockers

**B1 — Startup reconciliation kills a successfully spawned terminal whose address was not persisted.**  
**Dimension:** Data/state completeness; failure realism.  
**Anchors:** `src/contracts/session-identity.ts:29` (`hcAddress:null` written before run); `src/contracts/terminal-runtime.ts:67` (`reconcile` matches address plus launch identity and kills unmatched terminals); architecture F2.2.1–3 and D21.

A server can crash after hc successfully creates the terminal but before the RunResult’s address reaches `tokens.json`. On restart the persisted row has the correct launch ID but a null address. The specified address-plus-launch match fails, so reconciliation treats the surviving agent as an orphan and kills it. F2’s reconciliation of a timed-out/lost run does not specify recovery of this persisted intermediate state during fresh server startup.

**Direction:** Before orphan cleanup, explicitly reconcile unresolved token rows by launch ID, persist the recovered address, and define handling of zero or multiple matches. Apply the same procedure after a lost response and after a server crash.

**B2 — D19 has no ownership-transfer protocol between hc submission and app attachment.**  
**Dimension:** Boundaries; data/state completeness.  
**Anchors:** `src/contracts/server-protocol.ts:53–60` (`WindowPresence`); C2 `ui.presence` at line 210; C1 `submit` at `terminal-runtime.ts:79–82`; architecture F8/D19; vendored schema `terminal.send` description at `hc.openrpc.json:1976`.

Presence reports owned and visible sessions, but neither identifies an attached TerminalLink. Ownership, visibility and attachment are different states during startup, pane disposal, reconnect and window moves. More seriously, a server `terminal.send` can already be waiting on hc’s roughly three-second quiet gate when the app attaches. The schema says hc holds human keys during that send, then delivers them. Merely changing the server’s routing decision after presence arrives cannot cancel or fence that operation.

Consequently both processes can perform writes during the transition, violating the core invariant even if each follows its own local contract.

**Direction:** Specify an attached-writer claim/release handshake and its generation/connection scope. Define when attachment may accept human input, how pending server sends drain or are resolved, and what happens when `ui.type` is outstanding as the link or C2 connection disappears. Carry the necessary attachment state in C2.

**B3 — Moving the gate before `ui.type` removes the current queue-slot safety check.**  
**Dimension:** Requirements; data/state completeness.  
**Anchors:** Architecture F8 at lines 209–213; C2 `ui.type` at `server-protocol.ts:252–255`; existing `electron/conduit-mcp-host.ts:615–627`; `src/pty-writer.ts` `run()` and serialized submit chain.

Today `beforeText` executes when the writer obtains its serialized slot. It checks the screen, draft, connection and policy at that point, then captures input sequence and the adapter used for the Enter recheck. The proposal checks the server gate before emitting `ui.type`. Transport delay and an earlier queued submit can intervene before the app writes text. A human can start a draft during that interval; the proposed input-sequence check only withholds Enter after the text has already been inserted into the draft.

C2 supplies only request ID, session, generation and operation. It supplies no gate precondition/input sequence or adapter identity, and specifies no fresh before-text authorization at the writer slot.

**Direction:** Preserve the queue-slot gate as an explicit distributed transaction: either obtain fresh server authorization when the app reaches the slot, or specify app-verifiable preconditions and their invalidation. Define how the Enter check retains the admitted adapter and relevant policy/connection changes.

**B4 — D23 names an unavailable Node API for the leases and GC lock.**  
**Dimension:** Failure realism.  
**Anchors:** Architecture “Leases and GC” at lines 75–80 and D23; C4 runtime-lease comment at `session-identity.ts:69–72`; program W9.

`fs.constants.UV_FS_O_EXLOCK` is not exposed by stock Node. Node’s exported constants omit it, while libuv defines the Windows flag internally. Thus the specified pure-JS implementation cannot use the named property; coercing an undefined property into a bitmask would silently omit exclusivity. This affects both live-process leases and the lock intended to serialize GC. See [Node’s constant exports](https://raw.githubusercontent.com/nodejs/node/v22.16.0/src/node_constants.cc) and [libuv’s Windows flag definitions](https://raw.githubusercontent.com/nodejs/node/v22.16.0/deps/uv/include/uv/win.h).

**Direction:** Pin the bundled Node version and choose a supported lock mechanism, or an explicit, narrowly scoped Windows flag adapter whose behavior is verified against that binary. Do not freeze the nonexistent property into the contract.

### Should fix

**S1 — Pending spawns cannot cross C2.**  
**Dimension:** Data/state completeness.  
**Anchors:** C1 `RuntimeTerminal.state` at `terminal-runtime.ts:23–24`; C2 `sessions.start` at `server-protocol.ts:154–169`; C4 `SessionRuntime`; `src/types.ts:40` and `StartRefusal`.

C1 can return `pending`, and F2 prohibits attaching or typing until it resolves. C2 success always supplies an attach target, while failure is restricted to the existing `unresolvable` refusal. Neither `SessionView.runtime` nor the session status exposes pending. Holding `sessions.start` indefinitely would itself be an invented behavior, and hc explicitly permits an unresolved spawn claim to remain pending.

**Direction:** Define the C2 pending response/state, its eventual transition notification, and subsequent start/kill behavior.

**S2 — The shared typing operation erases distinctions between notices, timers and add-dir.**  
**Dimension:** Requirement fidelity.  
**Anchors:** Architecture F8 and C2 `TypeOp`; existing `electron/main.ts:1729–1736`, `electron/main.ts:3011–3026`; `src/add-dir-delivery.ts:47`.

Existing timed messages deliberately use the bare writer rather than the notice gate. Add-dir uses a separate readiness/busy/bracketed-paste gate and records the paste as a draft; it does not require an empty input box. F8 describes a screen/idle/draft gate for attached typing generally, while `TypeOp.submit` groups timers with notices and `raw` does not identify the add-dir policy.

An implementation following the broad F8 wording can suppress existing timer delivery or reject human-requested add-dir actions under notice-only conditions.

**Direction:** State the policy for each intent and preserve those distinctions through the routing API, including which operations require echo/Enter checks and which create a draft.

**S3 — Downgrade shutdown has no frozen cross-version operation.**  
**Dimension:** Change tolerance.  
**Anchors:** Architecture Connections/D12 at lines 116–120; D26; C2 `server.stopAll` at line 135 and `FROZEN_SHAPES`.

D26 offers an older app “Stop all agents and continue,” but only `hello` and `server.restart` are frozen. `server.stopAll` is outside that boundary, and restarting the newer server does not stop its agents. The older app therefore lacks a specified operation it can safely use to carry out the offer.

**Direction:** Freeze the required stop operation or define a shutdown path through an already frozen edge, including token cleanup and supervisor termination.

**S4 — C6 assigns process-lifetime input state to individual connection attempts.**  
**Dimension:** Data/state completeness.  
**Anchors:** `shim-protocol.ts:45–48` and `68–70`.

The contract requires an unanswered initialize to be resent with the same ID after reconnect, but also says request maps and parser buffers belong to one attempt. The initialize request’s ID/payload must survive that attempt. Likewise, a partial stdin line belongs to the unchanged MCP stdin stream: dropping it when the host socket changes corrupts the request completed by the next stdin chunk. Server-response parser fragments, in contrast, must be discarded with their socket.

Also, `init-done` currently means any response reached the client, which includes an initialize error.

**Direction:** Explicitly separate process-lifetime stdin/initialize state from attempt-lifetime response parsing and outstanding-request accounting. Define successful initialize completion separately from an error response before freezing C6.

**S5 — M21’s gate status contradicts the program’s phase-two gate list.**  
**Dimension:** Decision legibility; failure realism.  
**Anchors:** Spike M21 is marked `G`; architecture M21 is unmarked; program phase 2 at lines 56–59 omits M21.

A failed live-directory protection test is a stop condition in the spike, but not in the program’s enumerated decision gate. That ambiguity matters because hc’s uninstrumented core and draining holders depend on the rename check.

**Direction:** Make the three documents agree that failed live-directory protection stops GC adoption or requires a changed contract.

### Bounded assessment of the remaining platform risks

The vendored hc subset now uses flat run/get results and integer history consistently with the schema. Its framing, initial credit and observer limitations are represented coherently. Named pipes are an appropriate existing transport; no additional pipe-specific defect was established.

ConPTY rendering/input, spawn-before-attach resizing, observer reattachment, paint boundaries, job/tree-kill survival and executable-directory rename behavior remain empirical adoption questions covered by M2–M4, M8, M11–M14, M17–M19 and M21. Their outcomes should not be asserted before the spike. In particular, the current documents acknowledge the absence of `resize_notifications` in 0.1.16 rather than assuming the newer README capability.

The proposed NSIS `${ifNot} ${isUpdated}` guard addresses the actual update-time invocation of `customUnInstall`; no separate finding is warranted merely because the current hook has not yet been changed. M16’s update **from** a build containing that hook is the correct scenario.

No project files were edited.

REVISE
