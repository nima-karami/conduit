# Interactive plan documents — run report

**Date:** 2026-09-19 · **Branch:** `feat/interactive-plan` → merged to `main` at `1ccde7f`
**Spec:** `docs/specs/archive/2026-09-19-interactive-plan.md` (shipped)
**Plan:** `docs/plans/2026-09-19-interactive-plan.plan.md`
**Range:** `231bb8b..1ccde7f` — 17 commits, 59 files, +11992 / −53

## What shipped

A plan an agent writes to `<projectRoot>/.conduit/plans/<slug>.md` opens as a document you
edit rather than a wall of text you read.

- **Prose** is a block editor over the Markdown AST (Milkdown 7.22 on ProseMirror), so the
  file stays the model.
- **`ts` fences** are inline Monaco with per-block type checking. The app's global validation
  flags are untouched; diagnostics are asked for per model.
- **`mermaid` flowcharts** are a structural editor (xyflow) over a hand-written parser and
  reducers, serialising back into the same fence. Positions are never written — layout is
  computed from the graph every render.
- **Every block is commentable.** Comments live in `<slug>.comments.json` beside the plan,
  anchored by block hash and re-anchored as the plan moves; a detached comment is surfaced,
  never dropped.
- **Send to agent** pastes only the blocks the human changed and their open, unsent comments
  into the owning session's terminal, then replaces the baseline.
- **The agent's rewrites reload in place**, mark the blocks it touched, and are never offered
  back to it. A rewrite arriving mid-edit raises a conflict and pauses writing; both versions
  survive until the human picks one.
- **`conduit-interactive-plan` skill** bundled; `conduit-plan` (the never-built `plan.json`
  design) deprecated in place.

Byte preservation is the load-bearing property throughout: editing one paragraph rewrites
that paragraph's bytes and nothing else.

## Evidence

| Gate | Result |
|---|---|
| `npm run verify` on the merged tree | **exit 0** — 278 files, 4195 tests, 2 skipped |
| `plan-editor` e2e on merged main | **exit 0** |
| `plan-blocks` e2e on merged main | **exit 0** |
| `plan-handoff` e2e on merged main | **exit 0** |
| Gate definitions vs `.autoloop/gate-baseline.txt` | 271/271 present; `scripts` byte-identical; only `package.json` dependencies added |

Logs: `.autoloop/evidence/merged-verify.log`, `merged-e2e-*.log`, and the per-round
`round{1..4}-verify.log`.

## How it was built

Seven slices, each committed on its own: pure seams (blocks, splice, comments, baseline,
handoff) → the flowchart parser and layout → the host watcher and protocol → the editor
shell → the live blocks → comments and Send → the skill and the accessibility pass.
Then four rounds of fixes driven by an independent review and three runtime QA passes.

**Design review before any code** (`architecture-critic`) returned REVISE with 6 blockers on
the plan itself — the baseline model accumulated hashes instead of replacing them, one
message acknowledged two different writes, the splice base was unpinned, the layout
primitive was size-blind, the watcher was never armed before a plan was opened, and the
first round trip would have sent nothing. All six were fixed on paper, before a line existed.

## What review and QA found that the gate could not

The gate was green at every one of these. This is the case for the review and QA stages.

**Round 1** — review REVISE (3 blockers), QA fail (3 blockers):
- A `|` typed into a diagram edge label wrote a fence that could never be parsed again; the
  block dropped permanently to the read-only fallback and the agent received a broken diagram.
- Diagram selection was never wired in xyflow's controlled mode, so the Delete key was dead
  and selection styling unreachable. The e2e only used the context menu, so it stayed green.
- `readOnly` was declared, passed and never read: read-only plans and conflicts accepted
  typing and dropped it silently.
- **A plan opened while another project was on screen sent the human's work to the wrong
  project's agent** (3/3). Only reachable with two projects open.
- Deleting an open plan left a dead pane; Recreate and Close were unreachable.
- An empty or frontmatter-only plan refused every keystroke.
- Host: the watcher was armed with the terminal's live working directory, so every directory
  the user visited leaked a permanent two-second poll on the main process.

**Round 2** — review REVISE (1), QA fail (1):
- Retry re-serialised the whole document, so one click rewrote a plan the agent authored
  (`-` bullets to `*`, `_em_` to `*em*`) and invalidated every agent-changed hash. The three
  tests covering Retry used plain paragraphs, which are serialiser-stable, so none could see it.
