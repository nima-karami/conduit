# CON-20 request queue UI: run report

**Branch:** `CON-21-request-queue-machinery` (on top of the CON-21 machinery).
**Plan:** `docs/plans/2026-11-14-request-queue-ui.plan.md`, with the lead's rulings applied.
**Design:** CON-10 iter-7, plus iter-6 13 and iter-5 14/15 (branch `shaping-2026-11-14`).

## Built

| Slice | What | Tip | verify |
|---|---|---|---|
| U0 | `RequestView.waitingUntil` (server), so countdowns are real | 7d5f15cb | 0 |
| U1 | view model + strings, type icons, drafts, `openRequest` routing, `api.answerRequest` | 3c6519f9 | transient fallow only |
| U2 | Needs you panel (two-line cards, listbox keys, filter bar, legend, History), ⋯ menu (sort; filter by session, lead group, space, type, machine; show), registered first in the right pane with a count badge | 4e585ca6 | transient fallow only |
| U3 | Header · Context · Answer · Footer template; non-modal pop-up with focus trap; `DocKind 'request'` tab (never persisted) | 1fc7e690 | **0** |
| U4/U5 | status-bar count with "· 0:58 waiting", session pill in the tab bar, thread link, Mod+Shift+Y, space names; Away menu, away banner, return digest | 909276ef | **0** |
| fix | pop-up closes after its last request is answered (found by e2e) | 20377d55 | **0** |
| fix | waiting asks stay first in the footer; `status-bar.e2e` follows attend requests | 7591622c | **0** |

On hold by the lead's ruling: the floating waiting notice. The pill and the status bar are the waiting signal until the owner decides.

## Runtime proof
- **Full suite (`--affected`) on the final tip:** 270 PASS, 9 EXCLUDED, 1 SKIP, and the known quarantined scrollback-inrun (run 43652942374). `status-bar`, `requests-ui` and `requests-sources` also PASS in run 43652443332.
- **e2e `requests-ui`:** PASS, run 43650055429. It drives the real app headless and covers:
  - card, status-bar countdown and session pill;
  - Enter opens the pop-up with the title focused, and Send answers the agent's waiting call;
  - a review opens as a tab and is answered there;
  - Away, then the banner, then I'm back and the digest.
- **Screenshots** from the runner, in `shots/`:
  - `popup-choose-waiting.png`: the pop-up over the editor with its countdown, the card in the panel, "1 needs you · 0:16 waiting" in the status bar, and the pill.
  - `popup-after-send-before-fix.png`: the bug the e2e caught.

- **Local screenshot pass** (Linux, headless, `CONDUIT_SHOTS_DIR` on `requests-ui`, PASS), compared with iter-7, iter-6 13 and iter-5 14/15:
  - `needs-list.png` vs iter-7/01 and iter-6/13: matches. Card (type icon, session, handle, `0:17 waiting` chip, ask), Open · 1 / History, sort label, ⋯; pill "Waiting on you · 0:17" at the tab bar's right end; status bar "1 needs you · 0:17 waiting".
  - `reqtpl-popup.png` vs iter-7/09, 12: matches the four sections. Plain Send, footer zones Open as tab / Open terminal | Skip.
  - `reqtpl-review-tab.png` vs iter-7/21: layout matches (draft with Edited / Original / Changes left; three options, note and Send right; Open terminal | Skip). Gaps: the tab title is the generic "Request", not "Review: {title}"; the draft has no line numbers.
  - `needs-away.png` vs iter-5/14: banner matches. Found a bug: the status-bar Away button was unreadable while away (no button reset). Fixed in c96236d5.
  - `needs-digest.png` vs iter-5/15: the "While you were away" card with window, duration, counts and Dismiss matches. Found a bug: an answered review tab stayed open. Fixed in c96236d5 (a tab answered there closes; one withdrawn elsewhere keeps its ending banner).
  - Re-shot after the fixes (local `requests-ui` PASS): `needs-digest.png` shows the answered review tab closed (terminal back in front, the agent reading the late answer) and a readable "Away" in the status bar. Remote: `requests-ui` + `status-bar` PASS on c96236d5 (run 43655451460).

## Deviations
- Request tabs are excluded from persistence by an explicit rule. The plan's "like review" was wrong: review tabs are persisted.
- No-app always-asks and the rest of CON-21 are unchanged here.
- The pop-up mounts as the first child of `.centerpane`, inside a zero-height positioned layer, so that no existing rule changes.
- Sort and Show on cards are kept per viewer in `localStorage`. Filters reset on remount, as designed.
- "All sessions" isn't drawn as a row in the Session filter. Clear on the filter bar covers it.

## Learnings
See `learnings.md`. In short:
- CSS lanes must insert before the interaction-state vocabulary.
- Give each lane its own key block in the shared strings file.
- Write e2e selectors from the rendered DOM.
