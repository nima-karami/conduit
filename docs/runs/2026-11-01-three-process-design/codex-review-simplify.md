# Three-process simplification review

Range: `3c65d47faa50ca5d346968125bae8e0b233c371b..325ad040769dbe1fad39adba47bd5332d4a2548c`.
Requirements: `docs/specs/archive/2026-11-01-three-process-architecture.md` and `docs/specs/archive/2026-11-01-three-process-program.md`; W7's implementation plan checked for the app seams.
All anchors below refer to the pinned head. The live branch advanced during review; later commits are outside this report.
Read-only review; no gate run or implementation changes. Byte scan of all 298 added/changed blobs found no NUL, BOM, invalid UTF-8, mixed EOL, lone CR or unexpected control bytes.
`git diff --check` flags trailing whitespace in earlier review documents and spike transcripts; those documentation-only findings are outside the simplification list.
Findings are ranked by savings, avoided drift and risk. Estimates are net physical lines, including new shared helpers; test savings are identified separately.

1. **[should-fix] Delete the retired repo-state implementation.**
   Anchors: `electron/app-session-store.ts:31`, `src/session-manager.ts:403`, `src/session-manager.ts:425`.
   `AppSessionStore` now owns repo discovery, git patches, pinning and active-repo selection (D39), but `SessionManager` retains the same six repo mutators and recomputation logic through line 495.
   Production calls in `main.ts` and `repo-tracker-host.ts` target `AppSessionStore`; the old methods' remaining callers are tests. Delete those old methods and unused imports, and move the still-used `sameRepoGit` equality helper out of the server session manager.
   Keep repo behavior tests against `AppSessionStore`; the old suite's cases at `test/unit/session-manager.test.ts:163` onward substantially repeat `test/unit/app-session-store.test.ts:112` onward. Port any unique assertion before deleting duplicates.
   **Saved:** about 90-100 implementation lines, plus 110-140 duplicate test lines. **Risk:** low; preserve migration/serialization of old records and the app overlay. **Behavior change:** none in production.

2. **[should-fix] Share the raw socket test plumbing.**
   Anchors: `test/unit/server-shell-transport.test.ts:62`, `test/unit/server-compose-services.test.ts:263`, `test/unit/server-mcp-endpoint.test.ts:68`, `test/unit/server-mcp-wiring.test.ts:300`; also `test/e2e/server-standalone.e2e.mjs:34` and `test/e2e/server-restart-supervisor.e2e.mjs:38`.
   These independently implement UTF-8 line accumulation, inboxes, JSON writes and connection cleanup. Extract a small test-only line inbox/raw peer; keep C2 request correlation and C6 hello/resume steps in their respective callers. Share the e2e C2 peer between standalone and restart coverage.
   **Saved:** roughly 70-110 test lines across the callers after helper costs. **Risk:** medium: preserve raw/malformed writes, notification ordering and the restart test's wait for socket close. Keep test wire code independent of the product client so it can still catch product framing defects. **Behavior change:** none intended.

