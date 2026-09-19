---
status: active
date: 2026-09-19
---

# Feature Spec: Interactive plan documents

**Tier:** FULL   **Feature type:** UI
**One-line request:** "I want to recreate the whiteboarding experience as much as possible: the agent
populates a plan, and it is a fully interactive document I can play around with. Everything editable,
everything commentable, and I can move things around and edit the signatures myself."

## 0. Context

Designing with an agent happens in chat, and chat is the wrong medium for design: a design is spatial
(what lives where), typed (what crosses each boundary), and layered (boundaries, then contracts, then
internals), while chat is linear, untyped, and all-at-once. The human has to absorb every level to find
the one wrong thing, and correcting it means describing a position in words. The workaround that
already works is "agent writes it to a file, I edit the file, agent reads it back", because edits are
positional by construction. This feature makes that loop first-class and gives each part of the plan
the editor it deserves.

Prior art (survey 2026-09-18): every plan tool ships a markdown file (Cursor, Windsurf, Kiro,
spec-kit); comment tools anchor to lines (Crit.md); Builder's `visual-plan` renders typed blocks but
is read-only. Nobody ships a plan you can edit as a document *and* rewire as a diagram *and* type-check
as code, with the edits flowing back to the agent. A galaxy-style code-synced canvas was considered
and shelved (`G:\awby\projects\galaxy`) as over-built for this need.

## 1. Problem frame

- **Job:** let a human and an agent converge on a design by editing one shared object, where every
  correction is made *in place* (move it, rewire it, retype it, comment on it) rather than described
  in prose.
- **Actors:** the human (reads, edits, comments, sends); the agent (Claude Code in a Conduit session
  terminal: writes the plan, reads edits and comments, revises).
- **Success outcomes:** a plan the agent wrote renders as a live document; a rewired edge, an edited
  signature, or a changed paragraph lands in the plan file without the human touching raw markdown;
  the agent receives exactly what changed plus the open comments in one paste; the round trip
  (agent writes → human edits → agent reads) loses nothing the human typed.
- **Non-goals:** syncing the plan to the codebase; verifying signatures against real files; freeform
  Miro-style shapes; executing the plan; replacing the architecture canvas or the board; multi-user
  collaboration.

## 2. Behavior & states

**The artifact.** A plan is one Markdown file at `<projectRoot>/.conduit/plans/<slug>.md`. Plain
Markdown is the source of truth because the agent already reads and writes it natively and a diff of
it is legible to both parties. Three block kinds are *live*; everything else is ordinary prose.

| Block | Markdown | Live editor |
|---|---|---|
| Prose (headings, paragraphs, lists, tables, quotes) | as-is | WYSIWYG block editor whose model is the Markdown AST |
| Signature | ```` ```ts ```` fence (also `tsx`; other languages get syntax-only) | Inline Monaco, type-checked against the open project's TS worker |
| Diagram | ```` ```mermaid ```` fence, `flowchart` family | Structural node/edge editor: drag, connect, rename, add, delete, group |

Comments live beside the plan in `.conduit/plans/<slug>.comments.json` (ADR 0002 envelope, kind
`plan-comments`) so the agent can read them and so the plan file stays clean Markdown.

**Session binding.** A plan tab opens inside the session workspace that opened it, like any other
document tab, and that session's terminal is "the plan's session terminal". If that terminal is not
live at send time, Send degrades to Copy as markdown (§4). Nothing about the binding is persisted.

**Primary flow.**
1. The agent (guided by a bundled `conduit-interactive-plan` skill) writes `.conduit/plans/<slug>.md`.
2. Conduit's `.conduit/` watcher (250 ms debounce, as the board and proposal watchers) sees the file;
   a banner offers **Open plan**. Opening any `.md` under `.conduit/plans/` uses the plan editor
   instead of the markdown viewer.
3. The human edits any block in place. Edits are written through to the file (debounced) so the file
   is always the current plan.
4. The human comments on any block. Comments are stored in the sidecar immediately.
5. **Send to agent (N)**, where N = human-changed blocks + open comments not yet sent, pastes into
   the plan's session terminal: the plan path, each human-changed block (new content), and each
   unsent open comment with its block snippet. The sidecar records the new baseline.
6. The agent revises the file. The watcher reloads it; the human's view updates in place, with
   blocks the agent changed marked until the human scrolls them into view. Agent-changed blocks move
   the baseline, so they are never pasted back at the agent as "changes".

