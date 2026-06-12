# Save reliability (K2)

## The bug (user-visible)

> "I edit a file and save, and it doesn't save."

The Monaco editor was recently made editable (I2): `Ctrl+S` → `bridge.writeFile`
→ IPC `writeFile` in `electron/main.ts` → `src/file-service.ts` `writeFile`,
validated by `src/path-guard.ts` `validateWrite`. Per-doc dirty tracking lives in
`webview/dirty-store.ts`; the tab dirty dot is in `webview/components/doc-tabs.tsx`.

The save path itself works. The failure is in three reachability/visibility gaps.

## Root causes (re-verified against current code)

### A. Save is reachable only from inside Monaco

The save command is registered ONLY on the Monaco editor instance
(`editor.addCommand` / `editor.addAction` in `webview/components/code-viewer.tsx`).
`SHORTCUT_ACTIONS` in `webview/shortcuts.ts` has no `save` entry and `app.tsx`'s
global `keydown` handler doesn't map `Mod+S`. So with focus anywhere outside the
editor — the terminal (xterm), the sidebar, a filter input, the explorer — `Ctrl+S`
does **nothing**. There is also no visible save button/affordance: the only signal
that an edit is unsaved is the small dirty dot, and the only way to act on it is to
click into the editor first. Users hit `Ctrl+S` out of habit while focused
elsewhere, see nothing happen, and conclude "it doesn't save."

### B. Out-of-root files are rejected with an easy-to-miss banner

`writeRoots()` in `electron/main.ts` = open sessions' `projectPath`s + repo
history. A file opened via go-to-definition (which can resolve into
`node_modules`, a sibling package, or any absolute path the TS worker returns) or
via a recents entry pointing outside the current roots is **outside every root**.
`validateWrite` then rejects the write — correctly, for an arbitrary-path write —
but the only feedback is a small in-viewport banner inside the editor
(`viewer__banner--error`) that scrolls with content and is easy to miss. The user
edited a file Conduit *showed them*, hit save, and it "silently" failed.

## Design

Four parts, each independently testable.

### 1. Save registry + global shortcut

New module `webview/save-registry.ts`, mirroring the `dirty-store.ts` pattern: a
tiny external store keyed by doc **path**. The verb shape is an object
(`{ save(): void }`) rather than a bare function, so future verbs (revert, save-as)
slot in without a breaking change.

- `CodeViewer` registers its entry on mount and unregisters on unmount (path-keyed,
  same key space as the dirty store and doc tabs).
- A new `save` action is added to `SHORTCUT_ACTIONS` (`Mod+S`), routed through
  `app.tsx`'s `actionMap`. The handler looks up the **active doc's** path and
  invokes its registered `save()`. Guard: no active doc, or the doc isn't dirty →
  no-op (don't fight Monaco, don't toast).
- Monaco keeps its own `Ctrl+S` binding. When the editor is focused, Monaco
  consumes the keydown and `stopPropagation` does **not** reach `window`… except
  Monaco's command does NOT stop DOM propagation. To avoid double-firing, the
  global handler is idempotent: `save()` is internally guarded by a `saving` latch
  AND a clean-buffer check (`buffer === baseline` → return), so a second invocation
  in the same tick is a no-op. Saving the same clean bytes twice is harmless, but
  the guards mean the second call returns immediately without a second write.
- The active-doc routing is a pure function (`activeDocPath(docs, activeId)` →
  path | null) so it's unit-testable without React.

### 2. Visible save affordance on dirty tabs

In `doc-tabs.tsx`, the dirty dot becomes an interactive control: a `role="button"`
`<span>` (NOT a nested `<button>` — tabs are already `<button>`, and a known
button-in-button nesting issue is being fixed by another task; we must not make it
worse) with `title="Unsaved changes — Ctrl+S to save"` and an `onClick` that
`stopPropagation`s and calls a new `onSaveDoc(path)` prop. `app.tsx` wires
`onSaveDoc` to the same registry-routed save. Keyboard-activatable (Enter/Space)
for parity. Subtle: visually identical to today's dot at rest; only the cursor +
tooltip + click behaviour are added.

### 3. Unmissable failure surfacing — toast system

- `webview/toast-store.ts`: a minimal subscribe/push store. `pushToast({ message,
  variant })` returns an id; auto-dismiss after ~5s; `dismissToast(id)` for manual
  close; `subscribeToasts` / `getToastsSnapshot` for `useSyncExternalStore`.
  Variants: `info | error`. Pure timer logic injectable for tests (the store
  exports the array transitions as pure helpers; the timer is the only impure bit
  and is guarded so tests can drive it synchronously by calling dismiss directly).
- `webview/components/toasts.tsx`: rendered once in `app.tsx`, portalled to
  `document.body`, fixed bottom-right, above everything (`z-index` above modals).
  Dark panel, subtle border, matches the design language; no layout shift.
- On save **failure/rejection**: `pushToast` with the reason (and keep the existing
  in-editor banner). On save **success**: NO toast — silence = success; the dirty
  dot clearing is the signal.

