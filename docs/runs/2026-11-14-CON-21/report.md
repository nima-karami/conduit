# CON-21 request queue machinery: run report

**Branch:** `CON-21-request-queue-machinery`, based on origin/main `0af240c9` (v0.64.0).
**Plan:** `docs/plans/2026-11-14-request-queue-machinery.plan.md`, revised after the lead's review.
**Evidence:** `baseline.md` (gate at base), `osc7501.md` (REQ-D9 measurement), `learnings.md`.

## What was built

| Slice | What | Merge tip | `npm run verify` | e2e (remote) |
|---|---|---|---|---|
| 1 | Pure core: wire types, args/answer validation, queue (lifecycle, caps, dedupe, replaces, expiry/defaults), requests.json | 4323441f | 1 (transient fallow unused exports only) | — |
| 2 | Agent tools end to end: waits, service (delivery, presence/Away, machine id), registration in a `requests` policy group, host wiring, `mcp:requestAnswer` / `mcp:setAway` / `mcp:requestResult`, `McpUiState.requests` | a2d188b6 | **0** | requests-agent PASS [43639242981]; full suite PASS [43639625921] |
| 3 | CHANGELOG | (with 2) | — | — |
| 4 | Sources: `attend` from OSC 7501 `blocked`, `scheduler` from CON-11's resume issue (Resume now / Turn auto-resume on / Skip), `message` from a `question` to you, counted once | afaff863 | **0** | requests-sources + requests-agent PASS [43640105053] |
| 5 | No-window asks (grace deny removed; always-asks for server actions start with no app), tray count, one OS notification per burst | 8cbb5d91 | **0** | asks-no-window + requests-agent + requests-sources PASS [43641678927] |

Merges went in one lane at a time. Every merge's verify exit code is in the ledger below.
- Slice 1 lanes went red on fallow's unused exports, which is expected until their consumers land.
- Three merges failed on real guards: hc-network-guard, the tool-schema keyword whitelist, and server-runtime-races. Each was fixed at its source. No gate or ignore list was touched.

```
s1-args 3f01e5f4 1 · s1-file 6c684fb4 1 · s2-waits 0dcd723d 1 · s1-queue 4323441f 1
s2-service 4b9ee458 1 · s2-reg 8e694d27 1 · fix e7d566c3 1 · s2-host a0e920dd 1 · s2 tip a2d188b6 0
s4-wire f9074b7a 1 · s4 tip afaff863 0 · s5-asks d8305d2b 0 · s5-tray 6d6394a6 0 · s5-notify 8cbb5d91 0
```

## Deviations from the plan

- **Late answers are hidden from the human's Messages (lead ruling 2).** Each one goes in a thread of its own, tagged with `requestId`, and is filtered out of `uiState()` and `mcp:thread`. The agent's notice reads "A request you made was answered".
- **Re-homing already existed.** F7 step 4 (`answeringWindow`) covers it, so Slice 5 only removed the grace deny and added `NO_OWNER_WINDOW` (0) for asks that start with no app.
- **No-app always-asks are limited to `SERVER_ACTIONS`.** A window tool approved with no window would only fail with `window_not_ready`.
- **The Rust tray balloon was dropped (lead ruling 1).** The app-closed OS notification is under "Left for later".
- **The tray count excludes any session with an open request**, not only `attend` and `scheduler` ones. An agent that asked a question and went idle counts once.
- **The machine id is stored in `conduit-mcp/machine-id.json`.** `machine.json` tripped the hc network guard.
- **The reconciler takes handled resume issues and handled questions.** Otherwise an answered "Resume now", or a reply whose mark-read failed, would be raised again.
- **`queue.load()` no longer reports a change when nothing ended.** Startup doesn't rewrite requests.json.

## Measured, not inferred

- **REQ-D9:** Claude Code reports `blocked`/permission and `blocked`/question, and OpenCode reports `blocked`/permission. Claude Code's start-up trust dialog is not reported. Codex, Kiro and Cursor were not measured. Details in `osc7501.md`.
- **The OSC 7501 field separator is `:`.** `state=blocked:kind=permission` parses; the `;` form is ignored. Measured against `conduit-hc` 0.1.16.

## Left for later

- **App-closed OS notification (Windows and Linux).** Lead ruling 1; the lead files the card.
- **Docs still describing the removed 5 s `ui_unavailable` rule:**
  - `docs/adr/0007-three-process-split-and-terminal-runtime.md:132`
  - `docs/specs/2026-11-14-user-input-requests.md:83`
  - `docs/specs/2026-11-14-policy-and-permissions.md:527`
  - `docs/specs/2026-11-14-conduit-network.md:70`

  These need a doc pass with CON-20's spec update.
- **The UI (CON-20)** reads `McpUiState.requests`. It is next, and gets a separate plan.
