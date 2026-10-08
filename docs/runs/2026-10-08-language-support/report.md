# Run report — language support (2026-10-08)

**Shipped: v0.46.0** — `main` d265a81, tag `v0.46.0`. Spec:
[archive/2026-10-08-language-support.md](../../specs/archive/2026-10-08-language-support.md).

## What shipped

| Item | Evidence |
|---|---|
| Log language (`.log`, rotated `.log.N` / `.log.<date>`), muted timestamps, level words only uppercase or level-shaped | unit `log-grammar`; e2e `language-files` AC-A2 (real tokenizer, 3 themes); QA r2 screenshots |
| Logs > 2 MB open at their tail, bounded read for every text file (was: whole file read, 640 MB → +645 MB RSS) | unit `file-service` (cap, race, sentinel, alloc bound); QA: 40 MB log opens ~1 s, +18–25 MB |
| Golden files: `name.<ext>.golden` → that language, source view, never LSP-synced; EOL-rewriting goldens read-only and never dirty | unit `lang`, `lsp-sync`, `file-save-controller`; e2e AC-A5 (no dirty dot, no close prompt); QA r2 |
| Byte-exact saves: BOM preserved, invalid UTF-8 read-only | e2e AC-A4/A4b; QA |
| C# navigation via `csharp-ls` (pattern root markers, `requiresMarker`, bin/obj ignored, idle stop) | e2e `csharp-lsp`, `csharp-lsp-idle` (CI installs .NET 10 + csharp-ls 0.28.0) |
| Trust prompt / palette name the right language | e2e `csharp-lsp` B6 |
| Markdown source folding by heading/fence/region; Markdown + YAML verified | unit `markdown-folding`; QA |
| npm audit highs (http-cache-semantics, source-map-js) — targeted bump only | `npm audit --audit-level=high` exit 0 |

**Gates on the release tree:** `npm run verify` exit 0 on d265a81; full remote e2e 177 PASS / 8 EXCLUDED
(pre-existing) on edbad16 (run 37825445354); feature scenarios on d265a81 (run 37827598451) PASS.

## Process
- Spec (Opus) → two file-disjoint lanes in worktrees (Opus builders) → independent Opus review per lane
  (B: APPROVE + fixes; A: REQUEST_CHANGES → APPROVE + 2 should-fixes) → runtime QA (Opus, real app, 3 themes).
- QA round 1 FAILED on a defect already fixed: the conductor merged a branch ref one review round stale
  (builder committed on a detached HEAD). Re-merged by SHA; QA round 2 PASS.

## Decisions taken autonomously
See `goal.md`. Notably: no YAML language server (client is nav-only); invalid UTF-8 read-only for all files;
C# requires a project marker; CI pins the .NET SDK rather than trusting the image.

## Not covered / follow-ups
- **Non-golden mixed-EOL files open dirty** (pre-existing: Monaco normalises EOL on load). Worth its own fix.
- **Visible-window flash of unstyled text** not judgeable in the hidden harness (paints ~2 fps); same for
  pre-existing languages, so not attributed to this branch. Needs a human glance.
- **C# with csharp-ls installed** verified only remotely (no .NET SDK locally).
- `.cs` opened before its `.csproj` exists stays unserved until reopened (review N4).
- Neon: WARN (#ffb547) vs number yellow (#ffd23d) still close.
- The lane B harness worktree (`.claude/worktrees/agent-a16d770c2aa490023`) is lock-held by the agent
  harness; its node_modules junction is already removed, so removing it is safe.

## Learnings
`learnings-conductor.md`, `learnings-lane-a.md`, `lane-b-learnings.md`.
