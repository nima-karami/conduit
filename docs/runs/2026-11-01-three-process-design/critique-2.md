# Architecture critique — round 2 (fresh Opus critic, 2026-11-01)

Reviewed: revision 2 of ADR 0007, `three-process-architecture.md`, `-program.md`, `hc-runtime-spike.md`,
`main-ts-ownership.md`, `src/contracts/*`.

**Verdict: REVISE.** The process split is well argued and restrained. What blocks it is producer/consumer
gaps: the design changes who reads some data but never designs who writes it (the MCP shim command path,
the notice gate's draft state, the scrollback ring). The design also calls the shim protocol "frozen"
without contracting it, and leaves a few failure paths that quietly break the survival guarantee.

| # | Dimension | Score |
|---|---|---|
| 1 | Requirement & QA fidelity | 🟡: "survives app crash" is never measured against a Windows tree-kill; "no UX regression" is contradicted by the dropped scrollback replay and a cold launch that waits on the server |
| 2 | Boundary quality | 🟡: a crisp ownership rule, but workstream path ownership overlaps and parallel moves break `main.ts` imports |
| 3 | Pattern restraint | 🟢: every layer answers a stated force |
| 4 | Data & state modeling | 🔴: three changed consumers have no designed producer; the terminal generation has no persisted source of record |
| 5 | Change tolerance | 🟡: the irreversible cross-version surfaces are misnamed (shim↔server, app/server↔old hc core) |
| 6 | Failure & scale realism | 🟡: hc start failure blocks the IDE, GC can half-delete a live dir, the F11 fallback voids the pin, and tree-kill survival has no mechanism |
| 7 | Decision capture | 🟢: a few contradictions, listed as nits |

## Blockers

- **B1 — The shim command path's producer is unexamined.** `install-entries.ts`, `mcp-install.ts:125`
  and `mcp-launch.ts` write `command: execPath` (the install-dir `Conduit.exe`) plus
  `ELECTRON_RUN_AS_NODE=1` into user-global CLI configs. No lane owns these files. Rewriting the
  entries to a *versioned* runtime dir breaks once GC deletes it. Direction: a version-stable shim
  path, lane ownership of those files, migration of existing entries, and an M16 check for a v0.51
  entry.
- **B2 — The "frozen" shim protocol has no contract, and D12 contradicts it.** Today's shim is a
  byte relay that falls back for good on close; the host keeps per-connection state (client kind,
  last listed tools, the no-initialize grace). The reconnect behaviour is unspecified. Direction: a
  lead-owned C6 `shim-protocol.ts` with a reconnect state machine and replay set, frozen-shape tests,
  and a D12 that lists every cross-version edge.
- **B3 — The notice gate needs draft *state*; C2 sends only *activity*.** `draft-input.ts:nextDraftState`
  clears only on `\r` or `^C`. A debounced ping can't tell submitted from drafted. Direction: compute
  it app-side, send `{sessionId, hasDraft}` on edges, and include it in presence.

## Should-fix

- **S1** The scrollback-persistence subsystem is orphaned: its producer, the PtyHost output →
  `ScrollbackStore`, is deleted, and its consumers (restore, `spawnPrelude`, orphan sweep, setting,
  briefs) are unassigned. The ADR's reboot wording also contradicts `keep:false`.
- **S2** The generation has no persisted record. Duplicate labels are possible, and so is a crash
  between `terminal.run` and token persistence. Direction: a `conduit.generation` label, persist the
  token before run, and adopt tie-break = highest generation, kill the rest.
- **S3** GC by "locked file" deletes the unlocked `.js`/`.cjs` files under a live process, and the copy
  isn't atomic. Direction: liveness per dir, copy to `.tmp`, then rename.
- **S4** The F11 fallback runs a new client against an arbitrarily old core, a pairing no e2e covered.
  Direction: a minimum core version plus feature detection, or a hard M13.
- **S5** Server survival of an End task or tree-kill has no mechanism (Node can't set
  `CREATE_BREAKAWAY_FROM_JOB`) and no measurement.
- **S6** A failing hc or server blocks the whole IDE, and first paint waits on the server. Direction:
  a degraded runtime state, a window from a settings cache, a cold-launch budget.
- **S7** C2 has `unknown` holes where lanes meet: store values, `data.changed.value`, `mcp.install*`.
- **S8** Workstream ownership overlaps (`session-screens.ts`), and parallel moves break un-owned
  importers. Direction: phase-3 lanes add code only; W7 alone moves and deletes.
- **S9** M16, the costliest gate, runs last. Direction: an M16-lite in phase 2.
- **S10** The frozen-shape test compares a literal to itself, and `satisfies` checks only method names.
- **S11** The observer's headless model can desync on resize: the 0.1.16 attach has no
  `resize_notifications`, and `size` events on channel 0 aren't ordered with DATA.

## Nits

- **N1** The `frames.ts` header says C2 is framed, contradicting D5.
- **N2** F7.5 (reconnect keeps asks) vs F4/D8 (deny at once): pick one, or add a grace window.
- **N3** The idle exit ignores pending timers.
- **N4** Neither the core nor the server is stopped on uninstall; an idle core locks `runtime/hc/<v>`
  forever.
- **N5** Nobody calls `terminal.rm` on finished records.
- **N6** W1's integration test needs the hc binary from W9 and a Linux hc on ubuntu CI; move it to e2e.