### 4. Read-grant on the host

`writeRoots()` containment is correct for arbitrary writes, but too strict for a
file the host **itself chose to serve** to the editor. Fix: when the `readFile` IPC
serves a file, record its canonical real path in a bounded grant set; allow a write
when EITHER `validateWrite` passes against roots OR the exact canonical target is a
recorded grant.

- New pure module `src/read-grants.ts`: `createGrantStore({ canonical, cap })` with
  `add(path)`, `has(path)`, `size`. Canonicalization is injected (default:
  `path.resolve` + `fs.realpathSync.native`, lowercased on win32 — mirroring
  `path-guard.ts` norms) so tests can supply a deterministic canonicalizer. Bounded
  by a simple insertion-order cap (default 500) with oldest-eviction (LRU-lite:
  re-adding an existing key refreshes its recency). App-lifetime retention is fine —
  the set only ever holds files the user actually opened this session, and 500 ×
  a path string is negligible memory.
- `electron/main.ts`: a module-level grant store. The `readFile` case records the
  served file's canonical path **after** a successful, non-error read (don't grant a
  path that failed to read). The `writeFile` IPC passes the grant store to an
  extended validation.
- `src/file-service.ts` `writeFile` gains an optional `grants` param. The validation
  becomes: run `validateWrite` against roots; if it passes, proceed as today. If it
  rejects, check whether the canonical target is a grant — if so, proceed with the
  same directory-reject + atomic temp+rename write. If neither, return the original
  rejection.

## Security analysis of the grant model

**Invariant: a grant is an EXACT FILE that the host itself chose to serve via
`readFile`, never a directory, never a renderer-supplied path without a prior
read.**

Threat: a malicious/buggy renderer asks to write an arbitrary path.

- Without grants, `validateWrite` confines writes to open roots. We do NOT weaken
  `validateWrite` — it still runs first and still governs the common case.
- The grant set only ever gains entries via the host's own `readFile` handler,
  keyed on the **canonical real path** of a file that read successfully. The
  renderer cannot inject a grant: it can only ask to read a path, and a read that
  the host performs is itself an information-disclosure the host already permits
  (the file explorer / go-to-definition surface those paths). A write-grant for a
  file you could already read and edit in-app is not a new capability — it's the
  capability the editable editor is *supposed* to have.
- Directories are never granted: `readFile` only serves files (a dir read returns
  an error DTO and we grant only on success), and the write path still rejects a
  directory target via `fs.statSync(...).isDirectory()` even on the grant branch.
- Canonical-collision: the grant key is the symlink-resolved, case-folded (win32)
  real path, computed identically on read and on write, so a symlink can't be used
  to make a write target *look like* a granted file while resolving elsewhere — the
  comparison is on real paths, post-realpath, on both sides.
- Cap eviction can only *remove* grants (fail-closed: an evicted file's write falls
  back to the root check), never *add* a capability.
- TOCTOU: between read and write a path could be swapped (e.g. the file replaced
  with a symlink to `/etc/passwd`). The write re-canonicalizes the **current** real
  path at write time and compares THAT to the grant set. If the on-disk path now
  resolves somewhere else, its new canonical path won't be in the grant set, so the
  grant branch fails and it falls back to the root check. The atomic temp+rename
  write also targets the resolved real path. Net: a swap can at worst cause a
  legitimate-looking write to be rejected (fail-closed), not redirected outside a
  granted file.

Net new capability: writes to exactly those files the user opened this session that
happen to live outside an open root (go-to-definition targets, out-of-root recents).
That is precisely the set the bug is about, and nothing more.

## Edge cases

- Save with focus in the terminal / sidebar / filter input → global `Mod+S` routes
  to the active doc's save. (Was a no-op.)
- `Mod+S` with the active tab being the Terminal (no doc) or a clean doc → no-op,
  no toast.
- `Mod+S` while a save is already in flight → the `saving` latch drops it.
- Browser preview (`window.agentDeck` absent): `canSave` is false; save sets the
  in-editor "unavailable in preview" message and (new) pushes an info/error toast so
  the affordance is observably wired. The disk round-trip is host-only.
- Out-of-root file write: now allowed when it was read by the host; the toast still
  fires only if the host rejects (e.g. file deleted, permission denied).
- Grant store cap reached: oldest grant evicted; a write to the evicted file falls
  back to the root check (and may then legitimately reject with a clear toast).

## Acceptance

- Global `Mod+S` from outside the editor triggers the active doc's save.
- Dirty tabs show a click-to-save affordance with the Ctrl+S tooltip.
- A rejected/failed save raises a bottom-right toast with the reason; a successful
  save raises no toast and clears the dirty dot.
- A file opened by the host (read) but living outside every root saves successfully.
- `npm run verify` and `npm run build` exit 0; new unit tests cover registry
  routing, grant add/has/evict/canonical-collision, and toast push/dismiss.
