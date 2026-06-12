# Session-Meta Implementation Plan

> **For agentic workers:** implement task-by-task, test-first. Steps use checkbox
> (`- [ ]`) syntax. NOTE: this runs inside an autonomous build-loop — the conductor
> owns git; do NOT commit. Verify with `npm run verify` + `npm run build` at the end.

**Goal:** Lead session names with the repo/folder, and add a `lastActiveAt`
timestamp surfaced on the tab and usable as a sort key.

**Architecture:** The host's `SessionManager` (pure model) is the source of truth.
Add `lastActiveAt` to the `Session` type, stamp it on create + a new `touch()`,
inject `now` for tests, and tolerate old persisted sessions on restore. The host
calls `touch()` on `term:start`/`term:input`. The renderer adds an `'active'` sort
key and an `'active'` card field that reuses the shared `relativeTime()` helper.

**Tech Stack:** TypeScript, Electron host, React webview, Vitest, Biome.

---

### Task 1: Model — add `lastActiveAt` to the Session type

**Files:**
- Modify: `src/types.ts` (Session interface)

- [ ] **Step 1:** Add `lastActiveAt: number; // epoch ms, bumped on activity` after
  `createdAt` in `interface Session`.

### Task 2: SessionManager — repo-first name, inject `now`, stamp + `touch`

**Files:**
- Modify: `src/session-manager.ts`
- Test: `test/unit/session-manager.test.ts`

- [ ] **Step 1 (test first):** In the test file, update the existing
  "derived name" expectation to `'proj — Claude'` (repo-first). Add tests:
  - injected `now` → `createdAt === lastActiveAt === <now>`
  - `touch(id)` bumps `lastActiveAt` only, with a later injected now; unknown id is a
    no-op (list/emit unchanged)
  - `restore` of a session missing `lastActiveAt` backfills it to `createdAt`
  - explicit name preserved (`create(..., 'X')` → `'X'`)

  Inject `now` by constructing `new SessionManager(registry, seqIds(), () => clock)`
  where `clock` is mutated between calls.

- [ ] **Step 2 (run, expect fail):** `npm test -- session-manager`

- [ ] **Step 3 (implement):**
  - Constructor: add `private readonly now: () => number = () => Date.now()`.
  - `create`: default name `` `${basename(projectPath)} — ${def.label}` ``; set
    `createdAt: this.now()` and `lastActiveAt: this.now()`.
  - Add `touch(id: string)`: if session exists, `s.lastActiveAt = this.now(); this.emit();`
  - `restore`: map each session to `{ ...s, status: 'stale', createdAt, lastActiveAt }`
    where `createdAt = s.createdAt ?? this.now()` and
    `lastActiveAt = s.lastActiveAt ?? createdAt`.

- [ ] **Step 4 (run, expect pass):** `npm test -- session-manager`

### Task 3: Persistence — back-compat restore default

**Files:**
- Modify: `src/persistence.ts`
- Test: `test/unit/persistence.test.ts`

- [ ] **Step 1 (test):** add a case: a serialized session with `createdAt` but no
  `lastActiveAt` restores with `lastActiveAt === createdAt`.
- [ ] **Step 2 (implement):** in `restoreSessions` map, default
  `createdAt = s.createdAt ?? Date.now()` and `lastActiveAt = s.lastActiveAt ?? createdAt`.
  (SessionManager.restore also defaults, so this is belt-and-suspenders for any direct caller.)
- [ ] **Step 3 (run):** `npm test -- persistence`

### Task 4: Host — bump activity on terminal start/input

**Files:**
- Modify: `electron/main.ts` (handle `term:start`, `term:input`)

- [ ] **Step 1:** In `handle`, in the `term:start` and `term:input` cases, after the
  `pty.*` call, add `mgr.touch(m.sessionId);`.

### Task 5: Settings — new sort key + card field

**Files:**
- Modify: `src/settings.ts`
- Test: `test/unit/settings.test.ts` (only if it enumerates allowed values)

- [ ] **Step 1:** Add `'active'` to `SessionSort` union, to `SESSION_SORTS`.
- [ ] **Step 2:** Add `'active'` to `CardField` union and `CARD_FIELDS`.
- [ ] **Step 3 (run):** `npm test -- settings`

### Task 6: Card field — render last-active (reuse relativeTime)

**Files:**
- Modify: `webview/card-fields.ts`

- [ ] **Step 1:** Add `{ id: 'active', label: 'Last active' }` to `CARD_FIELD_LABELS`
  (after the `time` entry).
- [ ] **Step 2:** In `fieldValue`, add `case 'active':` →
  `return typeof session.lastActiveAt === 'number' ? relativeTime(session.lastActiveAt) : '';`

### Task 7: Sidebar — sort by recently active

**Files:**
- Modify: `webview/components/sidebar.tsx`

- [ ] **Step 1:** Add `{ id: 'active', label: 'Recently active' }` to `SORT_LABELS`
  (after `recent`).
- [ ] **Step 2:** In `sortSessions`, add
  `case 'active': arr.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || a.name.localeCompare(b.name)); break;`

### Task 8: Mock — give preview sessions a lastActiveAt

**Files:**
- Modify: `webview/mock.ts`

- [ ] **Step 1:** Add `lastActiveAt: ago(N)` to each mock session (e.g. portfolio
  `ago(660)`, tests `ago(2)`, terminal-ui `ago(4)`, job-hunt `ago(960)`) so the
  preview renders varied relative times and a meaningful "recently active" sort.

### Task 9: Verify

- [ ] **Step 1:** `npm run verify` (format-check + lint + typecheck + tests + security) — green.
- [ ] **Step 2:** `npm run build` — succeeds.
- [ ] **Step 3:** Runtime proof via Playwright preview (sessions panel shows repo-first
  name + last-active; switch sort to "Recently active").

## Self-review

- Spec coverage: naming (T2), createdAt/lastActiveAt + touch (T1/T2), back-compat
  (T2/T3), host activity (T4), sort key (T5/T7), tab surface (T5/T6), preview (T8). All covered.
- Type consistency: `lastActiveAt` used identically across types/manager/persistence/UI.
- No placeholders.
