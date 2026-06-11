# Plan — board-skill-transitions

Spec: `docs/specs/board-skill-transitions.md`. Test-first throughout.

## Files

| File | Change |
| --- | --- |
| `src/pipeline.ts` | NEW. Pure model: types, `transitionKey`, `skillForTransition`, `setTransitionSkill`, `emptyPipelineConfig`, `serialize/restorePipeline`, queue helpers (`buildQueueEntry`, `appendQueueEntry`, `serialize/restorePipelineQueue`). |
| `src/conduit-store.ts` | Add `'pipeline'` + `'pipeline-queue'` kinds + `serialize*Artifact` / `read*Artifact` for each (envelope wrappers, bare-payload tolerant). |
| `electron/conduit-fs.ts` | Host FS: `readPipelineForProject`, `writePipelineArtifactFile`, `readPipelineQueueFile`, `appendPipelineQueueEntry` (read-modify-write atomic). |
| `src/protocol.ts` | New messages: `requestPipeline`/`pipeline` (host→wv), `updatePipeline`, `queueTransition` (wv→host). |
| `electron/main.ts` | Handlers for `requestPipeline`/`updatePipeline`/`queueTransition`. |
| `webview/bridge.ts` | Mock-host handling for the new messages (in-memory pipeline config + queue). |
| `webview/components/board-view.tsx` | Pipeline button + panel; surface skill (toast) + `queueTransition` on every move path. |
| `webview/styles.css` | Pipeline panel + toast styles (reuse existing tokens). |
| `test/unit/pipeline.test.ts` | NEW. Pure model + queue logic. |
| `test/unit/conduit-fs.test.ts` | Add pipeline round-trip + queue append (temp dir). |
| `test/unit/conduit-store.test.ts` | Add pipeline envelope read/serialize + bare tolerance. |

## Steps

1. **`src/pipeline.ts` (pure)** — TDD via `test/unit/pipeline.test.ts`:
   - `Stage` reused from `board.ts`.
   - `transitionKey(from, to) => `${from}->${to}``.
   - `CANONICAL_TRANSITIONS` = the 3 forward-adjacent pairs (with labels for UI).
   - `emptyPipelineConfig()`, `skillForTransition(cfg, from, to)`,
     `setTransitionSkill(cfg, from, to, skill)` (trims; empty removes the key).
   - `serializePipeline` / `restorePipeline` (validate `transitions` is a string→string
     record; drop non-string values; fall back to empty on garbage — never throw).
   - Queue: `buildQueueEntry(card, from, to, skill, now, id?)`, `appendQueueEntry`,
     `emptyPipelineQueue`, `serialize/restorePipelineQueue`.

2. **`src/conduit-store.ts`** — extend `ConduitKind`; add
   `serializePipelineArtifact`/`readPipelineArtifact` and the `-queue` pair, reusing
   `wrap`/`unwrapPayload`. Add to `FILE_FOR` mapping in conduit-fs (`pipeline.json`,
   `pipeline-queue.json`). Test in `conduit-store.test.ts`.

3. **`electron/conduit-fs.ts`** — `readPipelineForProject` (empty if falsy/absent),
   `writePipelineArtifactFile` (atomic, surfaced), `readPipelineQueueFile`,
   `appendPipelineQueueEntry` (read current → append → atomic write). Temp-dir tests.

4. **Protocol + main.ts** — wire the three messages; thread `path`. `queueTransition`
   appends; failure → `error` message (best-effort, never blocks).

5. **bridge.ts mock** — in-memory `mockPipeline` config + `mockQueue`; reply to
   `requestPipeline`, store on `updatePipeline`, append on `queueTransition`. Keeps the
   browser preview working (guard `window.agentDeck` undefined).

6. **board-view.tsx** — load config on open; `Pipeline` header button toggles a panel;
   a `surfaceMove(from,to,card)` helper called from BOTH move paths (context menu +
   drag drop) that, when `skillForTransition` is truthy, shows a toast + posts
   `queueTransition`. Toast auto-dismisses.

7. **Gates** — `npm run verify` + `npm run build`; capture to
   `.autoloop/evidence/board-skill-transitions-verify.log`.

8. **Runtime proof** — unit tests + host temp round-trip; preview no-regression
   (Pipeline panel renders, configured move shows toast). Be explicit re: real-app +
   execution-out-of-scope. → `.autoloop/evidence/board-skill-transitions-runtime.txt`.

9. **Review** — `superpowers:requesting-code-review`; fix blocking; then
   `verification-before-completion`.

## Risks / notes

- Surface helper must read `from` BEFORE applying the move (the card's current stage).
- Drag path: `dragCard.current` is the id; look up the card's current stage from
  `board` before `moveCard`.
- A no-op move (drop onto the same column) must NOT surface — guard `from !== to`.
- Don't write a real `.conduit/` into Conduit's repo; tests use `os.tmpdir()`.
