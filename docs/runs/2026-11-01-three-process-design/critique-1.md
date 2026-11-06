# Architecture critique — round 1 (fresh Opus critic, 2026-11-01)

Reviewed: ADR 0007, `docs/specs/archive/2026-11-01-three-process-architecture.md`, `-program.md`, `hc-runtime-spike.md`,
`src/contracts/*.ts` at the first draft.

**Verdict: REVISE.** The ownership rule and D1/D3 are sound. But the design's main promise, that
agents survive an update, fails against the NSIS installer. Surviving agents lose MCP identity on any
server restart. A fixed contract (C1 `spawn(size)`) can't be implemented on hc. And most of the work
of moving logic out of `electron/main.ts` has no lane.

| # | Dimension | Score | Justification |
|---|---|---|---|
| 1 | Requirement & QA fidelity | 🟡 | Durability across quit/crash/update is clearly the dominant attribute. But non-goals are scattered, ADR context names an out-of-scope force (remote / second client), and W7 adds unrequested features. |
| 2 | Boundary quality | 🔴 | The server/app ownership table is good. But the stores and logic it moves to the server live in `electron/main.ts` with no lane owning the move, and server-side policy reads an app-owned map that C2 never carries. |
| 3 | Pattern restraint | 🟡 | D1/D3/D6 answer stated forces. C6 (a second tool-plugin mechanism) and the D12 compat machinery solve forces the design doesn't have. |
| 4 | Data & state modeling | 🔴 | MCP tokens exist only in memory. The C2 snapshot omits pending asks. Spawn size has no producer on hc. |
| 5 | Change tolerance | 🟡 | C1/C3/C5 are frozen before the spike answers the questions that shape them (M3/M4/M11, D13). |
| 6 | Failure & scale realism | 🔴 | The update path breaks the survive-update requirement: install-dir binaries are locked or force-killed, and no flow bumps hc's version. |
| 7 | Decision capture | 🟡 | The D-table with trade-offs is strong. But the ADR and the spec contradict each other on approvals with no app, and D13 is deferred while its contract is claimed stable. |

## Blockers

**B1 — "Survives app update" breaks against the installer (Dimensions 6, 4).**
- Every agent's MCP shim runs as the installed `Conduit.exe`: `src/conduit-mcp/install-entries.ts` sets `command: execPath` with `ELECTRON_RUN_AS_NODE: '1'`. The detached server is the same exe (D2), and the hc core is started from `resources/hc/hc.exe` in the install dir.
- The repo already records that "the auto-update installer can force-kill the process" (`electron/main.ts` before-quit, ~5121). NSIS one-click is set up with silent `quitAndInstall` (`electron/updater.ts:87`). So either the files are locked and the install fails, or the server and every agent's shim are killed.
- Surviving agents also keep running the *old* shim code, so F6's new-shim reconnect never reaches agents spawned before the release.
- No flow bumps the pinned hc across an app update.
- Direction: run the server and hc from a versioned copy outside the install dir, have the updater stop only the server, make the shim's launch path version-stable, add an F11 "hc bump", and add a real-installer e2e.

**B2 — Surviving agents lose MCP identity on any server restart (F6, F9) (Dimension 4).**
- The token→session map is in-memory only (`createSessionRegistry` in `src/conduit-mcp/session-registry.ts`; host comment: "it dies with the PTY", `electron/conduit-mcp-host.ts:961`). A restarted server has an empty registry, so every reconnecting shim resolves to nobody.
- C4 says the record holds a token, but `Session` has no token field. Persisting a secret is an undecided security choice.
- Direction: decide token persistence (e.g. an at-rest hashed store) and specify the adopt step that re-binds tokens.

