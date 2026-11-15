# Request queue UI (CON-20) — implementation plan

**Spec:** `docs/specs/archive/2026-11-14-user-input-requests.md` v4.5 §4.4, §4.5, §11  **Tier:** FULL
**Design (approved, final):** `docs/design-handoff/2026-11-14-shaping/CON-10/` on branch `shaping-2026-11-14`
(README, `iter-7/` screens and `critique.md` incl. "cut the repetition", iter-6's empty / caught-up / session
pill / waiting notice, `../shared-frame.md`). Read it from `/home/namemenima/projects/.wt/conduit/shaping/…`;
the PNGs are never copied into the repo.
**Builds on:** CON-21 machinery (`docs/plans/2026-11-14-request-queue-machinery.plan.md`), merged on this branch.

## Goal
Render the request queue the machinery broadcasts (`McpUiState.requests`) and let the human answer it:
- the Needs you panel;
- one Header · Context · Answer · Footer template, used by the pop-up and the request tab;
- the session pill and the waiting notice;
- a thread link;
- the status-bar count with the shortest live countdown.

No server or contract changes are planned. If one turns out to be needed, that task stops and reports.

## Architecture
The renderer has no request state of its own beyond view state.
- **Data:** everything comes from `useConduitMcp().state.requests`, so the list, pop-up, tab, pill and notice all show the same object (spec §4.4).
- **Answering:** goes through a new `api.answerRequest`, a request/reply over `mcp:requestAnswer` → `mcp:requestResult` using the existing `requestHost` helper.
- **View model:** one pure module, `webview/request-view-model.ts`, owns everything that has a rule: type, why-now, open-as (the size rule), sort, filters, the waiting-never-filtered rule, countdowns, and the accessible names. Components only render it.
- **Draft memory:** `webview/request-drafts.ts`, a module-singleton store, keeps each request's pick and typed text, so Esc, Next, Open as tab and the tab→pop-up round trip never lose input.
- **Navigation:** the pop-up and the tab share one `RequestTemplate` component. The pop-up is a non-modal dialog over the centre pane with its own focus trap. The tab is a new `DocKind 'request'`, following the `@review` / `@git-history` pseudo-doc pattern.

## Data flow
```
server host ── mcp:state {requests:{open,ended,presence}} ──> use-conduit-mcp (singleton)
        ^                                                          │
        │ mcp:requestAnswer / mcp:requestResult (requestHost)      v
   api.answerRequest(id, answer)   <──────  RequestTemplate ──> request-view-model (pure)
                                              ▲     ▲                 │
                                  request-popup  request-tab          ├─> NeedsYouPane (list, ⋯ menu)
                                       ▲             ▲                ├─> status bar count + countdown
                         open(id) from: row Enter/click, pill,        ├─> session pill (doc-tabs right slot)
                         waiting notice, thread link, shortcut        └─> waiting notice (status-bar area)
                         request-drafts (pick + text per request id, renderer memory)
```

## Settled decisions — do not re-litigate
Everything in spec §4.4 and §11, the iter-7 README (type icons, ⛨ Conduit chip, two-line cards, ⋯ sort/filter/show, the size rule, one template, keyboard model, wording) and the critique's "cut the repetition".

The lead's rulings:
- Filters cover session, **lead group**, **space**, type and machine. iter-7 draws only session, type and machine; the two extra sections use the same menu style.
- A waiting call is never filtered out.
- The existing approval card keeps working. A `permission` request doesn't exist yet: no conversion until CON-18.
- Thread card → link.
- Runtime proof: headless e2e, plus screenshots compared by eye against the iter-7 PNGs.

