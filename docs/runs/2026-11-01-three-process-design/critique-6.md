# Architecture critique — round 6 (fresh Opus critic, 2026-11-01)

Reviewed revision 6. The Codex review of the same revision is in `codex-review-6.md`.

**Verdict: REVISE.** The topology is sound and the decisions are well recorded. One contract seam is
missing, the screen-model lifecycle and host hooks in C7, which blocks W0b. Several state and
failure gaps need closing.

| # | Dimension | Score |
|---|---|---|
| 1 | Requirement & QA fidelity | 🟢 |
| 2 | Boundary quality | 🟡: the host gets all of `TerminalRuntime`; the W5↔W6 cycle; W5 copies `mcp-install.ts` |
| 3 | Pattern restraint | 🟢 |
| 4 | Data & state modeling | 🔴: screen-model start/keepTail/dispose and the host hooks have no server producer; the "no pending" claim contradicts the schema; settings keys misclassified |
| 5 | Change tolerance | 🟢 |
| 6 | Failure & scale realism | 🟡: a degraded token store permanently kills MCP (`unknown_token` → permanent fallback); ≤v0.51 downgrade; supervisor vanishing while the app runs |
| 7 | Decision capture | 🟢 |

**Blocker B1.** C7 has no seam for the screen model's lazy lifecycle (keepTail on spawn, start on
the first CLI initialize, dispose on exit) or the host's onSpawn/onResize/onExit hooks. The host also
receives the whole runtime, including raw `input`. Direction: narrow it to get/screen/on, add a
`ScreenPort.ensure`, and require `screen()` to resolve after every earlier `data` has been parsed.

**Should-fix.**
- **S1** `spawn_pending` for `keep:false` is unverified; the schema has no keep qualifier. Add it to M24 and give C1 a bounded wait for the pid.
- **S2** A degraded token store answers `unknown_token`, so every shim falls back for good. Answer `draining` instead.
- **S3** A ≤v0.51 downgrade reads the stripped `settings.json` and loses its policy. Keep the server keys mirrored for a release.
- **S4** The supervisor can vanish without an exhaustion marker while the app runs.
- **S5** `osAttention` and `logging`/`logLevel` are app-consumed.
- **S6** W5 copies `mcp-install.ts`. Move it to `src/` in W0b.

**Nits.**
- **N1** DraftPort through TypingPort creates a W6→W5 cycle. Give it to `runAddDir`.
- **N2** M22 has no fail path, and the Windows XDG premise is shaky.
- **N3** A server crash between a notice's text and its Enter leaves the doorbell text in the input box.
