**REVISE — the process split is justified, but uncertain-spawn recovery, resize ordering, and restart state still contradict the promised behavior.**

| Dimension | Score | Assessment |
|---|---|---|
| Requirements and quality fidelity | 🔴 | Survival and existing UX are explicit, but shell CLI notice binding does not survive the specified resume. |
| Boundaries | 🟡 | Ownership is substantially clearer; the W4 add-dir → W5 draft-state seam remains undeclared. |
| Pattern restraint | 🟢 | The server, hc adapter, and direct output path each address a stated force. |
| Data, state, and producer/consumer completeness | 🔴 | Spawn uncertainty, migration completion, and restored CLI binding lack sufficient state or ordering. |
| Change tolerance | 🟢 | Versioned runtimes, frozen shim compatibility, and a narrow runtime interface are appropriate seams. |
| Failure realism | 🔴 | The pinned hc implementation invalidates the run-reconciliation guarantee; lock recovery, fallback entry, and supervisor exhaustion have unhandled paths. |
| Decision capture | 🟢 | Trade-offs, rejected alternatives, operational budgets, and spike measurements are explicit. |

## Lane readiness

| Lane | Assessment |
|---|---|
| W1 — hc client | Its ordinary RPC/framing surface is implementable. It must not manufacture the pending-run or cross-direction ordering guarantees assumed by W6; see B1–B3. |
| W3 — server shell/supervisor | Node’s existing job behavior makes the supervisor feasible. Lock takeover and exhausted-supervisor handling need correction; see S1 and S3. |
| W4 — server domain | Settings migration and add-dir draft reporting need explicit coordination with their consumers; see B5 and S2. |
| W5 — server MCP/C6 | Resume lacks shell CLI binding restoration, and initial fallback entry is unspecified; see B4 and S4. |
| W6 — runtime/attention/ring | Cannot satisfy the written uncertain-spawn and screen-ordering guarantees against the pinned implementation as specified; see B1–B3. |
| W7 — app client/observer | Direct observer output is feasible, but resizing, settings stripping, and supervisor recovery require the corrections in B3, B5, and S3. |

## Blockers

### B1. A negative terminal listing cannot establish that an uncertain run will never start

**Dimensions:** Data/state; failure realism.

**Anchors:** `src/contracts/terminal-runtime.ts:69–85`; `docs/specs/archive/2026-11-01-three-process-architecture.md:161–165` and D21 at `:291`.

The contract drops a null-address token row when listing finds no launch-id match, while promising that reconciliation before retry ensures one launch never spawns twice.