- "Recreate empty" wrote the file and left the pane dead, because the write-ack was a shallow
  merge that never recomputed status. An agent's write recovered the pane; the app's own did not.
  Auditing that merge found two more: a load failure's reason survived a later success, and the
  agent-changed set kept hashes for blocks the human had deleted.

**Round 3** — review REVISE (1), QA **pass**:
- The read-only reconcile added in round 3 keyed on a flag that is also true during a conflict,
  so it wiped the human's text the instant the banner appeared and Keep mine then wrote stale
  bytes over the agent's version. A fix that introduced a worse defect than it removed.
- QA otherwise passed: type checking in fences, diagram subgraph moves, all three themes.

**Round 4** — review **APPROVE**:
- One should-fix taken anyway because it lost data: read-only and conflict both set reopened
  the same wipe, reachable when an in-flight write fails with a permission error after a
  conflict was raised.

**The accessibility pass found a defect beyond this feature**: keyboard focus was invisible
app-wide under forced colours, because the shared ring is a `box-shadow` and forced colours
drops those. Fixed at the token layer; `docs/specs/2026-08-01-interaction-state-vocabulary.md`
updated to match. Also a keyboard trap: Tab inside a signature fence never escaped.

## Accepted follow-ups (not blocking, carried forward)

Arrow-key navigation inside the diagram (spec §9/§10 wants one tab stop that opens into arrow
keys; every node is its own tab stop today). The first-run "No plans yet" state — the strings
exist in the spec but there is no plan-list surface to host them. The global `Mod+Shift+Enter`
Send binding. `planBlockMenu` is exported, unit-tested and wired to nothing (wire or delete).
`c` does not fire in prose while the comments panel advertises it. Send does not flush an
armed write before pasting, so a Send inside the debounce window pastes pre-edit blocks. The
re-anchor similarity rung compares snippets, so two fences of the same language score 1.0
against each other and a comment can land on the wrong one. `replyTo` is in the contract with
no producer. Send sets `disabled` and `aria-describedby` together, so its blocked reason is
never announced. The composer counter's `aria-live` announces every keystroke. The signature
block has neither the language nor the "checking…" chip §8 asks for, so worker-pending is
indistinguishable from clean. The empty diagram has no dashed canvas. `.plan__gutter` omits
`-webkit-app-region: no-drag`. The generic `separatorBefore` fix belongs in
`context-menu.tsx:130` — one character, fixes every filtered menu in the app. `electron/main.ts`
carries an unused `execFile` import (pre-existing). The load-failed source view is read-only,
so the write-ack-over-error branch has no user-reachable trigger. `#quot;` inside a label is
not itself escaped.

## Not covered by QA

Visual and design fidelity (no baseline obtainable). Relaunch and restore of an open plan tab
beyond one check. The 1 s banner budget as a timed measurement. Keyboard-only diagram
navigation, diagram drag and connect-by-drag. Reduced motion, forced colours and focus-ring
visibility were driven in the accessibility pass but not re-driven per QA round.

## Process notes

Full tagged list in `.autoloop/learnings.md`. The ones worth carrying:

- **Two "green but broken" defects in one slice**, both invisible to element-count assertions:
  a ProseMirror node view that declares a contentDOM never gets the `contenteditable=false`
  stamp, and ReactFlow's `fitView` prop runs once at init, so a canvas mounted in a portal sat
  at minimum zoom outside its own viewport. Assert containment and focus targets, not counts.
- **The worst defect of the run needed two projects open.** Single-context QA would never have
  seen it. A QA brief for anything session-bound must specify a multi-context setup.
- **A defect survived two QA rounds** because each drove one half of it. When a fix lands
  between rounds, the next round must re-drive what the fix could have broken, not only what it
  was meant to fix.
- **Blocker counts converged 6 → 2 → 1 → 0**, and the last was a regression from the previous
  round's own fix. A fix round is itself a change that needs review.
- **Bash heredocs here collapse `\\` and eat backticks**, which silently corrupted a regex, a
  win32 test path and a commit message. Source edits must use the file tools. This contradicts
  the session's ambient "edit through Bash" directive; two executors flagged it independently.
- **The `node_modules` junction trick for worktrees breaks on any `npm install` in the
  worktree.** npm replaces the junction with a real partial install and the Electron binary is
  missing, because install scripts are gated. Recovery: `npm ci`, then
  `node node_modules/electron/install.js`. The main checkout needed the same after the merge.
