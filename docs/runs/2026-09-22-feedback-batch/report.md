# External-user feedback batch — run report

**Dates:** 2026-09-22 → 2026-09-23 · **Base:** `main@3d56a24` · **Mainline now:** `main@9d0dce8`
**Mode:** autonomous build loop (spec → plan → build → independent review → runtime QA →
integrate), Opus executors, conductor on Opus 5.5.

The brief was four comments from another user, one addition from the user mid-run, and two
items the run found itself.

## Outcome

| # | Item | Result | Merge |
|---|---|---|---|
| 1 | Supported Node version | **Shipped** | `870ef0d` |
| 2 | Back/Forward walks code locations, not windows | **Shipped** | `a7b692b` |
| 3 | Staged and unstaged changes as separate diffs | **Shipped** | `0a44406` |
| 4a | Go module files (grammar, icons, language-generic nav message) | **Shipped** | `691082f` |
| 4b | Go code intelligence via gopls (host-side LSP client) | **Verified on `feat/go-lsp@fcc8ee6`, NOT merged** — awaits the trust decision below | — |
| 5 | Middle-click opens files/links in a background tab (user, mid-run) | **Shipped**, one human smoke owed | `91673f4` |
| 6 | Four e2e scenarios red on main (found by the run) | **Shipped** | `0721b96` |
| 7 | `target=_blank` in the in-app web view did nothing (found by the run) | **Shipped** | `0740e02` |

Every shipped item passed: an independent review (APPROVE), runtime QA driving the real app
(pass), `npm run verify` on the merged tree, and its relevant e2e scenarios on the merged tree.
End-of-run full e2e suite on merged main: **not completed** — Claude Code stopped it for low system memory after verify (EXIT=0, 4357 tests), build (EXIT=0) and the first 11 scenarios (all PASS). Every scenario touched by this run did pass on the merged tree at its own merge; the full sweep is still owed.

## What each fix actually was

