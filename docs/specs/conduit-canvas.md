# Spec — conduit-canvas (F0)

**Tier:** LITE · **Type:** non-UI (host-side persistence wiring)

## Problem frame

**Job:** When a human edits the architecture canvas in Conduit, the diagram must
persist to a committed, LLM-readable, round-trippable file at the opened project's
root — `.conduit/architecture.json` — in the ADR 0002 envelope, so an agent dropped
into the repo reads the same artifact the app wrote.

Today the canvas persists to a **bare** `<root>/architecture.json` via the
`requestArchitecture` / `updateArchitecture` IPC path, and write errors are swallowed
(`fs.writeFile(..., () => {})`). ADR 0002 added a persistence layer
(`src/conduit-store.ts` + `electron/conduit-fs.ts`) that wraps `ArchDoc` in the
versioned envelope, writes atomically to `.conduit/`, and **rejects** on FS error.
This feature wires the canvas's existing IPC handlers onto that layer.

**Actors:** the human editing the canvas (in the Electron app); an external agent
reading `.conduit/architecture.json` (downstream, not exercised here).

**Success outcomes:**

- A canvas edit writes `<root>/.conduit/architecture.json` in the `conduit:1`,
  `kind:"architecture"` envelope (atomic, mkdir -p).
- Opening a project loads from `.conduit/architecture.json`; if absent, it migrates
  the legacy bare `<root>/architecture.json` (no diagram is lost); if neither exists,
  behavior is unchanged (renderer seeds).
- LLM-readable prose fields (node `subtitle`/`description`, edge `label`) survive the
  round-trip (already guaranteed by `serializeArchitecture` / `restoreArchitecture`).
- A failed write is surfaced (logged + error message to renderer), never silently
  mistaken for success.

**Non-goals:**

- No agent-proposal plumbing (`*.proposed.json`, accept/reject UI) — ADR §3 defers it.
- No board / specs migration (that is G0/G3).
- No change to the renderer's canvas UI, the protocol message shapes, or the
  preview-mode mock bridge.
- No deletion of the legacy bare `architecture.json` (read-migrate only; leave the
  old file in place so a downgrade still finds it).

## Behavior & states (read / migrate / write)

**Read (`requestArchitecture { path }`):**

1. `.conduit/architecture.json` present & valid → use it.
2. Else legacy bare `<path>/architecture.json` present & valid → use it (migration;
   it is written to `.conduit/` on the next save — no eager rewrite).
3. Else → `null` (renderer seeds, unchanged from today).

Reply is the existing `{ type:'architecture', path, doc }` message; `doc` is
`ArchDoc | null`.

**Write (`updateArchitecture { path, doc }`):**

- Write via `writeArchitectureArtifactFile(path, doc)` → `.conduit/architecture.json`
  (mkdir -p, atomic, rejects on error).
- On rejection: log to host stderr **and** send `{ type:'error', message }` to the
  renderer (the existing error channel), so the failure is visible.

## Data / interface contract

- No protocol change. `requestArchitecture`/`updateArchitecture`/`architecture`
  message shapes are unchanged — only the host's storage backend changes.
- Envelope + payload validation is owned by `src/conduit-store.ts` (`readArchitectureArtifact`,
  `serializeArchitectureArtifact`) and `src/architecture.ts` (`restoreArchitecture`).
  This feature does not re-validate.
- Resolution: `.conduit/` at the **opened project root** (`m.path`), per ADR §6 —
  same root the legacy file used, one dir deeper.

## Edge cases & failure modes

- **Both files exist** (`.conduit/` and legacy): `.conduit/` wins (it's the newer
  canonical home; last save went there).
- **`.conduit/architecture.json` exists but is corrupt/unparsable:** the store's
  `readArchitectureArtifact` returns `null`; we then fall through to legacy, then to
  `null` (seed). Corruption never throws on read.
- **Legacy file is a bare payload:** the store tolerates un-enveloped payloads, so it
  loads.
- **Write fails (EACCES / ENOSPC / EROFS / path is a file):** the promise rejects;
  we surface it. The user's in-memory diagram is unaffected; next edit retries.
- **Concurrent writes:** the debounce (300ms) in the renderer collapses bursts;
  atomic rename means a reader never sees a half-written file. Last write wins.
- **`m.path` empty/undefined (preview):** the host handler isn't reached in preview
  (the mock bridge answers); guarded by the renderer only posting when `projectPath`
  is set. Host treats a falsy path defensively (the read returns seed-null, write is
  skipped) — see Decisions Needed.

## Defaults vs. settings

- No new settings. Migration is automatic and silent (the safe default: never lose a
  diagram). Rationale: the legacy file is strictly older; reading it forward is
  lossless and one-way (we never write back to the bare path).

## Scope slicing

- **MVP (this task):** read-with-legacy-migration + write-to-`.conduit/` +
  error-propagation, wired into the two existing host handlers. Unit-tested decision
  logic; host-temp round-trip.
- **v1 (later):** optionally delete the legacy bare file after a successful migration
  write (deferred — keeping it is the conservative choice).
- **Out of scope:** proposal flow, board/specs, any UI.

## Acceptance criteria

- AC1: With `<root>/.conduit/architecture.json` present, `requestArchitecture`
  returns its decoded `ArchDoc`.
- AC2: With only the legacy bare `<root>/architecture.json` present (no `.conduit/`),
  `requestArchitecture` returns the legacy doc (migration), and prose fields
  (`description`, edge `label`) are intact.
- AC3: With neither present, `requestArchitecture` returns `null`.
- AC4: `updateArchitecture` writes `<root>/.conduit/architecture.json` as a
  `conduit:1` / `kind:"architecture"` envelope; reading it back equals the input doc.
- AC5: When the write target can't be created (root is a file), the host sends a
  `{ type:'error' }` message and does not crash.
- AC6: `.conduit/` precedence over legacy when both exist.
- AC7: No real `.conduit/` is created in the Conduit repo itself by tests (temp dirs
  only).

## Decisions Needed

- (normal) **Empty/falsy `m.path` on read:** assume the conservative default — return
  `null` (seed) rather than reading from CWD. Reversible. The renderer already guards
  by not posting when `projectPath` is falsy, so this is defense-in-depth.
- (normal) **Keep legacy bare file after migration:** assume keep (don't delete). Most
  conservative / reversible; v1 can revisit.
- (normal) **Error surfacing channel:** reuse the existing `{ type:'error', message }`
  protocol message (already handled by the renderer) rather than adding a new one.
