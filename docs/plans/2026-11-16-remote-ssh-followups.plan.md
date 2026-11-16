# Remote over SSH, track follow-ups: hello proof, routed-call cancel, remote open message — plan

**Spec:** `docs/specs/2026-11-16-remote-ssh.md` §4.2 (ssh identity), §5.5 (never replayed), §4.3 F3. **Source:** `.autoloop/blockers.md` (CON-37 review B2; CON-40 follow-ups). **Tier:** LITE ×3: three independent lanes, each in one area.

## F1. Proof of possession in the ssh hello
**Problem.** An ssh hello names an Ed25519 `serverKey`, and `machineId = deriveMachineId(serverKey)`. Keys are public, so nothing proves the far end holds the private key. Today per-Host pinning is the only defence.

**Design.**
- Every hello carries `nonce` (32 random bytes, base64).
- After both hellos are exchanged, each side sends `hello.proof { sig }`. `sig` = Ed25519 `sign(null, tbs, serverPrivateKey)` over `tbs = "conduit-link-proof-v1\n" + peerNonce + "\n" + ownMachineId + "\n" + peerMachineId` (UTF-8).
- The receiver verifies against the hello's `serverKey`, and does this **before** pinning or adding the record. A bad or missing proof → refuse `bad-proof` and audit.
- Both directions. Ssh links only: TLS already proves possession in the handshake, because the cert is signed by the server key.
- Peers below `HELLO_PROOF_MIN_MINOR` are refused on ssh with `peer_incompatible` ("update Conduit on <machine>"). Every ssh-capable build ships with this branch, so no released peer is locked out.
- Minor: the next free one at merge time. claude-25 holds 7 for fs.write, so this is likely 8; set the constant at merge.

**Files:**
- `src/contracts/link-protocol.ts`: hello `nonce`, the `hello.proof` frame, the constant.
- `server/network/link-connection.ts`: the proof step in the handshake.
- `server/network/link-manager.ts`: wire the verify ahead of `helloRefused`/`pinSshPeer`.
- `server/network/identity.ts`: `signProof`/`verifyProof` beside the key.
- Tests.

**Mutants:** verify skipped; nonce not bound (replay of an old proof); machine ids not bound; wrong key accepted.

## F2. Revoke or link-down cancels a served routed call on B
**Problem.** B's `serveCall` awaits `callAsRemote` with a never-aborted signal. A revoke or drop clears only A's pending map, so B keeps waiting: an owner ask for up to 45 s, or a read_screen wait.

**Design.**
- `callAsRemote(principal, tool, args, signal: AbortSignal)`. Host uses `ctx.signal = signal`, and the remote owner ask withdraws its permission when the signal aborts. The result is `cancelled`, and no result frame is sent because the link is gone.
- `calls.ts` B side keeps `served: Map<machineId, Set<AbortController>>`. `linkChanged` (not live / revoked) and `settleAbsent` abort that machine's served calls. `stop()` aborts all of them.
- Work already done is not undone. A session that was opened stays open, as §5.5 says ("check list_sessions").

**Files:** `server/network/calls.ts`; `src/conduit-mcp/host.ts` (**callAsRemote and askOwner only**); `src/conduit-mcp/remote-routing.ts` (the port signature); tests.

**Mutant:** drop the abort on revoke.

## F3. `open_session { machine, message }`
**Problem.** `prepareOpen` refuses `message` for a remote opener (`peer_unsupported`).

**Design.**
- On B, a remote opener's first message is stored as an inbound message from `formatAddress(handle, machineId)`, using the same store path as `deliverInbound`, with `allowUnconnected` semantics.
- Framing: `peerRelation` treats a sender address equal to the recipient's remote `openedBy` (`handle@machineId`) as `lead`.
- Replies from the new session to `handle@m-A` route back through existing messaging.
- Remove the refusal, and replace its test with the positive case.

**Files:** `src/conduit-mcp/control-tools.ts` (prepareOpen, openMessage); `src/conduit-mcp/tools.ts` (sendMessage remote-origin path, peerRelation). If `host.ts` must change, touch **only the control-tools deps literal**. Tests, plus an e2e step added to `test/e2e/net-routed.e2e.mjs`: open with message, then B's session `read_inbox` shows it from `<lead>@<A>` framed as lead.

## Parallelism and claims
- F1, F2 and F3 are file-disjoint except `host.ts`: F2 owns callAsRemote/askOwner, and F3 may touch only the control-tools deps literal.
- `link-protocol.ts` belongs to F1 alone.

## Verification
- Per lane: under `flock /tmp/claude-1000/conduit-gate.lock`, run `node esbuild.mjs && npm run verify:quick`, then fallow, then `rm -rf out`.
- Per merge: `flock … npm run verify`.
- Then `e2e:remote` on net-ssh-link, net-routed, net-requests, net-machines.

## Deviation rule
If an assumption turns out wrong, that task stops and the misaligned piece becomes the work. No shims, second copies, widened types or fallbacks.

## Decisions Needed
- [normal] F1 refuses ssh peers that can't prove possession. Default taken, because no released build has ssh links.
- [normal] F2 cancels waits but does not undo actions already done. That matches §5.5.
