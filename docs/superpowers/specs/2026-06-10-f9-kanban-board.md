# F9 — Feature Kanban board

## Goal
A board view inside Agent Deck to track features through stages
**Wish list → Planning → Building → Done**, shared between the user (daytime) and
the agent (overnight) via a repo JSON file both can read/write.

## Data model (src/board.ts, unit-tested)
- `Stage = 'wishlist' | 'planning' | 'building' | 'done'`; `STAGES` with labels.
- `BoardCard { id; title; notes; stage; links?: string[] }`.
- `BoardData { version; cards: BoardCard[] }`.
- Pure ops: `addCard(board, stage, title)`, `updateCard(board, id, patch)`,
  `moveCard(board, id, stage)`, `removeCard(board, id)`, `cardsIn(board, stage)`.
- `serializeBoard` / `restoreBoard(blob)` → merges/validates, falls back to a seed.
- Seed = the F1–F9 backlog (F1–F8 Done, F9 Building) so the board is useful day one.

## Persistence (shared with the agent)
Stored at **`board.json` in the repo root** so both the app and the overnight agent
edit the same file. Host resolves it relative to the app dir (`__dirname/../board.json`
in dev). Host loads on boot, sends on `requestBoard`, writes on `updateBoard`.
The agent advances cards by editing `board.json` directly (schema documented here).

## Protocol
- HostToWebview: `{ type: 'board'; board: BoardData }`.
- WebviewToHost: `{ type: 'requestBoard' }`, `{ type: 'updateBoard'; board: BoardData }`.

## UI (BoardView)
- Opened as a full view over the workbench (below the top bar). Toggle via a top-bar
  **board button** and a palette command "Open feature board"; Esc / button closes.
- 4 columns (stages) with counts; cards show title + notes preview + stage.
- **Drag cards between columns** to change stage (reuse the DnD pattern).
- **Add card** (per column), **edit** title/notes inline, **delete** card.
- All edits post `updateBoard` (debounced) → host persists → re-sync.

## Acceptance criteria
1. Board opens over the workbench from the top-bar button and the palette; Esc closes.
2. Shows the seeded F1–F9 cards in the right columns.
3. Dragging a card to another column changes its stage and persists (survives reload).
4. Add / edit / delete cards work and persist.
5. Editing board.json on disk is reflected after relaunch (agent ↔ UI sync).
6. board pure ops unit-tested; typecheck + build + tests green.
