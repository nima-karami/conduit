---
status: implemented
date: 2026-06-22
tier: LITE
---

# Feature Spec: Hide deleted folders from recent folders

**Tier:** LITE   **Feature type:** non-UI (data filter; no new UI)
**One-line request:** "If a folder has been deleted, then it shouldn't show up in the recent folders (sessions) anymore."

## 1. Problem frame

- **Job:** When I reopen the New Session modal, don't show me folders that no longer
  exist on disk — clicking them would just fail.
- **Actors:** A user opening the New Session modal to reopen a recent project folder.
- **Success outcome (observable):** A recent folder whose path was deleted/renamed no
  longer appears in the recent-folders list; valid folders remain, sorted as today.
- **Non-goals:** Pruning **sessions** (`sessions.json`) — those are a separate concept
  (a session has its own restore/stale lifecycle). This is only the recent-folders
  list (`repos.json`, `RepoDTO`). Not a UI redesign; the list rendering is unchanged.

## 2. Behavior & states

`reposForState()` (`electron/main.ts:764–771`) currently sorts `repos` by `lastOpened`
and appends Home, then broadcasts them in the `state` message. New behavior: it
**filters out entries whose path does not currently exist on disk** before sorting.

Per the decided default (**hide, keep entry**): missing folders are excluded from the
broadcast list but **left in `repos.json`** — so a folder on an unplugged/remounted
drive, or one later recreated, reappears automatically.

| State of a recent-folder entry | Behavior |
|---|---|
| Path exists & is a directory | Shown (sorted by `lastOpened`, as today) |
| Path missing / not a directory | Hidden from the list; entry retained in `repos.json` |
| Home dir missing (pathological) | Home is still appended as today (it is the launcher fallback) |

## 3. Data / interface contract

- **Input:** the in-memory `repos: RepoDTO[]` (`{ path, name, lastAgentId?, lastOpened }`).
- **Filter:** `fs.existsSync(path) && fs.statSync(path).isDirectory()` — the same
  existence-check idiom already used at `electron/main.ts:630` and
  `src/project-info.ts:281`.
- **Output:** the existing `state.repos` array, minus missing entries. No protocol or
  `RepoDTO` shape change; the renderer (`new-session-modal.tsx`) needs no change.
- **Invariant:** `repos.json` on disk is **not** rewritten by this filter (non-
  destructive); persisted entries are only ever pruned by the existing cap
  (`repo-history.ts`, 20 entries).

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Path on a temporarily-unavailable drive | Hidden now, reappears when the drive is back (because the entry is kept). |
| Path is a file, not a dir (replaced) | Hidden (`isDirectory()` false). |
| `statSync` throws (permission/IO) | Treated as "does not exist" → hidden; never crash the broadcast. |
| Many entries → repeated `statSync` per broadcast | Acceptable: list is capped at 20; `statSync` on ≤20 local paths is cheap. If a path is a slow network mount, the cost is bounded by the cap. (If it ever matters, cache per broadcast — out of scope.) |
| The currently-open folder gets deleted mid-session | Out of scope here; this only governs the recent-folders *list*. The live session keeps its own behavior. |
| All recent folders missing | List shows only Home (unchanged fallback). |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Missing-entry handling | Hide, keep in `repos.json` | No | Non-destructive; survives unplugged drives / recreated folders. (User-confirmed.) |
| Where to filter | At broadcast (`reposForState`) | No | Real-time, doesn't mutate persisted state, single choke point feeding every window. |
| Check | `existsSync` + `isDirectory` | No | Matches existing idioms; cheap at the 20-entry cap. |

## 6. Scope slicing

- **MVP:** Filter missing paths in `reposForState()` so deleted folders never render.
- **v1:** (optional) re-evaluate on window focus so a folder deleted while the modal
  is open drops on next state push — already covered if `reposForState` runs on the
  broadcasts that occur around focus/open; no extra work expected.
- **Out of scope:** Pruning `repos.json` on disk; pruning sessions; "recently
  deleted, click to restore" affordance.

## 7. Acceptance criteria

- A recent folder whose directory is deleted does not appear in the New Session
  recent-folders list.
- That entry remains in `repos.json`; if the directory is recreated, it appears again
  without the user re-adding it.
- Valid folders still appear and are sorted by `lastOpened` as before; Home still
  appears.
- A `statSync` error on an entry hides that entry and does not break the rest of the
  list or the `state` broadcast.

**EARS:**
- *Event-driven:* When the host builds the recent-folders list for a `state`
  broadcast, the system shall exclude every entry whose path is not an existing
  directory.
- *Unwanted:* If checking an entry's path throws, then the system shall treat that
  entry as missing and continue building the list.
- *Ubiquitous:* The system shall not remove missing entries from `repos.json` as a
  result of this filter.

## 12. Assumptions

- "Recent folders (sessions)" in the request refers to the `repos.json` recent-folder
  list shown in the New Session modal, not `sessions.json` sessions — these are
  distinct (confirmed in code). Pruning is applied to recent folders only.
- The 20-entry cap keeps per-broadcast `statSync` cost negligible; no caching needed.
- A non-UI feature: no a11y/i18n/design-token sections — the rendered list and its
  strings are unchanged; only its contents shrink.

## 14. Open questions

- None blocking.
