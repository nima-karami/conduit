# CON-27 — Cross-machine machinery (NET MVP), run report

**Branch** `CON-27-cross-machine-machinery` (not merged to main; main is 43 commits ahead of the
merge base) · **Spec** `docs/specs/2026-11-14-conduit-network.md` §13 · **Plan**
`docs/plans/2026-11-14-conduit-network-machinery.plan.md` · **Test environment** `test-env.md`

## Result
All nine slices are built and merged into the branch, and every finding of the independent
security review (1 blocker, 2 major, 7 minor) is fixed with a red test first. CI run 43759435145,
on the fixed branch, has the verify job green (semgrep and gitleaks included) and the remote e2e
green on the Windows runner for `net-drive`, `net-monitor`, `net-messaging`, `net-pairing` and
`server-standalone`. The Tier 2 VM run passes on the fixed branch too.

| Spec §13 item | Where | Proved by |
|---|---|---|
| Pairing: three words, fingerprint, owner key | Slices 2, 4 | `net-pairing` e2e; pairing-protocol units; Tier 2 |
| Link transport | Slice 3 | listener and link-manager units; every net-* e2e |
| Own-link messaging, exactly once across drops | Slice 6, T7.4 | `net-messaging` (lost acks, restart, revoke while queued, attachment); Tier 2 (short and long VM pause) |
| Remote session listing and monitor | Slices 5, 7 | `net-monitor` (paint, frozen → resyncing → live, remote waits) |
| Drive, opt-in | Slice 8 | `net-drive` (off by default, refused when off, resize, cut, open/close); 30 drive units |
| Manual revoke | Slice 4 | `net-pairing`, `net-messaging` revoke phase |
| Machine ids | Slice 1 | identity units; addresses `handle@m-xxxxxxxx` in every net-* e2e |

## Tier 2 run (2026-11-15)
- **Setup** (`tools/vm-peer.mjs`, driver `test/e2e/tier2/net-vm.mjs`):
  - Ubuntu 26.04 cloud image from cloud-images.ubuntu.com, SHA256 `7b90593f…ecab9` checked against
    the published SHA256SUMS before first boot;
  - QEMU/KVM, 2 vCPU, 2 GB, `-display none -vga none -monitor none`: no window, nothing to focus;
  - forwards only on 127.0.0.1 (`ss` showed 47422, 47491, 47492, all loopback);
  - started and stopped by its own PID file, never by name.
- **What it showed:** server A on the host, server B in the VM with `networkBindHost: auto`.
  - Paired through QEMU's NAT, with the fingerprint matching on both sides.
  - Link up both ways; B's agent listed on A; a message delivered once.
  - **Short blip** (VM paused until A leaves `up`): A shows `degraded`, and the message sent during
    it arrives once after resume.
  - **Long blip** (paused until A marks the link `down`, which took 20–21 s): a fresh TLS session and an
    outbox resend; the message arrives once, and none of the three is duplicated.
- **Disk:** 1.6 GB in `~/.cache/conduit-vm/con27` (822 MB base image, 757 MB overlay). Not in /tmp,
  whose quota is shared. Delete the directory to reclaim it. The VM is stopped.

## Deviations from the spec (recorded in spec §6.5–6.6)
- Pairing is numeric comparison over plain TCP on its own port, with commit-then-reveal, not a PAKE.
  Links are TLS 1.3 with the peer's pinned certificate as the only CA. This was redesigned after
  CI's semgrep blocked `rejectUnauthorized: false`. Lead-approved.
- Attachments to another machine are capped at 10 MiB per message, both ways, because a link frame
  is capped at 16 MiB.
- Monitor shows every local session. Sessions without an MCP handle have no address, and agents'
  `list_sessions` still lists addressable sessions only. A peer with messaging but not monitor gets
  only the addressing rows (no folders, attention or requests).
- No setting binds all interfaces or a public address, even explicitly: only loopback, RFC 1918,
  100.64/10 and ULA, with IPv4-mapped spellings judged as IPv4.
- The pairing fingerprint covers both pair.id messages, and a first-ever link's owner key is
  offered inside the compared exchange; the separate owner message is gone.

## Plan details that measured wrong
- `networkBindHost: '0.0.0.0'` for the VM peer: the product refuses an all-interfaces bind by design
  (D-H4), so the run uses `auto`.
