# Nested repository performance investigation

The requested workload was reproduced in an isolated Windows Electron application: one session
opens a non-Git workspace containing ten Git repositories under two directory levels, with
twenty changed files per repository. Two hundred additional empty directory trees exercise
discovery. All fixtures and runtime measurements are stored in OS temp directories and removed.

The real-application scenario `nested-repo-resources` compares one and ten repositories, checks
all change entries and their line counts, measures an explicit refresh while automatic work may
still be running, and verifies idle work does not continuously spawn Git. Its measurements
include IPC and waiting time; they are local observations, not hardware-independent latency
guarantees. CPU measurements cover the Electron main process, not child Git or renderer processes.

## Findings and fixes

1. Git watcher noise was filtered only when `.git` was the first path segment. Events such as
   `group/repo/.git/objects` caused additional Changes refreshes. The filter now recognizes Git
   metadata at every depth while preserving meaningful HEAD, index, refs, and operation events.
   Dependency/build exclusions apply before the Git directory, so a ref named `build` is still
   observed while a Git repository under `node_modules` is ignored.
2. Each deleted file spawned a separate `git show HEAD:path`. Ten repositories with twenty
   deletions each required hundreds of child processes, multiplied by overlapping refreshes.
   A repository-level HEAD deletion numstat now provides those counts with one query. Missing
   numstat entries retain the existing globally bounded blob fallback. Real-Git tests cover
   staged edits followed by deletion, staged deletions with untracked replacements, empty files,
   Unicode paths, CRLF, and unterminated final lines.
3. Automatic filesystem refreshes and explicit requests ran independently. A per-project queue
   now runs one refresh and coalesces waiting requests into a fresh follow-up. Every waiting
   caller receives its response with its own request ID; callers do not receive the possibly
   stale in-flight result. Further invalidation during the follow-up schedules another fresh
   pass. Entries are released on completion and failure; unrelated projects remain independent.

## Measured workload

Comparable isolated runs against v0.45.5 and the final fix:

| Workload | Before refresh | After refresh | Before Git commands | After Git commands | Before peak Git processes | After peak Git processes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 repositories × 20 modified files | 4,550 ms | 1,520 ms | 143 | 30 | 30 | 8 |
| 10 repositories × 20 deleted files | 23,483 ms | 3,509 ms | 873 | 80 | 19 | 8 |

The fixed one-repository cases took 467 ms (modified) and 459 ms (deleted), with three and four
Git commands respectively. The ten-repository deletion measurement includes two fresh passes;
it is not presented as the cost of one clean snapshot. Modified-file host CPU fell from 3,079 ms
to 313 ms and deleted-file host CPU from 3,500 ms to 407 ms in these runs. The largest host timer
gaps fell from 159/97 ms to 51/48 ms. RSS varied with garbage collection and is not evidence of a
memory reduction. Both workspace sizes spawned zero Git commands during a two-second idle check.

## Repository boundaries

Repositories nested in ordinary directories are discovered within the existing depth bound
(four) and repository cap (200). Discovery intentionally stops when a Git repository is found.
Repositories inside another Git repository are therefore not automatically included in the
parent's Changes view. Overlapping attached roots are rejected by the existing folder model;
these child repositories can be opened in their own sessions. This patch preserves that
behavior rather than widening traversal through all repository contents. The application test
checks the parent boundary, rejected overlapping attachments, and a child opened independently.

## Verification

Regression unit tests cover nested watcher events, ignored derived directories, legitimate Git
refs, coalesced freshness/replies/failures, aggregate deletion counts, and bounded fallback reads.
The application scenario checks complete change data, rendered repository heads, process/work
budgets, idle behavior, and repository boundaries. `npm run verify` and release CI remain the
publication gates; final results are recorded by the release workflow.

Local `npm run verify` completed with exit code zero on v0.45.6: 460 test files, 6,645 passing
tests and four skipped. The complete application scenario passed in 47.3 seconds, including
repository boundaries and process/work budgets. A read-only review caught and corrected the
interaction between nested Git metadata and ignored dependency directories. Existing lint
warnings and three moderate dependency advisories remain; Semgrep is unavailable locally and
is required by the Linux release gate.
