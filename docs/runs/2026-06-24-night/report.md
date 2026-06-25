# Autonomous build run — 2026-06-24 night

**Branch:** `autoloop/2026-06-24-night` (off `main` @ `7b7da69` / v0.8.5).
**Not pushed, not merged to `main`** — left for morning review (main is shared with
concurrent sessions; prior-run convention). Conductor: Opus 4.8, delegated/inline.
Final `npm run verify`: **exit 0 — 134 test files, 1663 unit tests pass**; dead-code
clean, no secrets. (Non-gating: ~2.4% duplication; 2 by-design monaco/dompurify
advisories per ADR 0001.)

A nine-item night backlog, triaged into trivial bugs → FULL features and built one at a
time, each committed with unit and/or real-app (e2e) evidence.

## Shipped

| # | Item | Tier | Commit | Verification |
|---|------|------|--------|--------------|
| 1 | New files in a new untracked folder now each appear in change tracking (not just the folder) | trivial | `d3a7934` | unit test drives real `git` (`--untracked-files=all`) |
| 2 | Broadened editor syntax highlighting to ~70 file types | LITE | `a47fa32` | bundle-registration proof + 22 unit tests |
| 3 | Breadcrumb shows the full file name when it fits; visible `…` when truncated | LITE | `1896099` | typecheck/build; **visual = human glance** |
| 4 | Close confirmation skipped for a plain shell with nothing at risk | LITE | `81a54f9` | 5 unit tests (pure `shouldConfirmClose`) |
| 5 | Review Changes perf: killed O(N²) diff re-requests + per-arrival card cascade | FULL | `90af757` | root-cause fix; review-hunks 13 tests; no regression |
| 6 | `exit` in a plain shell closes the session (warns if it owns editor tabs) | FULL | `4a8dc70` | 8 unit tests + **e2e PASS (real ConPTY)** |
| 7 | Detect & resolve abbreviated `.../foo.tsx` path links | FULL | `5adad27` | path-resolve 18 + terminal-links 47 unit tests |
| 8a | Explorer file-type icons with a none/minimal/colored pack setting | FULL | `583e0ab` | 6 unit tests + **e2e PASS** (icons render + toggle) |
| 8b | Dim git-ignored files/folders in the Explorer | FULL | `d17c4e7` | **e2e PASS** (node_modules dimmed, src not) |
| 9 | README feature list refreshed | trivial | `31c52cb` | manual |
| — | Taxonomy test for the new iconPack control | — | `cf19d25` | unit |

## Notable findings & decisions

- **editor-langs was not actually broken.** Monaco's `editor.main.js` already bundles
  every language and the host already set the language id correctly, so json/go/ts (etc.)
  highlighted all along. The real win was *broadening* `langFromPath` coverage (~27→70
  extensions + fixed-name files like Dockerfile), each mapped to an id grep-verified as
  registered in the bundle (incl. Monaco's odd ids: protobuf→`proto`, solidity→`sol`).
- **review-perf had two root causes**, both fixed at the source (no hacks): an inline
  `onRequestDiff` arrow re-fired the fetch effect on every incoming diff (~N² readDiff
  calls) → stable `useCallback`; and an unmemoized `ReviewFileCard` reconciled every
  card's whole hunk tree per arrival → `React.memo` (safe because the diffs Map keeps
  each file's object identity).
- **exit-closes-session** (conductor decision): auto-close PLAIN shells on PTY exit,
  warn first if the session owns editor tabs; AGENT sessions keep their Restart card.
  Per-window safety relies on host `postState` sending each window only its owned sessions.
- **icon packs** (conductor decision): code-only — Lucide line icons + per-type CSS
  accent colors, so all three packs ship with no icon-asset/licensing dependency.
- **abbrev-path**: the matcher already captured elided tokens; the gap was resolution —
  `resolveToken` now suffix-searches the concrete tail after the last `...`.

## Residual / human-smoke

- **Breadcrumb truncation (#3)** and the **colored icon pack hues (#8a)** are verified by
  construction + unit/e2e, but their *visual polish* is a quick human glance (no pixel
  assertion was made).
- A **full `npm run test:smoke` regression** was not run end-to-end (it is environmentally
  flaky here — scrollback/durability time out on a loaded machine, see
  `conduit-smoke-env-flakiness`). The new/affected scenarios were each run individually
  and PASS: `exit-closes-session`, `explorer-icons`, `explorer-gitignore`. Recommend a
  full smoke pass before any merge to `main`.

## Integration

Everything is on `autoloop/2026-06-24-night`, 11 commits, working tree clean. Review,
then merge to `main` + cut a release when satisfied. Ledger/evidence under `.autoloop/`
(gitignored).