- **Node.** The floor comes from dependency engines, not a guess: jsdom needs
  `^22.22.2 || ^24.15.0`, lint-staged `>=22.22.1`. `engines`, `.tool-versions` (22.23.2, the
  reporter's version), README. The reviewer re-derived the lockfile with npm and got it
  byte-identical.
- **Back/Forward.** History recorded every change of *active session + tab*, so Back hopped
  between sessions and terminals ("switches windows"), and no cursor position was ever kept.
  It is now an editor-location history: definitions, references, Ctrl+click, breadcrumbs,
  search hits, Go to Line and >10-line jumps are stops restored at their line; session and
  terminal switches are not. Three fix rounds after the first QA pass each found a real defect:
  a vacuous test guard, Back sticking with two sessions on one repo, and fast presses skipping
  same-file stops (a landing read the cursor before the previous landing's reveal applied).
  At merge it also had to learn diff scope (below).
- **Staged/unstaged.** The host always produced both sides; the renderer dropped the row's
  side on click and opened one unscoped `diff:<path>` tab. Diff tabs now carry a scope
  (`(Index)` / `(Working Tree)`), coexist, refresh and survive restart. QA's idle-rate probe
  found a **pre-existing loop on main**: Conduit's own `git status` rewrote `.git/index`, the
  watcher fired, `git status` ran again — ~3×/s on any idle repo. Fixed at the source with
  `GIT_OPTIONAL_LOCKS=0` in `runGitBin`: 28 → 0 events per idle 10 s.
- **Go files.** `.go` already highlighted. `go.mod`/`go.work` got a Conduit-authored Monarch
  grammar (Monaco ships none), module files the Go icon, and the "JS/TS only" nav message now
  names the language.
- **gopls.** A generic host-side LSP client (registry, per-root servers, epoch-keyed client
  refs, ordered stops vs crashes, bounded restart, lexical + realpath root confinement) with
  gopls as the only v1 server. Definition, type definition, implementation, references (peek),
  hover, breadcrumbs. Cold first nav ~34 s with a "loading workspace" chip, warm ~1.5 s. No
  gopls survives quit or a force-kill of the main process (measured). Design review and code
  review each found three blockers before QA; the security one was a `..` path letting a
  renderer message start gopls outside the workspace.
- **Middle-click.** One shared helper across 14 surfaces; pinned, background, no history
  entry, diff scope kept. QA found the Explorer lost ~1 in 20 clicks: virtualized rows were
  keyed by window index, so any scroll remounted them mid-click — a **pre-existing** bug that
  affected left-clicks in principle too. Fixed with `flatMap`.
- **e2e red on main.** `explorer` exposed a product bug (a timed-out empty search claimed
  "Nothing matches"; it now says "Search stopped early"); `find-widget` and
  `hover-obstruction` were test rot; `paste` fails only because this agent shell can't open
  the Windows clipboard — it now says so instead of blaming paste.
- **Web view `_blank`.** The guest had popups off, so the host never saw the open. Popups are
  now on for http(s) guests, and a host-side gate fed by the guest's real `input-event`
  decides: a real left-click/Enter → foreground tab, real middle → background tab, Ctrl →
  system browser once, anything scripted → nothing. Review caught that the first draft left
  Ctrl-click `window.open` as an unbounded page→browser channel.

## Needs you

1. **gopls trust decision (blocks merging 4b).** Today gopls starts on the first Go file you
   open, including in a repo you don't trust; it runs `go list` there (cgo/pkg-config per
   `#cgo` directives; user `GOFLAGS`/`GOPROXY` pass through; `GOTOOLCHAIN=local` blocks
   toolchain downloads). Alternative: ask once per project before starting it. Written up in
   `docs/adr/0006-host-side-language-servers.md` (status: proposed) on the branch.
2. **Real-mouse smoke** (no e2e can reach it): middle-click a link inside an in-app web tab →
   a background in-app tab, no system browser. If Electron doesn't report a physical click
   through `input-event`, it safely falls back to the system browser.
3. **`paste` e2e** needs a shell that can open the clipboard — run it from your terminal.

## Decisions taken without you (override any)

| | Decision |
|---|---|
| D1 | Back/Forward: session and Terminal switches are no longer history stops (reverses the 2026-06 view-level model). |
| D2 | Diff tabs: Staged → HEAD→index "(Index)", Changes → index→worktree "(Working Tree)"; other openers unchanged. |
| D3 | "Go support" read as code intelligence; the LSP is generic, gopls first, kept off main. |
| D4 | Node floor `^22.22.2 \|\| ^24.15.0 \|\| >=26`; no `engine-strict`. |
| D5 | No stage/unstage buttons inside diff tabs (Review already has them). |
| D6 | Diff tabs (scoped and unscoped) now survive restart. |
| D8 | Middle-click opens in the **background**; already pinned → no duplicate; tab middle-click still closes. |
| D9 | gopls lives while its root has an open Go tab; sessions don't hold it; 60 s idle stop. |
| D10 | Ctrl/Cmd+click inside a web page is out of scope for middle-click and still goes to the system browser. |
| D11 | Left-click on a `_blank` link in a web tab opens a **foreground** in-app tab. |
| — | Undo that jumps the cursor far is an edit, not a Back stop; landing on an image/PDF leaves focus where it was. |
| — | Your mid-run directive: related unit tests while building, relevant e2e before merge, full suite once at the end. |

## Known limitations and follow-ups (not built)

- Web tabs are saved in `docs.json` but not restored on relaunch (pre-existing).
- Review's side-by-side diff tab has the same title as the file tab.
- A hand-built unmerged index (`git update-index --index-info`) still re-triggers the idle loop; a real merge conflict doesn't.
- Back/Forward button state can be stale after a bare cursor move; forward-Delete followed by an API jump >10 lines isn't a stop; same-file stops inside a *rendered* Markdown/HTML view have no position.
- File tabs render no file-type icon for any language.
- The e2e `pointOn` helper places the pointer from Monaco's measured char width, which differs from the rendered width in hidden windows.

## Process notes

Full tagged list: `.autoloop/learnings.md` (not committed). The ones that changed how the run
went:

- **Review and runtime QA found every serious defect; the gate found none.** Blockers caught
  after a green gate: 3 (gopls design) + 3 (gopls code) + 1 + 1 + 1 (nav, three fix rounds) +
  1 (middle-click) + 1 (web security) + 2 QA fails with real defects (diff, middle-click).
- **Fix rounds keep introducing blockers** (nav round 1 → "Back stuck" with two sessions).
  Re-reviewing every fix round paid off again.
- **Two items that each passed alone collided at merge**: history identity `{kind, path}` vs
  the new diff scope. Only one import line conflicted and typecheck was clean. The conductor
  now diffs each item's identity model against what merged since its base.
- **Idle-rate probes** found the pre-existing git loop that no test watched.
- **A usage-limit cut** killed six agents mid-work; the on-disk ledger, per-slice commits and
  resumable agents meant nothing was lost.
- Three CLAUDE.md gotchas added: web-tab popups + gesture gate, `runGitBin` only,
  virtualized rows as direct keyed children.

QA reports: `qa/` in this folder. Specs archived under `docs/specs/archive/2026-09-2[23]-*`.
