# Run report — 2026-09-05 Review as a mode

**Status: COMPLETE.** Merged to `main` by fast-forward of branch `review-mode` (tip = the commit carrying this report); the merged
tree passed `npm run verify`. Three independent review rounds (REVISE → REVISE → APPROVE) plus an APPROVE on
the final delta, and a runtime QA pass whose two findings are one fix and one recorded decision below.

The user's ask, verbatim: *"We need to design the UX around reviewing changes, the placements of
its buttons, etc. It's a little bit fractured right now."* — settled on a design canvas, then
*"Get this implemented."*

## What shipped

Review is a **mode**. The doc-tab row's git band keeps entry points only (branch · History ·
Review). The Review view owns its controls in one full-width header — panel toggle, source picker,
All / Staged / Unstaged (disabled, not hidden, on a commit or range), diffstat and reviewed meter,
find, an overflow menu (Collapse all, Expand all, Ignore whitespace, Keyboard shortcuts) — and a
bottom action bar (Stage all, the agent handoff, Discard all changes behind an overflow). The
in-view file navigator is gone; while Review is the active doc the right pane's **Changes tab is
the navigator** (source-aware, windowed, reviewed checkboxes, filter, click-to-jump, Stage/Discard
on hover). Entering Review opens a collapsed pane on Changes; closing Review restores it unless the
user toggled the pane themselves. Compare moved into the source picker as `Compare refs…`. The
per-card Split became an icon that opens the Monaco diff side-by-side without flipping the global
setting; each diff tab now keeps its own mode.

Spec: `docs/specs/archive/2026-09-05-review-mode.md` (FULL). Plan:
`docs/plans/2026-09-05-review-mode.plan.md`. Design canvas linked from the spec.

## Commits (branch `review-mode` on top of `83165e4` / 0.37.0)

| SHA | Slice | What |
|---|---|---|
| `5b2ce87` | docs | spec + plan |
| `e791cbd` | 1 | pure seams: `plural`, `review-mode-layout` reducer, `review-nav-store` |
| `fb7f5e9` | 2 | `ReviewFileNav` moved out, `ReviewNavigator`, right pane renders it in review mode |
| `b6729b3` | 3a | segment `disabled`, `Compare refs…` row, `IconSplit`, session card icon |
| `f7f7d2d` | 3b | header + action bar, aside deleted, band slimmed, layout policy, side-by-side override |
| `96d61f6` | 5 | e2e migration + `review-mode-pane` scenario |
| `7f8932d` | review #1 | per-path `canMark`, find-bar button recipe, diff tab state per doc, dead code |
| `3361d68` | 6 | changelog, spec archived, NUL byte rewritten as an escape sequence, plural dedupe, docblocks |
| `d2352a4` | gate | circular import broken (`webview/changes-actions.ts`) |
| `ca78028` | review #2 | containers off the modal hosts, navigator row reveal, re-activation honours side-by-side, a11y |
| `e551a38` | smoke | `review-notes-handoff` leaves Review before asserting the status list |
| `dca1cb8` | review #3 + QA | painted-mode ref, header toggle opens a collapsed pane on Changes, status line in the tab strip, e2e guards tightened |
| `33b4301` | delta review | status line announced via mutation, single ref mirror, one deferral, e2e baseline/fallback hygiene |

## Gates and evidence (`.autoloop/evidence/2026-09-05-review-mode/`)

- Baseline `npm run verify` at `5b2ce87`: exit 0 (`baseline.md`, `baseline-verify.log`); gate
  definitions hashed; diff at `d2352a4` showed only additive/stronger test changes.
- `npm run verify` at `d2352a4` and `e551a38`: exit 0 (`verify-*.log`).
- Full smoke suite at `d2352a4`: 105 passed, 4 failed, 2 errors (`smoke-d2352a4.log`). Re-run alone:
  `review-virtualize`, `review-mode-pane`, `split-diff-map`, `attention-signal` pass;
  `review-notes-handoff` was a real migration miss (fixed in `e551a38`, passes); `paste`,
  `terminal-drop`, `markdown-viewer` **fail identically at the base commit** (`base-*.log`) — the
  machine's PTY-starvation signature (4 Conduit instances, 17 console hosts live), not this branch.