**B3 — hc can't spawn at a size and has no resize RPC; C1 and F2 assume both (Dimensions 4, 6).**
- `terminal.run` has no `cols`/`rows`, so every hc terminal starts at the core default and gets resized on first attach. That's a ConPTY repaint on every pane open, not just in F3.
- C1 `resize()` has no hc method; doing it through a non-observe attach makes the server the last active viewer and breaks the single-resizer invariant.
- Direction: remove `size` from spawn and drop or redefine `resize`. Measure the first-attach repaint in M3, or spawn with an immediate active attach.

**B4 — Moving logic out of `main.ts` has no owner, and C2 lacks the RPCs it needs (Dimension 2).**
- Launchers, timed messages, agents config, settings, spawn specs and role briefs all live in `electron/main.ts` (439–448, 1320–1344, 2052, 2274–2282, 3122–3140). W6 owns that file and W3 owns `server/**`, so nobody owns the server half.
- C2 lacks launcher rescan and remove-custom, timed-message scheduling, and several `ControlDeps` members (`openSession`, `addRoot`, `git`, `windowReady`).
- Direction: add a lane for the domain move and enumerate every renderer message in `main.ts`'s switch that changes owner.

## Should-fix

- **S1** The ADR's "asks are queued, raise an OS notification, then deny on budget" contradicts F7/D8 "deny immediately" and D9 "no server notifications". Reconcile.
- **S2** The C2 snapshot lacks pending asks, `mcp:state` and attention, so an app that relaunches mid-ask never re-shows the card. Control tools' reach/move read `ownerWindowOf`/`windowReady` (`src/conduit-mcp/control-tools.ts:59–80`), but `WindowPresence` carries no ownership. Add both.
- **S3** The gate runs after the build, and C1/C3/C5 freeze before the spike. `WriteOutcome` lacks `terminal.send`'s hold and blocked-refusal outcomes. Direction: run the spike right after W0+W1, freeze after M2/M3/M4/M11.
- **S4** Several hc defaults collide with Conduit's own behaviour: children die with the parent, notes get typed into parents unless `no_notify`, `terminal.send` holds keys and presses Enter, `keep` respawns shells, and `HC_TERMINAL_ID` is inherited. Direction: `HcBackend` always passes `no_parent`/`no_notify`, decides `keep`, and strips `HC_*` from the server env, written down as invariants.
- **S5** The trust change is understated. An agent can reach the deterministic hc endpoint and `send/keys/run/kill/file.write/machine.exec` on siblings, bypassing Off/Ask/On for what `close_session`/`focus_session`/`open_session` gate. The user's own skills teach agents to drive hc. Accept explicitly, or mitigate.
- **S6** C3 claims to be typed from the vendored schema, but no schema is vendored and the types already drift: missing events (`keep`, `turn`, `foreground`, `doc`), missing fields, and missing `resumed`/`caller` on attach. Vendor the schema and test the subset against it.
- **S7** D12's compat test is names-only, and since D11 restarts on any mismatch only `hello` and `server.restart` cross versions. Freeze just those two.
- **S8** W7/C6 are scope creep and speculative generality; C6 also diverges from `PreparedCall` (no `routesUi`). Cut them.
- **S9** F2's cold-start races (`coldStartsInFlight`, `preSpawnSizes`, `electron/main.ts:1676–1683`) now cross a process boundary, and the spec is silent. Specify who holds the latest size and how starts dedupe.

## Nits

- **N1** `ESC7…ESC8` is display-side replay framing (`src/scrollback-persistence.ts:117`), not input typing. Reword the invariant and M11.
- **N2** The tool-module type test is true by definition. Drop it.
- **N3** ADR context item 3 (remote / second client) is out of scope. Make it a non-goal, and add a non-goals list.
- **N4** Three screen models per terminal. State why `terminal.read` isn't enough: `screen-verdict` needs the dim-style mask.
- **N5** F4's idle exit says nothing about the hc core.

**Summary:** the boundaries are right, but the update path, token persistence, hc's spawn and resize model, and lane ownership of the `main.ts` move must be fixed in the contracts before any lane starts.