## Spec staleness
- **§11 tokens `attention`, `urgent`, `surface-raised` don't exist** (`webview/styles.css:5-94`). Use the existing `--amber` (the attention slot), `--danger`/`--red` (urgent) and `--raise`. The new `agent-content` quote frame is local to the new CSS, built from `--border-2` and `--panel-2`.
- **REQ-D13 Ctrl+Shift+A collides** with `openArchitecture`, which is `Mod+Shift+A` (`webview/shortcuts.ts:48-52`). See Decisions Needed #1.
- **The shared frame's "session strip" (§3) doesn't exist in v0.64** (no per-session header; `center-pane.tsx:388-407` is the split-terminal bar only). See Decisions Needed #2.
- **`permission`, `form`, remote (studio-pc) and lead-answered rows can't occur yet.** The machinery raises none of them. Their template branches are not built (no code without a caller); screens 17, 18 and 13 are out.
- **iter-7/19 shows CON-15's options** ("Try again at reset · Continue now"). The machinery's ruled options are "Resume now · Turn auto-resume on" (CON-21 Decisions #2), and the UI shows whatever `options` the request carries.

## Global constraints
- Gate: `npm run verify`, exit code captured directly. Inner loop `npm run verify:quick`.
- Run `npm run text-fit` after any CSS change (the Monaco/width guard).
- Component tests: `test/unit/<name>.test.tsx` with `// @vitest-environment jsdom`, using `react-dom/client` + `act`. No testing-library. Template: `test/unit/approval-card.test.tsx:1-50`.
- CSS goes in `webview/styles.css` only, under the prefix `.needs-` (panel, cards, menu, pill, notice) and `.reqtpl-` (template, pop-up, tab):
  - no bare generic class names (`test/unit/monaco-class-collision.test.ts`);
  - no `!important`;
  - floating chrome uses the layer tokens (`--layer-popover` and up);
  - anything over `.topbar` gets `-webkit-app-region: no-drag` (`test/unit/drag-region.test.ts`).
- **Words (owner, 2026-11-14; `/home/namemenima/projects/conduit/docs/UX.md` §8 on local main):** Space (never project); Session (an agent CLI is one kind); helper session and its lead; Request, the list is Needs you; the types Approve · Answer · Review; left/right **pane** holding a **panel** named by its content (the "Needs you panel"). New strings use these words; existing strings aren't renamed in this card. Not following the OS light/dark setting.
- Strings go in a new `webview/request-strings.ts` (pattern: `webview/conduit-mcp-strings.ts`), plural-aware. Agent text renders with `dir="auto"` inside the quote frame, never in Conduit's header slots (anti-spoofing, spec §4.1).
- React:
  - native `{passive:false}` listeners if a wheel handler needs preventDefault;
  - zoom/fit in `useLayoutEffect`;
  - virtualized rows are direct keyed children. Not needed: the open list is capped at 50 by the server, so it isn't virtualized.
- No focus is ever taken on arrival. The pop-up opens only from a human click or key (spec EARS).
- Comments explain WHY. No `as any`, `@ts-ignore` or swallowed errors.
- **Apps tested on this machine stay hidden** (headless e2e harness only).
- Commits: git identity from `git log main -1`; end each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Out of scope
- Permission requests in the template (CON-18). The approval card stays.
- `form`, remote rows, lead escalation, and the "Handled by leads" view.
- The sidebar "Needs you" grouping change and the "asks" row markers: a follow-up card (lead). Today's sidebar Needs you behaviour stays exactly as it is; the status bar is the one place the count lives.
- Notification quick actions. Persisting unsent tab edits across a reload (spec "ASSUMED feasible").

## Contracts

### UC1 `webview/request-view-model.ts` (pure, Node-free)
```ts
export type RequestType = 'approve' | 'answer' | 'review';
export type OpenAs = 'popup' | 'tab' | 'terminal';
export type SortKey = 'soonest' | 'newest' | 'oldest' | 'session';
export interface RequestFilters { sessions: string[]; leads: string[]; spaces: string[]; types: RequestType[]; machines: string[] } // [] = all
export interface ShowOnCards { space: boolean; age: boolean; machine: boolean }
export interface CardView {
  id: string; type: RequestType; conduit: boolean; openAs: OpenAs; tabLines: number | null;
  sessionId: string | null; sessionName: string; handle: string; ask: string;
  whyNow: { kind: 'waiting'; secondsLeft: number } | { kind: 'urgent' } | { kind: 'expires'; at: string } | { kind: 'tab'; lines: number } | { kind: 'terminal' } | { kind: 'age'; label: string };
  details: { space: string | null; age: string; machine: string };
  ariaName: string;               // "{type}, {session}, {agent}: {ask}, {why-now}"
}
export function typeOf(r: RequestView): RequestType;       // confirm → approve; choose/text/scheduler/message → answer; review → review; attend → approve|answer by r.blocked (permission → approve, else answer)
export function isConduit(r: RequestView): boolean;        // requester === 'conduit' || source in {observed, scheduler}
export function openAsOf(r: RequestView): OpenAs;          // spec §4.4 size rule: review → tab; attend → terminal; else popup iff body ≤ 600 chars and ≤ 8 lines and ≤ 4 options and every option description ≤ 100 chars
export function sortRequests(rs: RequestView[], key: SortKey): RequestView[]; // soonest: waiting first, then urgent, then nearest expiresAt, then oldest createdAt
export function applyFilters(rs: RequestView[], f: RequestFilters): { shown: RequestView[]; hiddenCount: number }; // a waiting request always survives
export function cardsOf(rs: RequestView[], ctx: { now: number; sessions: Map<string, { name: string; space: string | null }>; show: ShowOnCards }): CardView[];
export function shortestWaiting(rs: RequestView[], now: number): { sessionId: string | null; secondsLeft: number } | null;
export function filterOptions(rs: RequestView[], ctx: { sessions: Map<string, { name: string }> }): { sessions: Array<{ id: string; label: string }>; leads: …; spaces: …; types: RequestType[]; machines: string[] };
```
`RequestView.waitingUntil: string | null` (server addition, lead ruling 5) is the latest deadline of the calls waiting on it. Countdowns read it.

### UC2 `webview/request-drafts.ts`
`getDraft(id): { pick: string[]; text: string } | undefined`, `setDraft(id, d)`, `clearDraft(id)`, `useDraft(id)` (useSyncExternalStore). Renderer memory only.

### UC3 `webview/use-conduit-mcp.ts` (modify)
`ConduitMcpApi` gains:
- `answerRequest(requestId: string, answer: AnswerInput): Promise<RequestAnswerResult>`, via `requestHost(… ['mcp:requestResult'] …)`;
- `setAway(away: boolean, until: string | null): void`, which is `post` only (U5).

### UC4 Opening a request (one entry point)
`openRequest(id: string, opts?: { asTab?: boolean })` in a new `webview/request-open.ts`. It reads the request and calls `openAsOf`:
- **popup** → `requestPopupStore.open(id)`;
- **tab** → dispatches a doc open `{kind:'request', path:'@request/' + id, sessionId: r.session}`;
- **terminal** → `goToTerminal(r.session)` and focuses the CLI.

Every surface calls this: row, pill, notice, thread link and shortcut.

### UC5 `DocKind 'request'` (`webview/docs.ts`)
- Path `@request/<id>`; title from the strings ("Answer: …", "Review: …").
- Not persisted: filtered out like review.
- Not previewable.
- `splitBehavior` = 'move'.

### UC6 Attention entries (`src/attention.ts`)
- `AttentionEntry.kind` gains `'request'`.
- `needYouEntries` keeps waiting asks first (a call is blocked on each), then open requests (soonest-needed order), and drops session entries already covered by an open request. Corrected during the build: `status-bar.e2e` showed requests ahead of a waiting ask. This mirrors the tray rule merged in CON-21 T5.2.
- `routeAttention` (`src/attention-route.ts:27`) routes `'request'` to `openRequest`.

## Producer/consumer map
| Behavior | Produced by | Consumed by | Sides |
|---|---|---|---|
| request list | server `McpUiState.requests` (exists) | use-conduit-mcp → view model → panel, pill, notice, status bar | consumer only; producer measured by CON-21 e2e |
| answer | `api.answerRequest` | server `mcp:requestAnswer` (exists) → `mcp:requestResult` | consumer + an existing producer |
| status-bar count | `needYouEntries` (changed) | status bar, Ctrl-shortcut target, footer chip click | both |
| request tab | doc open action (new kind) | center-pane branch, doc-tabs, persistence filter | both |

## File map
| Path | Action | Responsibility |
|---|---|---|
| `webview/request-view-model.ts` | create | UC1 rules |
| `webview/request-strings.ts` | create | every user-visible string, plural-aware |
| `webview/request-drafts.ts` | create | UC2 |
| `webview/request-open.ts` | create | UC4, plus the pop-up store (`requestPopupStore`) |
| `webview/components/request-type-icon.tsx` | create | the 3 type icons (square ✓, bubble ?, page) + shield badge, SVG, `aria-label` = type word |
| `webview/components/needs-you-pane.tsx` | create | the panel: Open/History toggle, filter bar, card list (listbox), empty / caught-up / filtered-empty states, legend |
| `webview/components/needs-you-menu.tsx` | create | ⋯ menu: Sort / Filter (submenus incl. Lead group, Space) / Show on cards / What the icons mean |
| `webview/components/request-template.tsx` | create | Header · Context · Answer · Footer; options (radio/checkbox), own-words field, Send, receipt, ended banner, 400 ms guard |
| `webview/components/request-popup.tsx` | create | non-modal dialog over the centre pane, focus trap, keys, Next/wrap, below-1200 placement |
| `webview/components/request-tab.tsx` | create | tab layout: Context left (review: Edited / Original / Changes over the draft), Answer column right |
| `webview/components/session-pill.tsx` | create | "◉ Waiting on you · 1 request" / "N requests" (menu) |
| `webview/components/waiting-notice.tsx` | create | one line, `region` "Waiting for your answer", not focusable, opens the pop-up |
| `webview/use-conduit-mcp.ts` | modify | UC3 |
| `webview/docs.ts`, `webview/doc-groups.ts` | modify | UC5 |
| `webview/components/center-pane.tsx` | modify | `request` doc branch; mount `RequestPopup` |
| `webview/components/doc-tabs.tsx` | modify | right slot for `SessionPill` (Decisions #2) |
| `src/settings.ts` (`RightPaneTab`, `RIGHT_PANE_TABS`), `webview/chrome-strings.ts`, `webview/components/top-bar.tsx` (VIEWS, first), `webview/components/right-pane.tsx`, `src/right-panel-toggle.ts`, `webview/components/review-view.tsx:419` | modify | register the **Needs you panel** (existing code type `RightPaneTab` gains `'needs'`; the "Needs you N" toggle comes first in the group) |
| `src/attention.ts`, `src/attention-route.ts`, `src/status-bar-model.ts`, `webview/components/status-bar.tsx`, `webview/app.tsx` | modify | UC6 + "· 1 waiting" item; wire `openRequest`, the notice and the popup store |
| `webview/components/message-thread.tsx` | modify | one-line "Open request" link on a thread that has an open request (`r.thread`) |
| `webview/shortcuts.ts` | modify | `openSoonestRequest` (Decisions #1) |
| `webview/styles.css` | modify | `.needs-*`, `.reqtpl-*` |
| `test/e2e/harness.mjs` | modify | `showRightView` JSDoc gains `'needs'` |
| `test/unit/request-view-model.test.ts`, `request-drafts.test.ts`, `needs-you-pane.test.tsx`, `needs-you-menu.test.tsx`, `request-template.test.tsx`, `request-popup.test.tsx`, `request-tab.test.tsx`, `session-pill.test.tsx`, `waiting-notice.test.tsx` | create | per-component tests |
| `test/e2e/requests-ui.e2e.mjs` | create | the real app, headless: a fake agent asks; the panel shows it; open, answer, Next; a review opens as a tab; an attend row opens the terminal |
| `test/e2e/visual/shoot.mjs` | modify | scenes `needs-list`, `needs-menu`, `needs-filtered`, `reqtpl-popup`, `reqtpl-review-tab`, `session-pill`, `waiting-notice`, for comparison by eye with iter-7 01, 03, 05, 12, 21 and iter-6 13, 14 |
| `CHANGELOG.md` | modify | the Needs you panel and answering |

## Slices

### Slice U1: Rules and data (pure)
**Check:** `npx vitest run test/unit/request-view-model.test.ts test/unit/request-drafts.test.ts`; `npm run verify`.
**Parallel groups:** G1: view model + strings · G2: drafts + open store + `use-conduit-mcp` UC3 · G3: type icons
**Key tests:** the size rule at each boundary (600/601 chars, 8/9 lines, 4/5 options, 100/101-char description); review is always a tab; attend → terminal; soonest order (waiting > urgent > nearest expiry > oldest); a waiting request survives every filter and `hiddenCount` counts the rest; lead-group and space filters; accessible-name format; drafts survive close/reopen.

### Slice U2: Needs you panel (in the right pane)
**Check:** component tests; `npm run verify`; `npm run text-fit`.
**Parallel groups:** G1: needs-you-pane · G2: needs-you-menu · Serial: Needs you panel registration (claims: settings.ts, chrome-strings.ts, top-bar.tsx, right-pane.tsx, right-panel-toggle.ts, review-view.tsx, styles.css)
**Key tests:**
- listbox with `aria-activedescendant`;
- ↑/↓/J/K move, Enter calls `openRequest`, O opens the terminal, H shows History;
- the filter bar reads "Filtered: … · 2 of 9 shown · Clear";
- empty, caught-up and filtered-empty copy;
- counts ignore filters;
- the menu: ↑/↓, → submenus, Space toggles, Esc back to ⋯;
- filters reset on remount; sort and Show persist in a renderer setting.

### Slice U3: Template, pop-up, tab
**Check:** component tests; `npm run verify`; `npm run text-fit`.
**Parallel groups:** G1: request-template · Serial: request-popup + request-tab + DocKind wiring (claims: docs.ts, doc-groups.ts, center-pane.tsx, styles.css)
**Key tests:**
- **Header** is Conduit's sentence ("codex-4 asks you to choose"), with agent text only in Context.
- **Options:** 1–8 pick; the 400 ms guard holds after the shown request changes; Enter on a picked option or Ctrl+Enter sends.
- **Send** is plain "Send". It calls `answerRequest` with the right `AnswerInput` per type: confirm Yes → approved, No → declined, text only → answered; choose → chosen with values and text; review → approved, edited (the edited draft) or declined.
- **Skip** → dismissed.
- **Receipt:** after Send, a one-line receipt shows, then the next request loads.
- **Next:** wraps to the first request; a request that starts waiting while the pop-up is open comes next.
- **Esc** keeps the draft and returns focus to the row.
- **Focus** starts on the title and is trapped.
- **Ended banner:** "Withdrawn by claude-3", "Already answered", "Expired". Send is disabled and the text stays copyable.
- **Open as tab** carries the pick and the note.
- **Review tab:** Edited / Original / Changes, a line count, and Send blocked over 32 KB.

### Slice U0: `waitingUntil` (server, orchestrator)
**Check:** `npx vitest run test/unit/request-waits.test.ts test/unit/request-service.test.ts`; `npm run verify`.
`RequestWaits.waitingUntil(requestId): number | null` is the latest live deadline. `RequestView.waitingUntil` is that value as ISO, or null. The service's `view()` sets it.

### Slice U4: Signals and entry points
**Check:** component tests; `npm run verify`; e2e `requests-ui` (remote) and visual scenes.
**Parallel groups:** G1: session-pill + waiting-notice · G2: thread link · Serial: attention/status bar/app wiring + shortcut + doc-tabs slot (claims: attention.ts, attention-route.ts, status-bar-model.ts, status-bar.tsx, app.tsx, doc-tabs.tsx, shortcuts.ts, message-thread.tsx, styles.css)
**Key tests:**
- the status bar reads "N need you" plus "· 1 waiting" while a call waits;
- the pill shows only on the requester's own tab strip;
- the notice shows only while the requester isn't on screen, and never takes focus;
- the shortcut opens the soonest waiting request, else the panel with the list focused;
- the thread link opens the request.
**Runtime proof:** e2e `requests-ui` drives the real app headless, and `test/e2e/visual/shoot.mjs` produces the scenes for comparison by eye. Screenshot paths go in the run report.

### Slice U5: Away and the return digest (lead ruling 3)
**Check:** component tests; `npm run verify`; the e2e step and a `needs-digest` visual scene.
**Files:**
- Create `webview/components/away-menu.tsx`, opened from the status bar's Needs you item: For 1 hour · Until 09:00 tomorrow · Until I'm back · I'm back.
- Create `webview/components/needs-you-digest.tsx`, at the top of the Needs you panel when `presence.lastAway` is newer than the last dismissal.
- Create `webview/away-view-model.ts`, holding the until-time choices and the digest counts.
- Modify `status-bar.tsx`: "Away until 09:00", then "Away ended 09:12".
- Modify `needs-you-pane.tsx`: show the away banner while away (iter-5/14, adapted to iter-7 card style).
**Digest:** "While you were away", with the from–to time and the duration. It counts:
- N still need you (open);
- N went with the agent's default (answered by default within the window);
- N expired;
- N cleared by themselves (resolved).

Each count has "show", which filters the panel's History to that set. A row that went with a default gets "Follow up…", which opens Messages with a reply to the requester in the request's thread. That uses the existing compose, and it can't undo anything; the copy says so. "Dismiss" hides the digest until the next Away ends (renderer setting).
**Key tests:**
- the counts come only from requests ended within `[lastAway.from, lastAway.to]`;
- the Away until-time choices compute correctly across midnight;
- I'm back sends `setAway(false)`;
- the digest hides after Dismiss and shows again after a new Away.

## Verification
- Per task: its component tests, red first.
- Per merge: review by me, then `npm run verify; echo exit=$?` and `npm run text-fit`.
- Per slice: e2e by exact name remotely, `--affected` at the end, and the visual scenes shot headless and compared side by side with the iter-7 PNGs (paths in `docs/runs/2026-11-14-CON-21/ui-report.md`).

## Deviation rule
If a task's assumption turns out wrong (the piece it builds on is misaligned, or a locked signature doesn't fit), that task **stops**, and fixing the misaligned piece becomes the work. Never a shim, a second copy, a special case, a widened type or a fallback. The report leads with the fix that keeps the locked decision.

## Decisions Needed
- **Ruled by the lead (2026-11-14):** #1 Mod+Shift+Y. #2 pill in the tab bar's right end. #3 Away + digest in this card (U5). #4 sidebar is a follow-up card. #5 add `waitingUntil` (U0).
- [ruled] #1 **Shortcut.** Ctrl+Shift+A is taken by `openArchitecture`. Recommended: **Mod+Shift+Y** (free in the app's registry and in Monaco's defaults). Alternative: rebind Architecture.
- [high] #2 **Where the session pill lives.** The shared frame's session strip doesn't exist yet. Recommended: the right end of the session's tab bar (`doc-tabs.tsx`), the same row the strip would occupy. CON-15/18 can move it into the strip when someone builds that.
- [high] #3 **Away and the digest** (spec MVP, iter-5 flows) aren't in your build list. Recommended: a follow-up card. The server already holds presence and `lastAway`, so it's UI only.
- [normal] #4 **Sidebar "Needs you" group and "asks" markers** (spec §4.4.8). Recommended: a follow-up card, since it touches the shared sidebar.
- [normal] #5 **Waiting countdown.** The renderer can't compute the time left for a waiting call (the budget is server-side). Recommended: show "waiting" with no countdown in MVP, or add `waitingUntil` to `RequestView` in a tiny server change (I'd do the latter if you agree).

## State and next steps (2026-11-14, for whoever continues)
- **Done** on `CON-21-request-queue-machinery`: CON-21 machinery and CON-20 U0–U5. Verify 0 at c96236d5. Full e2e PASS at 7591622c (run 43652942374). Run reports: `docs/runs/2026-11-14-CON-21/report.md` and `ui-report.md`.
- **Checked:** remote `requests-ui` + `status-bar` PASS on c96236d5 (run 43655451460).
- **Open, not started:**
  - (a) the request tab title "Review: {title}" instead of "Request";
  - (b) line numbers in the review draft;
  - (c) done: re-shot after the fixes;
  - (d) the floating waiting notice (on hold until the owner decides).
- **Not this card:** permission requests (CON-18), sidebar Needs you markers and the app-closed OS notification (lead's follow-up cards).
- **Not done here on purpose:** no merge to main, no push, no release. Those are the owner's call.
