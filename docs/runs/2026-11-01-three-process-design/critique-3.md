# Architecture critique — round 3 (fresh Opus critic, 2026-11-01)

Reviewed revision 3.

**Verdict: REVISE.** The process split and ownership rule are sound. The blocker is in what crosses
the new boundary: today's human-keystroke stream feeds four server-side consumers, and the design
replaces it with one draft boolean. The scrollback ring's new producer also breaks its own
invariant, and several failure claims (D17 supervision, GC, adopt) don't hold up.

| # | Dimension | Score |
|---|---|---|
| 1 | Requirement & QA fidelity | 🟢 |
| 2 | Boundary quality | 🟡: the notice gate's inputs are split across W5/W6 with no contract between them |
| 3 | Pattern restraint | 🟢 |
| 4 | Data & state modeling | 🔴: the human-input consumers, the ring producer and the settings-cache producer |
| 5 | Change tolerance | 🟢 |
| 6 | Failure & scale realism | 🟡: the supervision overclaim, GC on Windows, forgeable adopt, server-unavailable undefined |
| 7 | Decision capture | 🟢 |

## Blocker

**B1. The human-input stream loses four consumers.**
- `term:input` → `mcpHost.onRendererInput` (`main.ts:4591`) feeds four things:
  - `detectTyped`: the line tracker that binds a shell to a CLI.
  - `noteInput`: `inputSeq`, `lastInputAt`, draft.
  - `renderer-input`: clears `unsent-notice` attention.
  - `mgr.touch`.
- `submitNotice` captures `inputSeq` at `beforeText` and refuses Enter if a human typed in between
  (`conduit-mcp-host.ts:595–635`).
- Draft-on-edges can't express "any keystroke between text and Enter". Human and server bytes now
  reach the PTY from two processes with no shared serialization point.
- `terminal.send` is atomic, so it can't host the Enter recheck either.
- Direction: name a producer for every consumer. Either per-chunk metadata (`seq`, `hasDraft`, typed
  command), or move the text/Enter interlock into the app, the only place both writers can be ordered.
  Define the gate with no app connected and after an app relaunch.

## Should-fix

- **S1** A ring fed from the observe stream picks up synthetic first paints and repaints (every
  re-attach, every server restart) and loses output during restarts, which breaks "exactly what was
  shown".
- **S2** W5 (host, `evaluateGate`) and W6 (screen model) have no contract between them. C1 exposes no
  screen snapshot.
- **S3** "The holder supervises the server" is overclaimed: with `keep:false` nothing restarts it, so a
  server death with no app leaves MCP, timers and attention down until the next launch. Decide
  explicitly.
- **S4** `.inuse-<pid>` doesn't lock: libuv opens with `FILE_SHARE_DELETE`, and hc never writes
  markers.
- **S5** The injected `HC_SESSION` puts agents' own `hc` use into Conduit's session. Unlabelled lanes
  could be killed by F4/F12, `hc update` from a pane swaps our pinned core, and config is shared
  (`%APPDATA%\herdr-core`).
- **S6** Adopt keeps the highest *label* generation, and labels are forgeable. Adopt by the address
  recorded at spawn instead.
- **S7** "Server can't start" (AV, copy failure, hung lock) has no defined app state, though settings
  and projects are server-only.
- **S8** The settings-cache file, its single writer, and the v0.51 `settings.json` migration aren't
  named.
- **S9** The add-only rule contradicts "W4 owns the moved modules" and W5 editing `src/mcp-launch.ts`,
  which `main.ts` imports.

## Nits

- **N1** `ui.inputActivity` (ownership map) vs `ui.input` (C2).
- **N2** The frozen tests restate names; a recorded wire fixture would enforce bytes.
- **N3** Downgrade: an older app restarting a newer server.
- **N4** The ~80 MB first-launch copy vs the 3 s budget under Defender; measure in M16.
- **N5** The 0.1.16 attach lacks `resize_notifications`; say re-attach is the default.
- **N6** Token rows for duplicates killed at adopt aren't deleted.
- **N7** No window placement for sessions an MCP agent opened while no app ran.
