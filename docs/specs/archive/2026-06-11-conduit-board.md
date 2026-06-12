# Spec — conduit-board (G0): the agent-driven, live feature board

**Status:** ready to build
**Wishlist item:** G0 — "conduit-board". Move the feature board onto `.conduit/board.json`
and make it an agent-driven, live-updating feature tracker (Wishlist → Planning →
Building → Done) — the operational twin of `docs/wishlist.md`.

## Problem

Today the in-app Kanban board reads/writes a single `board.json` at the **Conduit
install root** (`__dirname/../board.json`), via the `requestBoard` / `updateBoard` IPC
path with a fire-and-forget `fs.writeFile(..., () => {})` that swallows write errors.
Two limitations:

1. **It is not per-project.** Every project Conduit opens sees Conduit's *own* backlog.
   The architecture canvas already went per-project (`.conduit/architecture.json`, F0);
   the board has not.
2. **It is not live.** When an external agent advances a card by editing the file on
   disk, the open app does not notice — you have to reopen the board. The whole point of
   "the agent advances cards and the board moves" is lost.

ADR 0002 defines `.conduit/` as the committed, per-project home for this knowledge and
defers the board's convergence to **G0 (this task)**.

## Coexistence model (the load-bearing decision)

**Chosen: per-project `.conduit/board.json`, resolved at the OPENED project root — the
repo-root `board.json` is left exactly as-is.**

- The in-app board reads/writes `<openedProjectRoot>/.conduit/board.json` through the
  persistence layer (`readBoardArtifactFile` / `writeBoardArtifactFile`), where
  `openedProjectRoot` is the active session's `projectPath` — **the same root the
  architecture canvas already uses** (`m.path`). It is NOT `__dirname/../board.json`.
- The committed **repo-root `board.json` is untouched** by this change. It remains the
  overnight agent's direct-write surface for Conduit's *own* repo (per `CLAUDE.md`), and
  this task does not read, write, migrate, or delete it. The legacy `boardFile()`
  helper and its IPC cases are replaced by the per-project path; the *file* on disk in
  this repo is not modified as a side effect.
- **No auto-seed into foreign projects.** Absent `.conduit/board.json` ⇒ an EMPTY board
  (`readBoardArtifact` returns `{ version, cards: [] }`, never `seedBoard()` — ADR §5).
  `seedBoard()` (Conduit's F1–F9 backlog) stays bound to nothing here; it is no longer
  used as the host's board default. (The browser-preview mock keeps seeding a sample so
  the board is visible in screenshots — preview only, never the app.)
- **No open project ⇒ no board root.** Like the architecture canvas with no
  `projectPath`, the board with no active project has nowhere to persist. It shows an
  empty board and does not post reads/writes (guarded on a falsy path). This is the
  honest behavior: the board belongs to a project.

Why per-project and not "converge Conduit's own root board onto `.conduit/`": the ADR
flagged that convergence as a *behavior change* (it must reconcile the overnight agent's
direct-write expectation with the human-owned/agent-proposes contract), not a file move.
This task delivers the file move + live-watch for *arbitrary opened projects* and
deliberately leaves Conduit's own root board on its existing direct-write workflow. A
follow-up (or the overnight agent learning `.conduit/`) can converge them later.

## Phase pipeline: Wishlist → Planning → Building → Done

The canonical agentic pipeline is **Wishlist → Planning → Building → Done**. The board
model (`src/board.ts`) **already** expresses exactly these four stages
(`wishlist | planning | building | done`), in this order, with these labels. No column
change is required.

What this task adds is a **pure, tested stage-reconciliation mapping** so an external or
legacy board whose cards use *other* stage spellings still loads cleanly instead of
having those cards silently dropped by `restoreBoard`'s `isStage` filter:

| Incoming stage (any case, trimmed)        | Canonical stage |
| ----------------------------------------- | --------------- |
| `wishlist`, `wish`, `backlog`, `idea(s)`  | `wishlist`      |
| `planning`, `plan`, `todo`, `to-do`, `next` | `planning`    |
| `building`, `build`, `in-progress`, `inprogress`, `wip`, `doing`, `started` | `building` |
| `done`, `complete`, `completed`, `shipped` | `done`         |
| (anything unrecognized / non-string)      | `null` → card dropped |

This mapping is **idempotent** (a canonical stage maps to itself) and is applied at the
read boundary, so the board the renderer sees is always in canonical stages. It does not
change the on-disk file unless the board is subsequently saved (then it writes canonical
stages forward — a one-way, lossless reconciliation).

**Unrecognized stages still drop the card** (`migrateStage` returns `null`). This
preserves the existing malformed-card guard (`restoreBoard` already drops cards with a
non-stage `stage`): a genuinely garbage stage string is a malformed card, not a card to
silently park in Wishlist. Only *known* legacy spellings are rescued. The trade-off vs.
"unrecognized → wishlist" is that we don't resurrect garbage cards into the visible
board; the cost is that a board using a stage name we didn't anticipate loses those
cards — acceptable, and the alias list covers the common agentic vocabulary.

## Live reflection (the "real-time view")

When an external agent edits `<root>/.conduit/board.json`, the open app updates the
board **live**, without the user reopening it.

**Mechanism (host side):**

1. When the renderer requests the board for a project root, the host (a) reads + replies
   as today, and (b) starts a **single FS watch** on that project's `.conduit/board.json`
   (via `fs.watch` on the file, falling back to watching `.conduit/` and filtering to
   `board.json` since the atomic rename swaps the inode). One watch at a time; switching
   project root tears down the previous watch and starts a new one.