**States** (the document): first-run (no `.conduit/plans/`), loading, populated, saving,
save-failed, external-change-clean (auto reload), external-change-dirty (conflict), not-found (file
deleted while open), diagram-unsupported (fence uses syntax the structural editor cannot round-trip;
falls back to the rendered diagram plus **Edit as text**), TS-worker-not-ready (signature blocks
render, type checking arrives later).

**Current behavior** (claims about today):

| Claim | How measured | Status |
|---|---|---|
| `.md` files open in a read-only markdown viewer that renders Mermaid fences as pictures | Component list `webview/components/{markdown-viewer,mermaid-diagram}.tsx`; no edit path found by grep | ASSUMED (source read) |
| Review notes are line-anchored, stored in `.conduit/review-notes.json`, and hand off by bracketed paste via `pasteToTerminal` | `src/review-notes.ts`, `src/review-handoff.ts`, `webview/terminal-bus.ts:110` | ASSUMED (source read) |
| `@xyflow/react` 12, Monaco 0.55, Mermaid 11, React 19.2 are present; no ProseMirror/Milkdown, no elkjs/dagre | `node -e` over `package.json`, 2026-09-19 | Measured |
| Milkdown latest is 7.22.1 (`@milkdown/kit`, `@milkdown/react`) | `npm view`, 2026-09-19 | Measured |
| Conduit has no i18n layer; strings live in components | grep for translation libs found none | ASSUMED (grep is negative evidence) |
| `.conduit/` watchers debounce at 250 ms and suppress the app's own writes via `isSelfEcho` (board and notes watchers) | `electron/board-watcher.ts:30,77`, `electron/notes-watcher.ts:59` | ASSUMED (source read) |
| Review notes re-anchor exact → nearest within ±50 lines → detached | `src/review-notes.ts` header comment | ASSUMED (source read) |
| Per-view UI state (folds, filters) persists renderer-side in `webview/view-state-store.ts` | file exists; behaviour per review-fidelity spec T1 | ASSUMED (source read) |

## 3. Data / interface contract

**Plan file.** UTF-8 Markdown, optional YAML frontmatter (`title`, `status: draft|agreed`). No custom
markup: the agent must be able to write it with no knowledge of Conduit, and a plan is still a
readable document in any viewer.

**Block identity.** Blocks have no ids in the file (agents would drop them and ids pollute the
document). A block is identified by `{ index, hash, snippet }` where `hash` is FNV-1a of the block's
normalised source and `snippet` its first line. Re-anchoring on external change: exact hash → same
index with the nearest hash by similarity → detached (surfaced, never dropped), the same ladder
review notes use for lines. The editor updates anchors for its own edits directly, since it knows
which block a keystroke belongs to.

**Diagram round trip.** Supported Mermaid subset: `flowchart`/`graph` with direction, node shapes
`[ ]`, `( )`, `([ ])`, `[[ ]]`, `{ }`, `(( ))`, edges `-->`, `---`, `-.->`, `==>`, `<-->`, edge labels
`|text|` and `-- text -->`, `subgraph id [title] … end`, `%%` comments. `classDef`, `class`, `style`,
`click`, and `linkStyle` lines are preserved verbatim as an opaque trailer. Anything else marks the
block unsupported. Serialisation is canonical (direction, subgraphs with their nodes, remaining nodes,
edges, trailer) so a rewire is a small, local diff. **Positions are never written**: layout is
computed with elkjs on every render, drag is session-only. This is deliberate (Conduit's canvas
learned post-release that nobody, agent or human, should own layout) and it is what keeps the
diagram a plain fence.

**Comments sidecar.** All timestamps ISO-8601 UTC.
```ts
{ conduit: 1, kind: 'plan-comments', updatedAt, data: {
  version: 1,
  // Per-block hash the human's edits are measured against. Set on Send; a block's entry is also
  // replaced whenever an agent write changes that block. "Human-changed" = current hash ≠ baseline.
  baseline?: { at: string; blockHashes: string[] },
  comments: Array<{
    id: string; author: 'human' | 'agent'; text: string;         // markdown ≤ 4 KB, enforced in the composer
    anchor: { index: number; hash: string; snippet: string };
    status: 'open' | 'resolved'; createdAt: string; replyTo?: string; sentAt?: string;
  }>
}}
```
The sidecar has two writers. The editor writes it whole after merging by comment id: on an external
change it reloads, keeps every comment by id taking the on-disk `status`/`replyTo`/agent replies, and
re-applies its own not-yet-flushed additions. The agent only appends comments and flips `status`;
the skill says so. Self-echo is suppressed the same way as the plan file. There is no conflict banner
for the sidecar because id-merge has no lossy case.

