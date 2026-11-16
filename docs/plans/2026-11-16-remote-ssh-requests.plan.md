# Remote over SSH, slice 7: remote requests (CON-42) — implementation plan

**Spec:** `docs/specs/2026-11-16-remote-ssh.md` (§4.3 F7, §4.4 request rows, §4.6, §5.3 `request.mirror`/`request.answer`, RS-D7) **Tier:** FULL
**Builds on:** CON-40 (routed calls; callAsRemote; `remote_ask` interim), the request queue (`src/conduit-mcp/request-*.ts`), and CON-27 messaging/monitor.

## Goal
B's open requests (agent `request_input` and permission asks) appear in A's Needs-you queue tagged with B's machine, and the owner answers them from A. A routed call that needs an ask on B now waits for that answer, replacing slice 5's `remote_ask` refusal.

## Architecture
- **B is the only writer of its requests.** A holds a mirror and never stores B's records on disk.
- **B → A: `request.mirror { seq, requests: RequestMirror[] }`.**
  - It is a full state snapshot of B's open requests plus those that ended in the last 10 min.
  - It goes only to inbound ssh **controller** links. The controller is the owner (RS-D7).
  - It is sent coalesced (250 ms) on change, and in full on link up.
  - It is idempotent: a newer seq replaces the old snapshot, so it needs no outbox. On a drop, A shows the mirror as stale (`link: down`) and refuses answers.
- **A → B: `request.answer { answerId, requestId, answer }`, answered by `request.answered { answerId, ok, error? }`.**
  - This is call-like: pending by answerId, with a 30 s timeout. A drop gives `peer_unreachable`, and the answer is **never replayed** (the owner retries).
  - B dedupes on answerId, applies the answer through its own answer path with `answeredBy: { kind: 'remote', machineId, windowId: null }`, and publishes the new state.
- **Remote asks.** A routed call whose B decision is `ask` now creates a **permission request on B**:
  - requester `handle@<controller id>`, session null, `grantable = !forcedAsk`;
  - it is mirrored to A and waits up to 45 s, inside A's 60 s routed cap.
  - Allowed → run the call. Denied → `denied`. Timeout → `approval_timeout`.
  - An allow with a grant creates the grant on B for that remote principal, unless it isn't grantable.

## Settled decisions — do not re-litigate
- RS-D7: remote requests are answerable from A in MVP.
- §5.5: tool calls are never replayed; only messages are.
- B is the sole writer of its sessions and state. Remote principals per CON-40. Asks reach the owner in the local queue (§4.6).

## Technical decisions
1. **Protocol minor 3.**
   - Frames `request.mirror`, `request.answer` and `request.answered`, strict-parsed, plus a `RequestMirror` contract.
   - `RequestMirror` = the `RequestView` fields that A needs to render and answer: id, kind, title, body (≤ 16 KB), options, multi, draft, priority, createdAt, expiresAt, requester (a display string), state, answer, and `permission: { tool, why, grantable } | null`.
   - Targets and args are never sent; they are B's private detail.
   - Peers whose hello reports a minor below 3 get no mirror. On A, answering one of their requests gives `peer_incompatible`.
2. **A-side mirror store**, `src/conduit-mcp/remote-requests.ts`.
   - Requests are kept per machineId and replaced wholesale by seq. They are cleared when the link is revoked or removed, and marked stale when it is down.
   - IDs on A are `"<requestId>@<machineId>"`.
   - `McpUiState.requests` merges remote rows in, with `machine` = B's id and `origin` = B, so the existing machine detail and filter show them. The badge styling belongs to the UI track (slice 6).
3. **Answer routing on A.** `mcp:requestAnswer` with a remote id goes to `NetworkPort.answerRemoteRequest(machineId, requestId, answer)`. Remote permission requests ARE answerable from the Needs-you UI (allowed/denied; Always only when grantable).
4. **list_requests on A** includes remote rows (`request_id` in the `@machine` form, plus a `machine` field). They are read-only for agents. `answer_request` and `escalate_request` don't exist locally either (spec staleness), so they are out of scope.
5. **B-side `RequestRecord`** gains `requester` in the remote form (`Handle | 'conduit' | RemoteRequester`) and `session: null` for remote permissions. `answeredBy` gains `{ kind:'remote', machineId }`. Persistence stays v1: these are optional additions. Remote permission records are withdrawn on restart, as local policy ones are.

## Spec staleness
- §4.4 lists `answer_request`/`escalate_request` as MVP remote tools. Measured: they don't exist locally (grep), and escalate is v1 in the archived requests spec. Not built. Owners answer in the UI.

## Slices and parallel lanes (up to 4)
- **L1 (first; small): protocol.** Frames, the RequestMirror contract, minor 3, parse tests.
- **After L1 merges, three parallel, file-disjoint lanes:**
  - **L2 (B request service):** request-types/request-queue/request-service changes per decision 5. Includes the mirror producer `mirrorOf(): RequestMirror[]`, `applyRemoteAnswer(requestId, answer, answerId, machineId)` with dedupe, and `createRemotePermission(principal, fields)` with its wait. Tests.
  - **L3 (A mirror store + UI + answer routing):** a new remote-requests.ts, the host ui() merge, mcp:requestAnswer routing, the list_requests merge. Tests with a fake NetworkPort. Files: remote-requests.ts, host.ts (ui and answer routing only), remote-routing.ts.
  - **L4 (network):** a new server/network/requests.ts. B sends mirrors to controller links (coalesce, full on up, the minor gate). A receives them and feeds the store. It runs the answer exchange (pending, timeout, no replay). Includes index.ts dispatch and NetworkPort/McpNetworkPort wiring. Tests.
- **L5 (serial, after L2–L4): the remote ask in callAsRemote** (host.ts). Replace `remoteAsk` with a remote permission plus wait. Add the e2e `net-requests`:
  1. a B agent's request_input appears in A's requests state, A answers it, and B's agent gets the answer;
  2. B's controller assignment is set to Worker, so a routed open_session asks; A answers allowed, and the call completes;
  3. a denied ask gives `denied`;
  4. answering while the link is down gives `peer_unreachable`.

  Mutation tests (security code) apply to L4 (only controller links get mirrors; A accepts answers only for its own machine's requests) and L5.

## Verification
Per lane: verify:quick, fallow, `rm -rf out`. Per merge: `npm run verify`. After L5: `e2e:remote` affected plus `net-requests`.

## Deviation rule
If an assumption turns out wrong, that task stops and the misaligned piece becomes the work. No shims, second copies or widened-to-fit types.

## Decisions Needed
- [normal] Answers are not replayed across a drop; the owner retries. Default taken, matching calls.
- [normal] Recently ended requests are mirrored for 10 min so A can show the outcome. Default taken.