3. **[should-fix] Merge the three in-memory token-store implementations.**
   Anchors: `src/conduit-mcp/token-store.ts:5`, `server/runtime/testing/harness.ts:13`, `test/e2e/server-runtime.e2e.mjs:31`.
   `createTokenStore` has only test consumers; both runtime harnesses implement another row state machine. Keep one test helper with row seeding and optional call recording, and use it in all three suites (export it in the e2e's existing temporary bundle).
   This already avoids a concrete drift hazard: both `MemTokens.resolveAddress` implementations unconditionally make a row live, whereas `createTokenStore` and `server/mcp/token-file.ts:144` preserve `superseded`. Their `markUnconfirmed` methods also omit the production reserved-only guard.
   **Saved:** about 45-70 test/support lines after adding recording/seeding hooks; remove the test-only module from production `src/` placement. **Risk:** medium; retain unreadable/missing and failure injection seams. **Behavior change:** test doubles become faithful to production transitions; production behavior stays unchanged. Do not merge away the persistent store's commit-before-publish semantics.

4. **[should-fix] Delete the obsolete sessions/timer write-gate helpers.**
   Anchors: `src/persistence-write-gates.ts:7`, `src/persistence-write-gates.ts:14`, `server/domain/index.ts:317`, `server/domain/index.ts:397`, `server/domain/index.ts:531`.
   The exported `sessionsWritable` and `timedMessagesWritable` have only test callers. The actual domain implements its own checks, and the former still encodes the retired rule that restore-off blocks every session write, contrary to D40's live/unconfirmed persistence rule. Its dependency `src/persistence.ts:152` (`shouldPersistSessions`) likewise serves only this helper and tests.
   Delete those three functions and their isolated assertions; retain `ScrollbackWriteGate` and the domain persistence tests that exercise real file writes, newer-file refusal and D40.
   **Saved:** about 20 implementation lines and 25-35 test lines. **Risk:** low. **Behavior change:** none; do not replace the domain's correct D40 predicate with the old helper.

5. **[should-fix] Merge the transport's duplicate event/backpressure branch.**
   Anchors: `server/transport/pipe.ts:242`, `server/transport/pipe.ts:269`.
   `emit` and `emitTo` separately implement the writable-length check, subscription drop and `missed` notification. Factor that per-socket delivery decision once and call it from the broadcast loop and the selected peer path.
   **Saved:** about 12-18 implementation lines. **Risk:** low to medium: allocate the sequence outside the shared delivery helper, preserving one sequence for the whole broadcast and an increment only for an eligible targeted peer. Retain per-peer isolation tests. **Behavior change:** none intended.

6. **[should-fix] Define the lifecycle state variants once.**
   Anchors: `src/protocol.ts:424`, `electron/server-lifecycle.ts:20`.
   `ServerUiState` repeats the lifecycle's connecting/reconnecting/unavailable/downgrade/stopped variants, including the entire reason union. Keep those variants in a renderer-safe shared type; derive the lifecycle type by replacing only the connected variant with its required `hello`. Keep the renderer's optional runtime decoration separate.
   **Saved:** about 12-18 implementation lines. **Risk:** low; keep `hello` required for a connected lifecycle and preserve the wire shape. Structural assignment in main only checks compatibility in one direction, so it does not substitute for a single definition. **Behavior change:** none.

7. **[should-fix] Share the repeated environment-noise policy, not all environment builders.**
   Anchors: `src/contracts/session-identity.ts:237`, `src/launch-spec.ts:76`, `server/domain/index.ts:232`.
   The core builder reimplements the editor-prefix, TERM_PROGRAM, MCP-token/endpoint and conditional GIT_ASKPASS filtering already performed by `sanitizeChildEnv`. Extract only the shared predicate and editor-origin detection into a Node-free helper; retain the core's HC/release-host filtering and each caller's XDG capture/restore steps.
   **Saved:** roughly 8-15 implementation lines after helper overhead. **Risk:** medium: the core currently folds key case while `sanitizeChildEnv` does not. Preserve each caller's existing normalization when sharing the predicate; changing the sanitizer to case-insensitive matching is a separate **BEHAVIOR CHANGE**. `supervisorEnv`, `serverProcessEnv` and `withServerEnv` are different transforms, not interchangeable copies.

8. **[should-fix] Share the instance digest without changing endpoint construction.**
   Anchors: `src/instance-names.ts:13`, `src/conduit-mcp/endpoint-path.ts:15`.
   Both compute the same case-normalized SHA-256 prefix, and `instanceNames` then calls `endpointPath`, computing it again. Put the digest in one small helper and call it from both; keep the endpoint APIs and their path assembly intact.
   **Saved:** roughly 3-6 implementation lines, plus one hash calculation per `instanceNames` call. **Risk:** low only if the 16-character truncation and exact normalization stay byte-for-byte identical: existing MCP configuration depends on the old pipe name. Do not combine POSIX string concatenation with path normalization incidentally. **Behavior change:** none intended.

Boundaries checked and retained:
- Persistence timers in `server/domain/index.ts:419` batch serialization over time; `src/atomic-write.ts:67` serializes overlapping writes and protects a final sync flush. Removing either as a duplicate coalescer changes durability or write cadence. The MCP host's broadcast coalescer serves a different event payload.
- Token, binding and settings readers already share `judgePersistedVersion`. Their corrupt-file rules differ: all-or-nothing token rows protect adoption, invalid individual bindings may be skipped, and settings can back up/reseed. A generic store would need policy switches rather than delete those rules.
- C2 JSON lines, C6 hello/resume and hc's binary frames have different bounds, ordering and lifetimes. Share test plumbing or small framing mechanics only; retain their protocol state machines and the stop-all client's two timeout/fallback phases.
- No wholesale split of `createDomain` or `main.ts` is recommended merely for length. No additional dead Electron module, protocol message or settings key was established by this review.

These are advisory simplifications, not a complete acceptance or integration sign-off. Full AC coverage and runtime behavior were not reverified; no blocker was established in this review's simplification scope.

REVIEW: APPROVE
BLOCKERS: 0
FINDINGS: 8
REPORT: G:\awby\projects\conduit\.autoloop\codex-review-simplify.md