**Handoff paste** (bracketed paste, no trailing newline, into the plan's session terminal; falls back
to **Copy as markdown** when no live terminal):
```
Plan: .conduit/plans/<slug>.md — I edited it and left comments.
Changed blocks (3):
- §2 diagram: (full fence, new content)
- §3 signature `createIdentity`: (full fence)
- §1 paragraph "The identity service…": (new text)
Open comments (2):
- §2 diagram, node `txn-svc`: "This should not talk to identity directly."
- §3 `createIdentity`: "Return the id, not the whole record."
Please revise the plan file, reply to each comment in .conduit/plans/<slug>.comments.json, and tell me what you changed.
```

**Producers / consumers.**

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| `.conduit/plans/<slug>.md` | agent (via skill); plan editor (write-through) | plan editor (watcher); agent (next turn) | yes |
| `.conduit/plans/<slug>.comments.json` | plan editor (human comments, `baseline`); agent (replies, `resolved`) | plan editor; agent | yes: the skill specifies the agent's side |
| Source-view toggle, per plan | plan editor | plan editor, via `view-state-store` (renderer-local, not the sidecar) | yes |
| Handoff paste | plan editor | agent, through the session terminal | yes |
| Open-plan banner | `.conduit/` watcher (host) | renderer | yes |
| TS diagnostics in signature blocks | existing TS worker + project extraLibs | signature editor | consumer only: the producer is unchanged and already serves the code editor |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Agent rewrites the file while the human has an unsaved edit (inside the debounce window) | No auto-reload. Banner: "The agent changed this plan while you were editing" with **Load theirs** (discard pending) and **Keep mine** (write through, agent's write is lost but visible in git if committed). Never silently merge. |
| Agent rewrites while clean | Reload in place; caret and scroll preserved by block anchor; changed blocks carry a "changed by agent" marker until viewed. |
| Human's own write echoes back through the watcher | Suppressed by the existing self-echo mechanism (review notes needed the same). |
| Zero plans / plan folder missing | First-run state with the one CTA "Ask your agent to write a plan" and the skill's one-line instruction to paste. |
| Many plans | The explorer shows `.conduit/plans/`; any number open as tabs. No dedicated list view in MVP. |
| Diagram fence uses unsupported syntax | Rendered read-only with **Edit as text** (Monaco on the fence). Round trip still exact because the text is untouched. |
| Diagram has 0 nodes | Empty canvas with **Add node**. |
| Signature fence in a language with no worker | Syntax highlighting only; no diagnostics, no false "ok". |
| Save fails (disk full, transient) | Editor stays editable, bar shows save-failed and Retry; Send disabled until saved, because the paste must describe the file on disk. |
| Plan file is read-only (permission) | Detected on first failed write: editor switches to read-only with an explanatory bar; comments still work if the sidecar is writable. |
| Plan file unreadable (not UTF-8, > 2 MB) | Page-level error with the reason and **Open as text** (Monaco), never a blank pane. |
| Sidecar write fails | Comment stays in the panel marked unsaved with Retry; Send disabled (the paste claims comments are on disk). |
| Comment exceeds 4 KB | Composer counter turns to an enforced limit; Save disabled with the reason in text. |
| Comment anchor detaches after an agent rewrite | Shown in a "detached" group at the top of the comments panel with its snippet; **Re-attach to…** (block picker, keyboard and menu) or resolve. |
| All comments resolved | Panel shows "All resolved" with the count, distinct from never-commented. |
| Send with no live terminal for this session | **Copy as markdown**, same content. |
| Send twice with no changes | Button reads "Nothing to send"; disabled. |
| Plan file deleted while open | Not-found state with **Recreate empty** and **Close**. |
| Frontmatter malformed | Treated as prose (it is Markdown); no crash. |
| Double-submit on Send | Idempotent: second click within the same `baseline` is a no-op. |
| Undo | Focus decides the stack: inside a Monaco signature block Ctrl+Z is Monaco's; everywhere else it is the document's, which includes diagram edits because they are document edits. Comment delete is not undoable, so it confirms. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Plan location | `.conduit/plans/` | no | Sits with the other `.conduit/` artifacts and their watcher (ADR 0002). |
| Write-through debounce | 300 ms | no | Feels immediate, batches keystrokes, keeps the "file is the plan" invariant. |
| Conflict policy | ask, never auto-merge | no | Both edits are judgment; a silent merge destroys one. |
| Diagram layout | elkjs layered, direction from the fence | no | Layout is computed, not owned. |
| Handoff channel | paste into the plan's session terminal | no | Proven by review notes; the agent has no other input. |
| Source view | toggle per plan, off | yes (per-plan, remembered in `view-state-store`) | Escape hatch for anything the block editor cannot express. |
| Agent-changed marker | on | no | Progressive disclosure: the human reads what moved, not the whole plan. |

## 6. Scope slicing

- **MVP (must):** plan editor for `.conduit/plans/*.md` with the three live block kinds; write-through
  save; external reload with agent-changed markers and "Next change"; conflict banner; block comments
  with the sidecar; Send to agent with changed-blocks + open comments; the `conduit-interactive-plan`
  skill; open-plan banner. The markers are MVP because they *are* the progressive disclosure.
- **v1 (should):** agent replies rendered in threads; a plans list in the explorer header; commit the
  plan from the bar.
- **Vision (could):** an optional `path:` annotation on a block linking it to a real file (the hook for
  stub-first design); sequence and class diagrams; a "Agreed" status that freezes the plan and
  hands it to the implementation flow; freeform sticky notes on the diagram.
- **Out of scope:** everything under Non-goals; editing plans outside `.conduit/plans/`; any change to
  the architecture canvas or the board.

## 7. Acceptance criteria

**EARS**
- When the agent writes a file under `.conduit/plans/`, Conduit shall show an open-plan banner within
  1 s (250 ms watcher debounce plus read and render).
- When a `.md` under `.conduit/plans/` is opened, Conduit shall render it in the plan editor, with
  every `ts`/`tsx` fence as a Monaco block and every supported `mermaid` flowchart as a structural
  diagram.
- When the human edits any block, the plan editor shall write the whole document to the file within
  the debounce window, preserving every byte of blocks that were not edited.
- When the human deletes an edge, connects two nodes, renames a node, adds or removes a node, or moves
  a node into a subgraph, the diagram block shall serialise back into the same fence as valid Mermaid
  that renders the same structure in `mermaid-diagram.tsx`.
- While a node is being dragged, the plan editor shall not write to the file (positions are not
  persisted).
- When the file changes on disk and the editor is clean, the plan editor shall reload in place and
  mark blocks whose hash changed.
- If the file changes on disk while an edit is pending, then the plan editor shall keep the pending
  edit, stop writing through, and show the conflict banner until the human chooses.
- When the human adds a comment on a block, the plan editor shall persist it to the sidecar with the
  block's `{index, hash, snippet}` anchor before the composer closes.
- When Send is activated with a live terminal, the plan editor shall paste the handoff as one
  bracketed paste with no trailing newline and record the new `baseline` in the sidecar.
- When an agent write changes a block, the plan editor shall replace that block's `baseline` hash so
  the block is not reported as human-changed on the next Send.
- If no terminal is live for the session, then Send shall become Copy as markdown with identical content.
- The plan editor shall expose every diagram edit through a non-drag pathway (context menu and
  keyboard) and announce it via a polite live region.
- If a Mermaid fence uses syntax outside the supported subset, then the block shall render read-only
  with Edit as text and shall never be rewritten by the structural editor.

**Gherkin, key flows**
```gherkin
Feature: Interactive plan round trip
  Background:
    Given a project is open with a live session terminal
    And the agent has written .conduit/plans/identity.md containing a flowchart with edge txn-svc --> identity-svc

  Scenario: Rewire an edge and send
    When the human opens the plan and deletes the edge txn-svc --> identity-svc in the diagram
    Then within 300 ms the fence in identity.md no longer contains that edge
    And the rest of the file is byte-identical
    When the human comments "txn must not call identity directly" on the diagram block
    And activates Send to agent
    Then the session terminal receives one paste naming the plan, the changed diagram fence, and the comment
    And the sidecar baseline records the diagram block's new hash

  Scenario: Agent revises while the human is idle
    Given the human has no pending edit
    When the agent rewrites identity.md changing only the signature block
    Then the editor reloads without losing scroll position
    And only the signature block carries the changed-by-agent marker

  Scenario: Agent revises while the human is typing
    Given the human is mid-edit in a paragraph
    When the agent rewrites identity.md
    Then the paragraph keeps the human's text
    And the conflict banner offers Load theirs and Keep mine
    And nothing is written to disk until one is chosen
```

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Plan editor | first-run | "No plans yet. Ask your agent: *write an interactive plan for …*" | Copy prompt |
| Plan editor | loading | Document chrome immediately; block skeletons | none |
| Plan editor | populated | Live document; bottom action bar with Send to agent (N), Source toggle, open-comments count | edit, comment, send |
| Plan editor | saving / saved | Subtle "Saved" in the bar; never a toast per keystroke | none |
| Plan editor | save-failed | Bar turns to "Couldn't save: <reason>" + Retry; Send disabled | Retry |
| Plan editor | read-only (permission) | Bar: "This file is read-only"; editing blocked, commenting allowed | none |
| Plan editor | load-failed | "Can't open this plan: <reason>" + Open as text | Open as text |
| Plan editor | partial | N/A: the file is small and loads whole | |
| Plan editor | external-change-clean | Blocks with agent-changed marker; "3 blocks changed by the agent" chip + Next | Next change |
| Plan editor | external-change-dirty | Conflict banner, editing continues, write-through paused | Load theirs / Keep mine |
| Plan editor | not-found | "This plan was deleted" | Recreate empty / Close |
| Plan editor | source view | Monaco over the whole file; live blocks hidden | Toggle back |
| Diagram block | populated | Nodes laid out by elkjs, subgraphs as regions, edge labels | drag, connect, rename, delete, add |
| Diagram block | empty | Dashed canvas, **Add node** | Add node |
| Diagram block | unsupported | Rendered diagram + "This diagram uses syntax the editor can't round-trip" + Edit as text | Edit as text |
| Signature block | populated | Monaco, diagnostics squiggles, language chip | edit |
| Signature block | worker-pending | Monaco without diagnostics; chip "checking…" | none |
| Comment thread | open / resolved / detached / unsaved | Thread rows as in review notes; detached group at top with snippet; unsaved marked with Retry | reply, resolve, delete (confirms), re-attach |
| Comments panel | never-commented / all-resolved | "No comments yet" with the `c` hint / "All N resolved" | none |
| Comment composer | limit-reached | Counter becomes "4 KB limit" text; Save disabled | trim |
| Send button | ready / nothing-to-send / no-terminal / disabled(save-failed) | "Send to agent (N)" / "Nothing to send" / "Copy as markdown" / disabled with tooltip | activate |

## 9. Interaction inventory (UI)

Desktop Electron app: no touch targets are specified.

| Component | Actions | Pointer | Keyboard | Context menu | ARIA |
|---|---|---|---|---|---|
| Prose block | edit, comment | click to place caret; hover shows comment gutter button | standard editing; `c` on a focused block opens composer; Mod+Enter saves comment | Comment, Copy as markdown | `textbox` (ProseMirror); gutter button labelled "Comment on this block" |
| Diagram node | select, move (session), rename, delete, connect, group into subgraph | click; drag; double-click rename; drag from handle to connect | Tab into diagram, arrows move selection, Enter rename, Delete remove, `Shift+C` "Connect to…" picker, `Shift+G` group | Rename, Connect to…, Move to subgraph…, Delete | `group` with `aria-roledescription="node"`, `aria-selected`; live region announces "Connected A to B" |
| Diagram edge | select, delete, relabel | click; hover highlight | arrows select edges when focus is on an edge list; Delete; Enter relabel | Relabel, Delete | `aria-roledescription="edge"` |
| Diagram block toolbar | Add node, Add subgraph, Fit, Edit as text | click | Tab-reachable buttons | none | buttons with names |
| Signature block | edit | click | Monaco defaults; Esc returns focus to the document | Monaco's own | Monaco's own `textbox` |
| Comment thread row | reply, resolve, delete (confirms), re-attach (detached only) | click; hover reveals actions | Tab to row, Enter opens reply composer, `r` resolve, Delete confirms, **Re-attach to…** opens a block picker navigated with arrows | Reply, Resolve, Re-attach to…, Delete | `listitem` in a `list` labelled "Comments"; status in text |
| Send / Copy | activate | click | Enter/Space; global Mod+Shift+Enter when a plan tab is active | none | `button`, disabled reason in `aria-describedby` |
| Conflict banner | choose | click | Tab between two buttons; Esc does nothing (must choose) | none | `alertdialog` |

Every drag (node move, connect, re-attach) has a non-drag pathway (context menu + keyboard). Undo
policy is in §4.

## 10. Accessibility & i18n (UI)

- **Keyboard:** all actions in §9 reachable without a pointer; the diagram is one Tab stop that
  opens into arrow navigation, Esc leaves it.
- **Focus:** visible ring on nodes, edges, blocks, and bar buttons in all three themes; survives
  forced-colors (outline, not box-shadow only).
- **Names:** every icon-only control has `aria-label`; blocks announce their kind and heading.
- **Live region:** polite announcements for saved, save failed, connected/disconnected/renamed,
  agent changed N blocks, sent to agent.
- **Drag alternative:** WCAG 2.5.7 satisfied by the context-menu and keyboard pathways.
- **Colour:** agent-changed and detached markers pair colour with an icon and text.
- **Reduced motion:** layout transitions and marker pulses disabled under `prefers-reduced-motion`.
- **Focus management:** after Load theirs, focus lands on the first changed block; after Send, on
  the Send button (now disabled) with the announcement.
- **i18n:** Conduit ships English-only with strings in components (ASSUMED, §2). Decision: this
  feature follows that convention and does not introduce an externalisation layer; plural forms
  ("1 block", "3 blocks") are handled in the two strings that need it; timestamps are stored
  ISO-8601 UTC and shown with `Intl.DateTimeFormat` in the user's locale; layouts are not sized for
  text expansion; RTL is not addressed. All consistent with the rest of the app.

## 11. Design tokens (UI)

Semantic roles, all mapped in the three existing themes: block hover surface, block focus ring,
comment gutter affordance (quiet role), agent-changed marker (state accent, not pointer accent, per
the interaction-state vocabulary spec), detached-comment marker (warning), diagram node surface /
border / selected, subgraph region fill, edge stroke / selected / label, conflict banner surface
(warning), save-failed (danger). No raw colours in the components.

## 12. Assumptions

- Milkdown 7.22 (`@milkdown/kit` + `@milkdown/react`) is the block editor: ProseMirror over a remark
  AST, so the file stays the model and custom node views can host Monaco and xyflow. Its React 19
  compatibility is assumed and is the first thing the plan should verify with a spike.
- Round-tripping through remark may normalise Markdown style (list markers, emphasis characters).
  Accepted: the agent does not care about style, and unedited *blocks* are byte-preserved by
  splicing, not re-stringified.
- elkjs (0.12) for diagram layout, run in a worker.
- The existing `.conduit/` watcher, self-echo suppression, and `pasteToTerminal` are reused as-is.
- The plan editor is a document tab kind, routed by path prefix, not a new center view.
- Freeform diagram elements are not needed for MVP: Mermaid subgraphs express boundaries and prose
  around the diagram expresses notes.
- The skill lives at `resources/skills/conduit-interactive-plan/SKILL.md` and is installable through
  the existing skills service; it tells the agent the path, the three block conventions, the
  supported Mermaid subset, to read the sidecar every turn, and to reply to comments there.

## 13. Decisions Needed

None flagged `high`. The `ASSUMED` rows in §2 are mirrored here with the default taken:
- [normal] `.md` opens read-only today with Mermaid as pictures — default: build the plan editor as a
  new tab kind; nothing in the markdown viewer changes.
- [normal] Review notes' anchor ladder and paste handoff work as their source describes — default:
  reuse; the plan verifies with the existing unit tests before extending.
- [normal] No i18n layer exists — default: follow the app (§10).
- [normal] Watcher debounce 250 ms with self-echo suppression — default: reuse `ConduitDirWatch` and
  `isSelfEcho`; the 1 s banner bound in §7 depends on it.
- [normal] `view-state-store` persists per-view UI state renderer-side — default: source-view toggle
  lives there.

## 14. Open questions

1. Should a block be able to carry an optional link to a real file (`path:` in a fence info string)
   in MVP rather than Vision? Cheap, and it is the seed of stub-first design. Default: Vision.
2. Whether the diagram block should render Mermaid's own SVG when *not* focused (exact fidelity with
   the markdown viewer) and switch to the structural editor on focus. Default: structural always,
   since layout parity with static Mermaid is not a goal.