2. On a watch event, **debounce** (250 ms — atomic rename + editors fire multiple
   events) then re-read the file and push a fresh `board` message to the renderer.
3. **Loop avoidance.** Every host write records the exact serialized bytes it just wrote
   (a content fingerprint). When the watcher re-reads after an event, if the file's
   current bytes equal the last-written fingerprint, the event is the app's **own write
   echoing back** — it is ignored (no re-emit). Only a *genuine external change*
   (bytes differ from what we last wrote) is pushed to the renderer. This prevents the
   write→watch→emit→… feedback loop.

The fingerprint comparison + "is this our own echo?" decision is **pure and unit-tested**
in isolation (`src/board-watch.ts`: `isSelfEcho(lastWritten, current)`), factored out of
the host's FS plumbing so the loop-avoidance logic is testable without Electron.

**Renderer side:** the board view already subscribes to `board` messages and calls
`setBoard`. Live updates arrive on that same channel. Two guards are added:
- a live external update must not clobber an in-flight local edit: if the user is
  mid-edit (a pending debounced save), the incoming external board is still applied —
  external truth wins for the *agent advances cards* story — but the renderer's pending
  save is cancelled so it does not immediately overwrite the agent's change. (Documented
  trade-off; last-writer conflicts are out of scope and rare for a single-user board.)
- `window.agentDeck` undefined (browser preview): no host, no watch; the mock board
  behaves as today.

## Protocol changes

`requestBoard` and the `board` reply gain a project `path` (mirroring `requestArchitecture`
/ `architecture`), and `updateBoard` gains `path`:

```ts
// WebviewToHost
| { type: 'requestBoard'; path: string }
| { type: 'updateBoard'; path: string; board: BoardData }
// HostToWebview
| { type: 'board'; path: string; board: BoardData }
```

The renderer ignores a `board` reply whose `path` is not the current project root (same
guard the architecture view uses), so a stale reply for a previous project can't land.

## Files

- **`src/board.ts`** — add `migrateStage(raw): Stage` (pure, exported) + apply it inside
  `restoreBoard`'s card mapping so non-canonical stages reconcile instead of dropping.
- **`src/board-watch.ts`** (new, pure) — `isSelfEcho(lastWritten, current)` loop-avoidance
  predicate + a tiny `fingerprint(text)` helper. No FS, no Electron.
- **`electron/conduit-fs.ts`** — `readBoardForProject(root)` (guards falsy root → empty
  board; mirrors `readArchitectureForProject`). Writers already exist.
- **`electron/board-watcher.ts`** (new, host) — `BoardWatcher`: start/stop an `fs.watch`
  on a project's `.conduit/board.json`, debounce, apply `isSelfEcho`, invoke a callback
  with the fresh board on a genuine external change. Records the fingerprint on each app
  write so echoes are suppressed.
- **`electron/main.ts`** — rewire `requestBoard` / `updateBoard` onto the per-project
  path + `readBoardForProject` / `writeBoardArtifactFile`; surface write errors (don't
  swallow); own a single `BoardWatcher` and post `board` on external change; tear down on
  quit. Remove the legacy `boardFile()` helper + its `restoreBoard`/`serializeBoard`
  root-board usage.
- **`src/protocol.ts`** — add `path` to the three board messages.
- **`webview/components/board-view.tsx`** — accept `projectPath`; request the board for
  it; filter `board` replies by path; cancel a pending save when an external update
  lands; guard a falsy path.
- **`webview/app.tsx`** — pass `projectPath={active?.projectPath}` to `<BoardView>`.
- **`webview/bridge.ts`** — mock `requestBoard`/`updateBoard`/`board` carry `path`.

## Acceptance criteria

- **AC1 (per-project persist):** With a project open, adding/moving/editing a card writes
  `<root>/.conduit/board.json` (an envelope, `kind: "board"`), and a failed write surfaces
  an `error` message rather than being swallowed. The repo-root `board.json` is never
  touched.
- **AC2 (empty default):** Opening a project with no `.conduit/board.json` shows an empty
  board (no Conduit seed cards leak in).
- **AC3 (phase pipeline):** Columns are exactly Wishlist → Planning → Building → Done. A
  board file whose cards use legacy stage spellings (`backlog`, `in-progress`, `todo`,
  `complete`) loads with those cards mapped to the canonical stages (none dropped).
- **AC4 (live external edit):** With the board open, an external edit to
  `.conduit/board.json` (e.g. an agent moving a card wishlist→building) updates the open
  board within ~½ s, without reopening it.
- **AC5 (no self-loop):** The app's own save does not trigger a redundant
  reload/re-emit cycle (the self-echo is suppressed by fingerprint).
- **AC6 (no project / preview):** With no active project the board is empty and posts no
  read/write. In the browser preview (`window.agentDeck` absent) the board still renders
  (mock) with no host calls.

## Out of scope

- The agent **proposal** flow (`*.proposed.json`, suggest/accept UI) — ADR defers to a
  later task; this is direct human edit + direct agent file edit (the agent's edit is the
  "external change" the watcher reflects).
- Converging Conduit's **own** root `board.json` onto `.conduit/` (behavior change;
  deferred — see Coexistence).
- Specs under `.conduit/specs/` (G3) and skill-driven stage transitions (G4).
- Multi-writer conflict resolution beyond "external truth wins, cancel pending local save."