- Byte-level integrity scan over `83165e4..e551a38`: clean.
- Independent reviews (Opus, fresh context each): #1 REVISE (2 blockers, 10 findings; `review-1.md`),
  #2 REVISE (2 blockers, 14 findings; `review-2.md`), #3 APPROVE (0 blockers, 14 should-fix/nit;
  `review-3.md`), delta `e551a38..dca1cb8` APPROVE (0 blockers, 7). Every blocker was reproduced
  by the conductor at its anchor before a fix was dispatched.
- Runtime QA (Opus, hidden app via the e2e harness, 45 screenshots under `qa/`, report
  `qa.md` beside this file): verdict **fail** on two findings — the header toggle opening a
  collapsed pane on the persisted tab (fixed `dca1cb8`, re-proven by a new e2e step) and the Review
  tab not restoring at launch (pre-existing `parseDocs` filter; quarantined, see below). All 14
  acceptance criteria otherwise observed working in Aero Dark, Aero and Neon.
- Targeted smoke run of 27 review-adjacent scenarios at `dca1cb8`: 26 green; `review-tab-state` failed once under back-to-back load and passes alone (`smoke-targeted-summary.txt`, `rerun7-*.log`). At `33b4301`: `review-mode-pane`, `review-tab-state` (×2), `split-diff-map`, `review-navigator` pass alone (`rerun7-*`, `rerun8-*`).

## Decisions recorded during the run

- Split renderer inside Review deferred (user, 2026-09-05); the per-card action opens the Monaco
  diff with a doc-level override instead.
- Executors are Sonnet; Fable plans and reviews; Opus for independent review and QA (user).
- While Review is the active doc, the Changes tab does not list `.conduit/review-notes.json`
  (Review hides its own artifact); the status list, which does, returns with any other active doc.
  Narrows review-supercharge Lane F for the duration of review mode. User may override.
- `src/conduit-proposal.ts` plural dedupe accepted as an out-of-map deviation (behaviour-identical).
- Slice 2's planned parallel groups both touched `right-pane.tsx`; every slice ran one serialized
  executor in place (the repo's node_modules junction makes worktrees hazardous).

## Decisions Needed (surfaced during autonomy)

- **[normal] Restore the Review tab at launch?** `src/persistence.ts` `parseDocs` restores only
  `file` docs (since `6148be1`), so a persisted Review doc is dropped on restart. The spec's §4
  restart row assumed restoration without measuring it. Default taken: no product change this run.
  Unblock: widen the filter to `review` (the reducer already reopens Review in working-tree mode).

## Follow-ups (not blocking)

- `Compare refs…` is enabled in an unborn repo (the band's button used to disable); the dialog's
  host validation reports it.
- `npm run shots` `review` / `review-commit` scenes never see the git band in the visual harness
  (reproduced 2×, pre-dates this run).
- `paste`, `terminal-drop`, `markdown-viewer` smoke scenarios fail on this machine at base.
- Leaving a side-by-side diff tab logs two `TextModel got disposed before DiffEditorWidget model got
  reset` page errors (console only; likely the per-doc viewer remount disposing in the wrong order).
- CLAUDE.md gotcha candidate: `container-type` on an element that hosts a `position: fixed`
  dialog traps the dialog (layout containment); put container queries on inner wrappers.

## Learnings

See `.autoloop/learnings.md` (tagged). Headlines: independent review found real, gate-blind defects
in every round (a deleted CSS class still in use; a boolean where a predicate was published; CSS
containment trapping fixed-position modals; a reveal rule keyed to the wrong row class); Sonnet
executors did well on tightly briefed slices with exact anchors and one-scenario e2e caps; briefs
must state code facts from a read this session, not from a report.
