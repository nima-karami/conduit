# Implementation plan — board-spec-docs (G3)

Spec: [conduit-specs.md](./conduit-specs.md). Test-first; both gates green at the end.

## Step 1 — Pure sanitization (test-first)

1. Add `safeSpecFileName(cardId): string` to `electron/conduit-fs.ts` (pure, no FS).
2. Write `test/unit/conduit-specs.test.ts` covering §3 examples + the invariant "no
   separator, no leading dot, never empty". RED first.
3. Implement until green.

## Step 2 — Host FS helpers (test-first, temp dirs)

1. Add `SPECS_DIR`, `specsDir(root)`, `specPath(root, cardId)` (with the `path.relative`
   containment assertion), `readSpec`, `writeSpec` (reuse `writeAtomic`), `hasSpec`,
   `listSpecs`.
2. Extend the test file: write→read round-trip in a temp dir, dir auto-create, no `.tmp`
   leftovers, `hasSpec`/`listSpecs`, traversal containment (write with a `../` id lands
   inside specs/), unwritable-target rejection. NEVER write a real `.conduit/` in the repo.

## Step 3 — IPC

1. `src/protocol.ts`: add `requestSpec`/`saveSpec` (WebviewToHost) and
   `spec`/`specsList` (HostToWebview).
2. `electron/main.ts`: handle `requestSpec` (read -> emit `spec`), `saveSpec` (write,
   surface errors), and emit `specsList` alongside the `board` reply in `requestBoard`.
3. `webview/bridge.ts`: mock-host answers for `requestSpec`/`saveSpec` + `specsList` on
   `requestBoard` so preview works; keep an in-memory `mockSpecs` map.

## Step 4 — UI (board-view)

1. Add "Open spec" to the card context menu.
2. Add a `SpecEditor` overlay component (title, textarea, Save, Esc-close; seeds
   `# <title>` when absent). Wire `requestSpec`/`saveSpec` via `post`/`subscribe`.
3. Track a `specCardIds: Set<string>` from `specsList` (+ optimistic add on save) and
   render an `IconDoc` badge on cards in the set.
4. Minimal CSS for the badge + editor overlay in `webview/styles.css`, matching the
   board's existing tokens.

## Step 5 — Gates + runtime proof

1. `npm run verify` and `npm run build`; capture to
   `.autoloop/evidence/conduit-specs-verify.log`.
2. Host-temp round-trip already proven by unit tests; add a note + a scratch round-trip
   observation to `.autoloop/evidence/conduit-specs-runtime.txt`.
3. Preview no-regression: serve the built webview over HTTP, screenshot the board, confirm
   the "Open spec" affordance + indicator render. Be explicit that real disk persistence
   needs the Electron app (host FS).

## Step 6 — Review

`superpowers:requesting-code-review`; address blocking findings;
`superpowers:verification-before-completion`. Never weaken a gate.
