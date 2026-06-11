# Host-hardening (K5)

Three correctness fixes to `electron/main.ts` and supporting modules, audited in batch K5.

---

## Fix 1 — term:start kill-race → orphan pty

**Problem:** `term:start` called `pty.start()` unconditionally. A `kill` message
(which calls `pty.dispose(id)` + `mgr.remove(id)`) racing a late `term:start` from
a remounting `TerminalPane` would spawn a real pty process for a session the
SessionManager had already removed. That process is never stored under a live
session id and therefore can only be cleaned up at app quit.

**Fix:** In the `term:start` branch, bail early if `mgr.get(m.sessionId)` returns
`undefined`. The guard is a single null-check before the `pty.start` call; the logic
is extracted as a condition on `mgr.get()`, which is pure and testable.

**Test surface:** The decision `"should bail when session not in manager"` is
exercised through a lightweight fake SessionManager in
`test/unit/term-start-guard.test.ts`.

---

## Fix 2 — Swallowed persistence-write errors

**Problem:** Three `fs.writeFile(..., () => {})` call sites in `electron/main.ts`
(sessions.json, repos.json, settings.json) silently discarded all write errors —
disk-full and permission errors produced no log output.

**Fix:** A small `persistFile(path, data, label)` helper replaces all three sites.
It calls `fs.writeFile` with a callback that logs `console.error` when `err` is
non-null, including the label for triage. What is written and when are unchanged.

**Note:** The `.conduit/` writes in `electron/conduit-fs.ts` already reject
properly and are untouched.

---

## Fix 3 — updateSettings persists renderer payload verbatim

**Problem:** `case 'updateSettings'` assigned `m.settings` to `settings` and
persisted it without any validation. A renderer bug or a crafted message could
persist unknown keys, wrong-typed values, or out-of-range numbers to `settings.json`.

**Fix:** A new `coerceSettings(payload: Record<string, unknown>): AppSettings` pure
function in `src/settings.ts`. It applies exactly the same field-by-field validation
rules as `restoreSettings` (same helpers: `str`, `bool`, `oneOf`, `clampNum`,
`clampWidth`, `hexColor`, `strMap`) but accepts a raw object rather than a JSON
blob. `restoreSettings` is refactored to delegate to `coerceSettings` after parsing.

The legacy `codeBg → surfaceColor` migration (`surfaceColorFrom`) is preserved:
`coerceSettings` calls `surfaceColorFrom` on the raw payload, so legacy persisted
payloads still migrate correctly.

The `updateSettings` IPC handler now coerces via `coerceSettings` before assigning
`settings` and before persisting, closing the injection vector.

**Test surface:** `test/unit/coerce-settings.test.ts` — thorough coverage of:
unknown keys dropped, wrong-typed values replaced by defaults, numeric range clamps,
enum whitelisting, valid pass-through, and legacy `codeBg` migration.
