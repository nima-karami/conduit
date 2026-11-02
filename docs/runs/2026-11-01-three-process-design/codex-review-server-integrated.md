# Composed server review

Verdict: REVISE

Scope: server/**, src/hc-client/**, and the C6 shim at c00f87923746f14ef803e3b4ff31e8815165547d.
Diff baseline: 3c435e08eb45d123bad53020f7ac465fab488c86 (parent of the first server-shell commit).
The brief pinned only HEAD; this baseline includes the composed server and hc-client implementations.
Reviewed against C1-C7, architecture F1-F12/D21/D22/D32/D40, the program invariants, measured hc facts,
and the runtime/standalone e2es. Individual lane plans were not supplied; detailed lane-plan fidelity
is not assessable. Program ownership and contract fidelity were checked.

Evidence: read-only source/diff/test inspection; no gate, formatter, install, or live hc commands run.
Strict UTF-8/byte scan of all 35 scoped changed files: no NUL, BOM, invalid UTF-8, stray controls,
or mixed line endings. HEAD remained pinned. No scratch files were created.

## Findings

1. [blocker] server/domain/index.ts:813 - Recovery reservations disappear when MCP is disabled or unavailable.
   The sole pre-spawn reservation comes from prepareLaunch, whose host implementation revokes/omits
   the row for messaging-off, endpoint-down, unsupported wiring, config-write failures, etc.
   (src/conduit-mcp/host.ts:1291, 1419, 1426). C1 spawn nevertheless runs the terminal and its
   resolveAddress updates nothing. After a server restart, that agent cannot be adopted: a missing
   store leaves it running but inaccessible; a loaded store treats it as an orphan and kills it.
   Direction: reserve every launch durably regardless of MCP availability; separately decide whether
   to expose its token/wiring to the child. Cover messaging-off and endpoint-down through restart.

2. [blocker] server/mcp/index.ts:224 - restoreSessions:false loses adopted MCP launch state and bindings.
   reconcile emits spawned before domain.adopted restores the held sessions. stopAdopt records the
   generation, then defOf returns undefined because mgr has not restored that session yet, so
   resumeLaunch is skipped. No later event retries it, and prepared now suppresses that generation.
   The agent reconnects with its token but has no adapter/screen/tracker/rebind state: notices and
   typed-shell CLI bindings do not survive this restart (D28/D40).
   Direction: restore the session records before handling adopted spawned events, or explicitly
   replay the MCP adoption after domain.adopted and before MCP listens. Test the composed restore-off path.

3. [blocker] server/runtime/runtime.ts:722 - Finished-before-startup-adoption outcomes have no consumer.
   A persisted live row whose hc record is finished goes through readFinal -> exit, without spawned,
   and is omitted from reconcile's returned adopted list. The domain ignores that exit because its
   initial facts.generation is null (server/domain/index.ts:680); the MCP host also ignores it because
   no runtime record was resumed (src/conduit-mcp/host.ts:1324). The exit code/status is lost and the
   live token row remains after terminal.rm. A restored pane can then rerun the command as stale.
   Direction: explicitly apply recovered finished/lost outcomes to cold domain/MCP state, including
   generation-checked token/binding cleanup. Test a terminal that exits while the server is down.

4. [blocker] server/scrollback/index.ts:69 - Adoption overwrites the previous process's scrollback.
   append/gap start with an empty ScrollbackStore ring. Only replayForColdStart hydrates from disk;
   adopted sessions bypass coldStart. Their first repaint therefore replaces the saved file with
   only the gap marker and bounded hc history, losing older output and host-composed history.
   ScrollbackWriteGate reads the old file to judge its version but never seeds this ring.
   Direction: hydrate each persisted ring before its first adoption append, without replaying it to
   the terminal or appending a cold-start tail. Test two fresh ServerScrollback instances over one file.

5. [blocker] server/services.ts:261 - The shutdown scrollback flush is not a persistence barrier.
   flushPending returns void; diskScrollbackFiles.write starts atomicWriteFile asynchronously
   (server/scrollback/index.ts:28). The lifecycle can reply and reach process.exit in main.ts:94
   before the write callback promotes the temp file. Bytes already credited to hc can be lost on
   restart, stopAll, or idle exit even though persist resolved successfully.
   Direction: detach/drain active streams before the final ring snapshot, then await its writes and
   propagate failures within the stop budget, or use a final sync flush. Test delayed shutdown writes.

6. [blocker] server/hc-cli.ts:104 - Direct stop fallback stops unrelated live terminals in our hc session.
   directStopAll enumerates and kills only labelled Conduit sessions plus the named supervisor, then
   unconditionally calls hc server stop. An agent-created unlabelled hc terminal is consequently
   killed too. The normal supervisor path has hasOtherLiveTerminals; the fallback bypasses it.
   This violates the program's explicit prohibition on stopping a core with non-Conduit terminals.
   Direction: re-list every live terminal after the targeted kills and leave the core running if any
   remain; retain conservative behavior on listing errors. Cover the real direct fallback, not a stub.

7. [blocker] server/runtime/runtime.ts:311 - A failed recovery lookup can unlock a duplicate launch.
   Per-row reconcile errors are logged and discarded while clean/health remain ready. Composition
   then calls domain.adopted with the partial/empty list and permanently sets adoptedOnce
   (server/services.ts:246). For an existing live row whose get failed before track, domain preflight
   sees neither live nor unconfirmed and sessions.start cold-spawns it again. reserve then removes
   the original live row; a later orphan sweep can kill the original agent.
   Direction: keep unresolved persisted launches fenced and retry recovery; an error must not mean
   safe-to-spawn. If C1 cannot convey recovery-pending state, record the required contract amendment.
   Test a transient get failure for an existing live agent followed by sessions.start.

8. [blocker] server/domain/index.ts:709 - Launch proceeds after the durable generation write fails.
   allocateLaunch increments the in-memory counter, but writeSync catches/logs every write failure
   (line 372) and returns success. The new token/run can therefore outlive a session/counter that was
   never saved. A restart can lose a newly created session or reuse a generation; if the older session
   file remains, orphan/session identity and stale-input protection no longer agree (C4/D21).
   Direction: make durable launch allocation fail closed on persistence errors and stop before token
   reservation/run. Inject a sessions.json write failure and assert zero terminal.run calls.

9. [blocker] server/attention/index.ts:120 - Removed sessions accumulate for the daemon's entire lifetime.
   recordExit retains SessionActivity.entries by design. ServerAttention never calls activity.forget,
   and closeSession has no attention disposal port/path. Each opened-and-removed session leaves an
   entry visited by every 750 ms sweep, so both memory and sweep work grow with historical sessions,
   not current sessions, during a month-long daemon run.
   Direction: add an explicit session-removal cleanup path that forgets attention state while keeping
   exit-state latches for sessions that still exist. Exercise repeated create/start/remove cycles.

10. [should-fix] server/services.ts:200 - Two independent coalescers publish sessions.changed.
    The attention resend timer and domain's changed timer (server/domain/index.ts:420) each emit a
    full snapshot on their own 150 ms clock. spawned schedules both, so a single change can publish
    twice together; the advertised single coalesced stream is not enforced across lanes.
    Direction: put one snapshot/coalescing scheduler at the final event boundary and let both sources
    invalidate it. Assert the combined event count through createServices, not either timer in isolation.

## Simplify

- server/main.ts:75 / server/compose.ts:57: remove the unreachable emptyCore fallback. Either an injected
  core exists or createServerServices has supplied one. Retain emptySnapshot as a test fixture if useful.
- Merge the two sessions.changed schedulers as described in finding 10; this deletes a timer and ensures
  attention-enriched snapshots have one publication rule.
- Share the conservative all-terminal core-stop predicate between supervisorCore and directStopAll
  (finding 6), keeping their different targeted-kill responsibilities at their callers.

Coverage assessment: contract/spec acceptance, recovery failure paths, and cross-lane deviation have
findings. Encoding is clear. The sampled tests have meaningful assertions, but lane doubles keep
sessions present during MCP adoption, pre-reserve runtime tokens, and inspect scrollback within one
process; those arrangements conceal the composed failures above. No additional unanchored findings.

REPORT: G:\awby\projects\conduit\.autoloop\codex-review-server.md
REVIEW: REVISE
BLOCKERS: 9
FINDINGS: 10
