# Plan — conduit-board (G0)

Spec: `docs/specs/conduit-board.md`. Build test-first; pure pieces first, then host
wiring, then renderer. Match Biome style (single quotes, semicolons, 2-space, width 100,
kebab-case files).

## Step 1 — Stage reconciliation (pure, `src/board.ts`)

1. Write tests in `test/unit/board.test.ts` (extend) / a `describe('migrateStage')`:
   - canonical stages map to themselves (idempotent).
   - legacy spellings: `backlog→wishlist`, `todo→planning`, `in-progress`/`inprogress`/`wip`→`building`,
     `complete`/`completed`→`done`; case-insensitive + trimmed.
   - unknown → `wishlist`.
   - `restoreBoard` of a board with legacy stages keeps the cards (none dropped) with
     mapped stages.
2. Implement `export function migrateStage(raw: unknown): Stage`. Apply it in
   `restoreBoard`'s filter/map: accept a card if it has string id+title and a *mappable*
   stage (always mappable now), and set `stage: migrateStage(c.stage)`.

## Step 2 — Loop-avoidance predicate (pure, `src/board-watch.ts` new)

1. Tests `test/unit/board-watch.test.ts`:
   - `fingerprint(a) === fingerprint(a)`, differs for different text.
   - `isSelfEcho(last, current)` true when `current` equals `last` (our own write echo),
     false when they differ (genuine external change), false when `last` is undefined
     (we never wrote → any content is external).
2. Implement `fingerprint(text): string` (cheap — the text itself is fine as the
   fingerprint, or a hash; keep it a string compare) and
   `isSelfEcho(lastWritten: string | undefined, current: string): boolean`.

## Step 3 — Per-project board read (`electron/conduit-fs.ts`)

1. Extend `test/unit/conduit-fs.test.ts`:
   - `readBoardForProject('')` → empty board (falsy root, no cwd read).
   - `readBoardForProject(root)` with a written `.conduit/board.json` → that board.
   - absent → empty board.
2. Implement `readBoardForProject(projectRoot): BoardData` mirroring
   `readArchitectureForProject` (falsy guard → empty board; delegate to
   `readBoardArtifactFile`). No legacy root-board fallback (per-project only).

## Step 4 — BoardWatcher (host, `electron/board-watcher.ts` new)

1. Tests `test/unit/board-watcher.test.ts` (temp dirs, real `fs.watch`):
   - start watching a temp project; externally write `.conduit/board.json` with a moved
     card → the `onExternalChange` callback fires (debounced) with the new board.
   - after `recordWrite(serialized)` then writing those exact bytes, NO callback (self
     echo suppressed).
   - `stop()` removes the watcher (no callback after stop).
   - Use polling-with-timeout helpers, not fixed sleeps, so the test is robust on slow
     CI. Keep debounce small (e.g. 80 ms in tests via a constructor arg, 250 ms default).
2. Implement `BoardWatcher`:
   - `watch(projectRoot, onExternalChange)`: stop any prior watch; `fs.watch` the
     `.conduit/` dir (robust to atomic rename) filtered to `board.json`; on event,
     debounce, re-read the raw blob, `isSelfEcho(lastWritten, blob)` → skip if echo;
     else parse via `readBoardArtifactFile` and invoke callback.
   - `recordWrite(serializedBlob)`: store as `lastWritten` so the next event is
     recognized as our echo.
   - `stop()`: close the watcher + clear the debounce timer.
   - Guard: a falsy root is a no-op (just stops). Swallow `fs.watch` errors into a
     console.warn (watching is best-effort; persistence still works without it).

## Step 5 — Protocol (`src/protocol.ts`)

Add `path` to `requestBoard`, `updateBoard`, and the `board` reply. (Compile-driven;
`center-view.test.ts` etc. should stay green.)

## Step 6 — Host wiring (`electron/main.ts`)

1. Import `readBoardForProject`, `writeBoardArtifactFile`, `serializeBoardArtifact`,
   `BoardWatcher`. Drop `restoreBoard`/`serializeBoard`/`boardFile()`.
2. Own one `const boardWatcher = new BoardWatcher();`.
3. `requestBoard`: `const board = readBoardForProject(m.path); send({type:'board', path:m.path, board});`
   then `boardWatcher.watch(m.path, (b) => send({type:'board', path:m.path, board:b}))`.
4. `updateBoard`: serialize once; `boardWatcher.recordWrite(serialized)` (so the imminent
   watch event is recognized as ours); `writeBoardArtifactFile(m.path, m.board)` —
   `.catch` → console.error + `send({type:'error', ...})` (mirror updateArchitecture).
   (Record the fingerprint of the *same* bytes the writer will produce — reuse
   `serializeBoardArtifact` with a fixed nothing… use the writer's serialization. Simpler:
   have the writer return/accept the serialized text, or record `serializeBoardArtifact(m.board)`
   and accept that `updatedAt` differs; therefore fingerprint must ignore `updatedAt`.)
   → DECISION: fingerprint on the **`data` payload only** (cards), not the envelope's
   `updatedAt`, so the recorded fingerprint matches the file regardless of the
   provenance timestamp. Implement `fingerprint` over `JSON.stringify(board.cards)`.
5. `before-quit`: `boardWatcher.stop()`.

## Step 7 — Renderer (`webview/components/board-view.tsx`, `app.tsx`)

1. `BoardView({ projectPath, onClose })`. In the load effect: only `post({type:'requestBoard', path})`
   when `projectPath`; subscribe and accept `board` msgs where `msg.path === projectPath`.
   On an external board arrival, cancel any pending `saveTimer` then `setBoard`.
2. `apply`: include `path` in `updateBoard`; no-op the save if `!projectPath`.
3. Default initial board = `emptyBoardData()` (not `seedBoard()`), so an opened project
   with no file shows empty, and there's no flash of Conduit's backlog.
4. `app.tsx`: `<BoardView projectPath={active?.projectPath} onClose=… />`.

## Step 8 — Mock bridge (`webview/bridge.ts`)

`requestBoard`/`updateBoard`/`board` carry `path`; mock replies echo the path. Keep the
mock seeded sample (preview only).

## Step 9 — Gates + runtime proof

- `npm run verify` and `npm run build`; capture to
  `.autoloop/evidence/conduit-board-verify.log`.
- Host-temp runtime proof script (run with `node`/`tsx` against the compiled or
  ts-imported host modules) → write `.conduit/board.json` in a temp dir, read back,
  start a watcher, simulate an external edit, observe the callback; confirm self-echo
  suppressed. Observations → `.autoloop/evidence/conduit-board-runtime.txt`. The full
  in-app live update needs the real Electron app (note explicitly).

## Step 10 — Review + verification

`superpowers:requesting-code-review`; address blocking findings;
`superpowers:verification-before-completion`. Never weaken a gate. `git status` clean
(only intended files).