- "B's session `lastSize` changes" after a remote resize: `lastSize` only moves on an hc size event.
  `net-drive` asks the program for its size instead.
- There is no `sessions.close` C2 method; remote close uses `sessions.remove`.

## Bugs found and fixed during the run
- **Capabilities changed mid-handshake** reached neither that connection's hello nor a `caps`
  frame, so the peer's view stayed stale. Fixed red-first (94eb1ac0).
- **Windows `net-drive` resize.** The test program read stdin in line mode, and on Windows such a
  program never sees a ConPTY resize. It reported its spawn size, while the PTY had been resized
  through the same path as a local resize. The echo program now reads raw, as
  `fixtures/echo-probe.cjs` does, and the assertion is unchanged.
- **Security review fixes** (independent whole-branch review at ef53aabf; each fixed red-first):
  - **B1, blocker:** a peer could forge the provenance frame through its message id and pose as the
    human. Inbound ids must now be `m_`/`t_` + 16 base32 chars; they are stored under ids derived
    per origin (a peer can't collide with a local message or join a thread that never went to its
    machine, while replies still thread up both ways); `frameBody` escapes any header id or sender
    outside the alphabet. Contract and red tests e985ebdc; fix 6359a8a0.
  - **M1:** IPv4-mapped unspecified addresses passed the bind guard, and explicit public addresses
    were accepted. Now an allowlist (669ca4fc).
  - **M2:** floods could fill the disk. A per-link limit of 120 messages a minute, at most 10
    recipients, acks bounded to the addressed handles, refusal audits throttled to one per link per
    minute, every audit string cut to 128 characters (57b61bd7).
  - **Minors:** the fingerprint binds both identities and the owner key (f9f0a95b); a held owner
    key can't be replaced by a late transfer; the hello name is capped at 64; messaging-only peers
    get no monitor data and a capability change pushes a fresh snapshot; an overtaken pairing-port
    open closes its own listener (30bec603); the outbox is capped at 1,000 entries and 64 MiB with
    an `outbox_full` refusal; peer snapshots are coalesced to one apply per 250 ms; `net-drive`
    now proves B refuses an input that reached it while its drive was off.
- Earlier slices (see the plan's "As built"): a frame right behind the hello dropped; a revoke
  during a handshake left a live connection; graceful close lost the last frame; an address edit
  during a dial waited a full backoff.

## Residual risks and gaps
- **Pairing:** a person who confirms without comparing fingerprints can be paired with an
  on-path attacker during the 10-minute window, and a passive observer then sees the three words and
  public keys (spec §6.5).
- **Drive:**
  - an exited session can't be closed remotely (`liveSession` is required);
  - ConPTY resize from a real Windows peer is Tier 3.
- **Monitor:** a link with `messaging` off and `monitor` on can't resolve `wait_sessions`
  targets, because the remote directory hides that peer's rows.
- **Messaging:**
  - expiry and revoke status writes are logged when they fail, not retried;
  - the one-per-minute refusal audit is shared by all refusal kinds on a link, so in a flood a
    `rate_limited` entry can hide a `capability_off` one for that minute;
  - a burst over 120 messages a minute from one machine is refused (undelivered), not delayed.
- **`windowsPty`** from a Windows peer is unverified (Tier 3).
- **No UI:** pairing, link list and drive have no screens yet (CON-28).
- **Local `npm run verify` is load-sensitive:** `grammar-linear` timing ratios fail at load average
  above 20. CI's verify is the gate.

## Process notes
- **Lanes:** Haiku subagents (slices 1–5), then Codex sessions (slices 6–7, after the Haiku usage
  stop), then a Haiku subagent (slice 8, per the owner's Claude-only ruling).
- **Ownership:** crypto, contracts and every review are mine. Each lane was merged one at a time
  after biome, tsc and verify.
- **Slice 8:** the contract and its 28 security tests were pinned red before the lane started.
  The lane made them pass without editing them.
- **Mistakes on my side:**
  - committing before biome's exit code, early on;
  - removing a worktree while a lane still used it;
  - one wasted remote e2e run and one wasted VM boot when an edit didn't apply;
  - one commit (30bec603) left a formatting error that verify caught before merge.
