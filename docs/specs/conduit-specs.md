# Feature spec — board-spec-docs (wishlist G3)

Status: Draft · Date: 2026-06-11 · Implements ADR
[0002 §2c](../adr/0002-conduit-artifact-format.md) (`.conduit/specs/<card-id>.md`)

## 1. Summary

Tie each feature-board card to a Markdown SPEC/plan document stored under
`<project-root>/.conduit/specs/<card-id>.md`. The link from a card to its spec is
**filename-derived** from the card's stable id (ADR §2c) — no link is stored on the
card. The board gains an affordance to open a card's spec for viewing/editing, saves
edits back to disk atomically, and shows a small indicator on cards that already have a
spec.

## 2. Goals / non-goals

Goals:
- Read/write a card's spec at `.conduit/specs/<card-id>.md` from the host FS layer.
- Sanitize the card id so it can never escape `.conduit/specs/` (path traversal /
  absolute paths / odd ids).
- IPC to read a card's spec and to save a card's spec (threading project `path` +
  `cardId`), mirroring the existing board IPC; renderer guards `window.agentDeck`
  absence.
- Board UI: a card context-menu item to open the spec; an editor to view + edit + save;
  a per-card indicator showing whether a spec exists.
- Spec is seeded (created in memory, persisted on first save) with the card title as a
  top-level heading when none exists.

Non-goals:
- No spec for the legacy root `board.json` (Conduit's own repo board) — G3 targets the
  per-project `.conduit/` board only, consistent with G0.
- No agent proposal flow for specs (ADR §3 defers that); specs are human-edited, written
  directly.
- No spec rename/migrate when a card is duplicated or its id changes (ids are stable; a
  duplicate gets a fresh id and therefore no spec — acceptable for MVP).
- No live FS watcher for spec files (board.json keeps its watcher; specs are loaded on
  open).
- No rich Markdown WYSIWYG; reuse the existing Markdown viewer + a plain editor.

## 3. Spec path derivation & sanitization

`specPath(root, cardId)` resolves to `<root>/.conduit/specs/<sanitized-id>.md`.

Sanitization (`safeSpecFileName(cardId) -> string`, pure, unit-tested):
- Card ids in this app are slug-like (`card-<base36>-<n>`, `seed-f1`, etc.), but G3 must
  be robust to a hand-edited / agent-written `board.json` carrying a hostile id.
- The function reduces an arbitrary id to a single safe path segment:
  - Take the basename only — strip any directory separators (`/`, `\`) so `../`,
    `a/b`, and absolute paths collapse to their last segment.
  - Replace every character that is not `[A-Za-z0-9._-]` with `_`.
  - Strip leading dots so a result can't be `.`, `..`, or a dotfile that escapes via
    `..`; collapse a now-empty or dots-only result to a stable fallback (`_`).
- It then asserts (defense in depth) that the joined `specPath` stays inside
  `conduitPath(root, 'specs')` via a normalized `path.relative` check; if not (should be
  impossible after sanitization), it throws rather than reading/writing outside the
  sandbox.

Examples (id -> filename):
- `card-abc` -> `card-abc.md`
- `../../etc/passwd` -> `passwd.md`
- `/abs/evil` -> `evil.md`
- `..` -> `_.md`
- `a/b/c` -> `c.md`
- `weird id!@#` -> `weird_id___.md`

## 4. Host FS helpers (`electron/conduit-fs.ts`)

- `SPECS_DIR = 'specs'` constant.
- `specPath(root, cardId)` — sanitized absolute path (above).
- `readSpec(root, cardId): string | null` — file contents, or `null` if absent /
  unreadable (mirrors the graceful-default read posture; absent spec is not an error).
- `writeSpec(root, cardId, md): Promise<void>` — mkdir -p `.conduit/specs/`, atomic write
  (reuses `writeAtomic`), errors surfaced (rejects).
- `hasSpec(root, cardId): boolean` — `fs.existsSync` of the spec path.
- `listSpecs(root): string[]` — card ids (filename without `.md`) that have a spec, for a
  cheap board-wide has-spec map. Returns `[]` if `.conduit/specs/` is absent.

Pure helpers (`safeSpecFileName`) live where they can be unit-tested without Electron;
the FS-touching functions are tested against an OS temp dir.

## 5. IPC (mirrors board IPC)

`WebviewToHost`:
- `{ type: 'requestSpec'; path: string; cardId: string }` — load a card's spec.
- `{ type: 'saveSpec'; path: string; cardId: string; content: string }` — persist it.

`HostToWebview`:
- `{ type: 'spec'; path: string; cardId: string; content: string; exists: boolean }` —
  the spec reply (`exists` distinguishes a real saved spec from a seeded-empty one so the
  UI can label "new").
- `{ type: 'specsList'; path: string; cardIds: string[] }` — the set of cards that have a
  spec, sent on board request so cards can render the indicator without N round-trips.

Host handlers: `requestSpec` -> `readSpec` (null -> seed with `# <card title>` heading?
No — host doesn't know the title; it returns `content: ''`, `exists: false`, and the
renderer seeds the heading from the card it already has). `saveSpec` -> `writeSpec`,
surfacing failures as an `error` message (no swallow, per ADR §5). `requestBoard` also
emits `specsList` so the board shows indicators immediately.

Renderer bridge: `post`/`subscribe` already guard `window.agentDeck` (fall back to a mock
host in preview); the mock answers `requestSpec`/`saveSpec`/emits `specsList` so the
preview board renders the affordance.

## 6. UI (board-view)

- Card context menu gains an **"Open spec"** item (reuses the G1 menu) that opens an
  in-board spec editor for that card.
- Spec editor: a modal/overlay within the board showing the card title, the Markdown
  content in a textarea (edit) with a rendered preview toggle if cheap, a Save button,
  and Escape/close. On open it `post`s `requestSpec`; on save it `post`s `saveSpec`. If no
  spec exists yet, the editor pre-fills `# <card title>\n\n` so saving creates the file.
  MVP uses a plain `<textarea>` (the app's Markdown VIEWER renders rendered MD, but the
  board editor is plain-text edit + save — Monaco is heavier and not needed here).
- Has-spec indicator: a small `IconDoc` badge on cards whose id is in the `specsList`
  set; after a save the set updates so the badge appears without reload.

## 7. Edge cases

- No project open -> board is empty; no spec affordance reachable (nothing to persist).
- Hostile/odd card id -> sanitized; never escapes `.conduit/specs/` (tested).
- Save failure (EACCES/EROFS) -> surfaced as an error toast/message, not silent.
- Absent spec on open -> editor seeds heading; file created only on Save.
- Concurrent external edit of a spec file -> last writer wins (no watcher for specs; out
  of scope, noted as a G4 follow-up).

## 8. Acceptance criteria

1. `safeSpecFileName` maps every example in §3 correctly and never yields a name
   containing a path separator or leading dot. (unit)
2. `specPath` for any of `../`, absolute, dotted, separator-laden ids resolves to a path
   inside `<root>/.conduit/specs/`. (unit, `path.relative` assertion)
3. `writeSpec` then `readSpec` round-trips Markdown through `.conduit/specs/<id>.md` in a
   temp dir; `.conduit/specs/` is created on first write; no `.tmp` leftovers. (unit, temp)
4. `hasSpec` is false before write, true after; `listSpecs` lists written ids. (unit, temp)
5. `writeSpec` to an unwritable target rejects (error surfaced). (unit, temp)
6. Board renders an "Open spec" context-menu item and a has-spec indicator on cards with
   a spec (preview no-regression). (runtime/preview)
7. `npm run verify` and `npm run build` both pass.