Pinned hc performs asynchronous holder/environment preparation **before** registering the terminal. Framed requests execute concurrently, and a run task survives disconnection. A replacement connection can therefore list no match while the original run is preparing; that run can register after the row has been dropped and a retry authorized. The final reconciliation sweep can also classify that late terminal as an orphan. See [v0.1.16 `run.rs`:83–145](https://raw.githubusercontent.com/herdrdev/herdr-core/v0.1.16/crates/herdr-core/src/api/run.rs) and [framed dispatch in `server.rs`:286–315](https://raw.githubusercontent.com/herdrdev/herdr-core/v0.1.16/crates/herdr-core/src/server.rs).

**Direction:** Define a completion/cancellation or idempotency fence supported by the chosen hc version. Until that fence exists, absence must remain an uncertain outcome, retaining its token row and preventing automatic retry.

### B2. The pinned runtime does not provide the specified `keep:false` pending-spawn lifecycle

**Dimensions:** Requirements fidelity; failure realism.

**Anchors:** Architecture `:89`, `:170–173`; `src/contracts/terminal-runtime.ts:26–27`; `src/contracts/server-protocol.ts:174–190`; program W6 at `:55`.

The proposed domain distinguishes pending claims that can later become live or be explicitly killed. Pinned v0.1.16 preserves the timed-out claim only when `t.keep` is true; otherwise it removes the record and returns `spawn_failed`. Conduit explicitly requires `keep:false`. The supplied schema README’s broader description does not override this implementation. See [`run.rs`:163–185](https://raw.githubusercontent.com/herdrdev/herdr-core/v0.1.16/crates/herdr-core/src/api/run.rs).

**Direction:** Settle timeout and late-holder behavior against the pinned binary before freezing C1/C2/C4. Either select an hc version supporting this lifecycle under the required flags or revise the lifecycle and recovery guarantees.

### B3. A sole active viewer does not order resize against bytes already traveling toward either screen model

**Dimensions:** Data/state; failure realism.

**Anchors:** `src/contracts/hc.ts:177–181`; `src/contracts/terminal-link.ts:26–30`; architecture F2 at `:177–180`, F8 at `:231–233`, D19 at `:289`; spike M19 at `:39`.

Server ownership removes competing size writers. It does not establish a byte boundary between an old grid and a new grid.

For example, the app resizes xterm and sends C2 `term.resize` while old-grid DATA is buffered on its independent observer connection. Those bytes then reach the newly sized xterm. The server has the analogous full-duplex problem: issuing RESIZE does not establish that all old-grid inbound bytes have reached its headless model. C5 merely logs mismatched size events; it offers no fence or authoritative corrective paint. Pinned hc supplies size events on an event channel without ordered observer RESIZE frames. See the [v0.1.16 stream and event definitions](https://raw.githubusercontent.com/herdrdev/herdr-core/v0.1.16/schema/README.md).

This affects visible fidelity and the screen evidence used by the notice gate.

**Direction:** Specify a supported ordering/repaint mechanism for both consumers, or revise the hc pin and contracts. Exercise buffered output during resize, rather than testing only settled grid equality.

### B4. Resume restores MCP initialization but loses shell CLI notice binding

**Dimensions:** Requirements fidelity; data/state completeness.

**Anchors:** `src/contracts/shim-protocol.ts:27–31` and `:95–99`; `src/contracts/session-identity.ts:34–42`; program W5 at `:54`; existing `electron/conduit-mcp-host.ts:366–377` and `:936–946`; `src/conduit-mcp/client-info.ts:58–59`.

For an agent launched by typing into a shell session, the existing host chooses its notice adapter from the connection bound to a recognized typed command. Initialization binds that connection only when `r.lastLine` supplies matching typed evidence.

After a server restart, that evidence and binding are gone. C6 carries initialize params and the initialized flag; the persisted token row carries neither connection binding nor its evidence. Replaying initialization reconnects messaging but leaves the shell session without a notice adapter. Automatically binding every resumed client would change the existing protection against secondary clients taking over.

**Direction:** Define preservation and restoration of the admitted shell CLI binding, including multiple MCP clients sharing a terminal. Cover a typed Claude/Codex shell session across a server update, not only profile-launched agents.

### B5. The settings migration can erase its source before the server seeds its file

**Dimensions:** Data/state completeness; requirements fidelity.

**Anchors:** Architecture F1 `:128–143`, D7 `:277`; `src/contracts/server-protocol.ts:108–112`; program W7 `:56`; existing `electron/main.ts:3924–3932`.

The window and UI settings operate before server startup completes, while the app strips legacy server keys on its next settings write. Nothing conditions stripping on successful creation of `server-settings.json`.

A layout/settings write during delayed startup—or while the server is unavailable—can remove the v0.51 server values before the server reads them. Subsequent seeding uses defaults, potentially restoring messaging the user disabled or losing explicit tool policies.

**Direction:** Preserve legacy server keys until the server acknowledges a durably completed migration. Retries and app shutdown before that acknowledgment must preserve the migration source.

## Should-fix

### S1. Lock recovery does not establish safe ownership before killing a persisted PID

**Dimension:** Failure realism.

**Anchors:** Architecture F1 `:138–139`, D17 `:287`; program W3 `:52`; GC locking at architecture `:79–80` and `src/contracts/session-identity.ts:72–75`.

A PID in a stale lock can belong to an unrelated process after a crash/reboot and PID reuse. No answer from the Conduit pipe establishes endpoint unavailability, not process identity. The specified five-second timeout followed by killing that PID can terminate an unrelated application.

The `wx` GC lock also separates exclusive file creation from publishing its PID. A crash between those operations leaves an empty or partial record, which the stated “stale pid” cleanup does not describe.

**Direction:** Define process-incarnation validation and atomic lock takeover, including incomplete PID publication. Kill only a positively identified Conduit server. Recover empty/partial GC records under the app’s existing single-instance exclusion.

### S2. C7 omits the add-dir producer’s required draft-state notification

**Dimensions:** Boundary quality; producer/consumer completeness.

**Anchors:** `src/contracts/server-ports.ts:28–36` and `:46–51`; architecture F8 `:229`; program W4/W5 at `:53–54`; existing `electron/main.ts:3017–3020`, `electron/conduit-mcp-host.ts:1164–1171` and `:1439–1440`.

W4 owns add-dir delivery; W5 owns `hasDraft` and `inputSeq`; W6 supplies `TypingPort.write`. That port specifies a raw write and generation check, with no notification of W5’s draft tracker.

Today the add-dir producer explicitly calls `noteHostInput` **before** writing. Omitting that edge leaves a host paste unrecorded and can fail to withhold a notice’s in-flight Enter. Neither `AttentionPort.recordInput` nor raw PTY input supplies the missing draft update.

**Direction:** Add the small, explicit non-notice input hook and assign its wiring owner. Preserve the distinct policies for add-dir input, notices, and bare timed submissions.

### S3. The reconnect rule defeats the supervisor’s crash limit

**Dimension:** Failure realism.

**Anchors:** Architecture F9 `:238–243`, D17 `:287`; program W7 `:56`.

The supervisor gives up after five crashes and exits. The app’s reconnect rule immediately runs F1.3 whenever no live role=server terminal exists. An exhausted supervisor produces exactly that condition, so the app starts a fresh supervisor with a fresh counter. The documented bounded failure becomes an unbounded restart loop while the app remains open.

**Direction:** Distinguish exhausted supervision from accidental absence. Persist or communicate exhaustion and require the defined recovery action before resetting its crash budget.

### S4. C6 never specifies when an initially unreachable host enters fallback

**Dimensions:** Failure realism; state completeness.

**Anchors:** `src/contracts/shim-protocol.ts:54–65`, `:83–92`; existing fallback behavior in `resources/conduit-mcp/conduit-mcp-shim.cjs:88–100` and `:114–126`.

CONNECTING buffers stdin and retries; FALLBACK answers locally until a successful connection. The transition table defines retries for failures and welcome timeout, but supplies no transition or deadline from CONNECTING into FALLBACK.

A small initial `initialize` request stays below the buffer limit. With the server absent, following the written CONNECTING rules can therefore buffer it indefinitely. The advertised local initialization and later promotion never occur. Choosing a fallback threshold would require W5 to invent protocol behavior.

**Direction:** Define a bounded initial-connect policy, its transition into fallback, and continued retry behavior. State how the buffered initialize is answered exactly once and how subsequent successful connection uses the cached handshake. Keep this distinct from the already-initialized reconnect path.

## Verified non-findings and scope

- **C2/C3 resize, focus, and facts have actual wire operations.** `server-protocol.ts:259–261`, `terminal-runtime.ts:93–95`, `hc.ts:192–194`, and `frames.ts:13–15` connect these intents to hc’s RESIZE, FOCUS, and FACTS frames. B3 concerns ordering, not missing operations.
- **The pure-JS supervisor is feasible without a new native addon.** Node 24’s bundled libuv places non-detached spawned children in its kill-on-close job. Its assignment failure behavior still belongs in M23; “Node cannot implement this” would be incorrect. See [Node v24.13.0’s bundled `process.c`:65–114 and :1016–1034](https://raw.githubusercontent.com/nodejs/node/v24.13.0/deps/uv/src/win/process.c).
- **The NSIS update guard is correctly motivated.** The installed template invokes `customUnInstall` at `node_modules/app-builder-lib/templates/nsis/uninstaller.nsh:156–157`, before its update-specific branch at `:164`.
- **The rename test has an explicit empirical gate.** M21 must validate actual runtime paths and draining holders. The `wx` GC lock correctly supplies exclusive creation; S1 concerns recovery of its incomplete record, not confusion with an OS lease.
- The same-user hc control-plane residual, absent renderer backpressure, heuristic paint boundary, and no-reboot-survival decision are explicit trade-offs and were not reopened as findings. C6’s existing written rules address pending-initialize replay, cancellation removal, distinct string/numeric IDs, abandoned-socket callbacks, EOF, EPIPE, draining, and unsupported generations; B4 and S4 identify additional uncovered paths.

Read-only review completed. All required documents, every `src/contracts/*.ts`, the complete vendored OpenRPC schema, contract tests, sole fixture, and supplied hc README were read. Truncated initial outputs were reread in complete slices; the schema was read through all components and all methods. No critique files were read. No repository files were modified. This review is advisory.

Verdict: REVISE
