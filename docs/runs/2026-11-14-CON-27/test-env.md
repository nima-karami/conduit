# CON-26 — Test environment for cross-machine Conduit

**Run:** CON-27 orchestrator · **Date:** 2026-11-14 · **Spec:** `docs/specs/2026-11-14-conduit-network.md` (NET)

## Recommendation

Use three tiers. Each one proves something the tier below it can't.

1. **Tier 1: two servers on one host (no setup, start now).** Two standalone Conduit servers, each
   with its own temp userData and hc session, link over `127.0.0.1`. The pattern already exists in
   `test/e2e/server-standalone.e2e.mjs`. A harness TCP proxy between them makes link drops on demand.
   Most of the MVP is built and proven here, locally and on the existing Windows e2e runners.
2. **Tier 2: a local Linux VM I run myself (no root, ~600 MB download).** QEMU + KVM, user-mode
   networking, ports forwarded to loopback only. It gives a second kernel, hostname, filesystem and
   network stack. Pausing the VM (QMP `stop`/`cont`) is a real "machine went to sleep".
3. **Tier 3: Linux ↔ Windows over Tailscale in CI (owner sets up once, ~20 min).** One ubuntu job and
   one windows job join an ephemeral tailnet (`tailscale/github-action`) and link for real. This is
   the only automated proof of the target topology: a Linux GUI watching ConPTY sessions on Windows.

A **Windows VM** on this host is optional. Its job is the hands-on measurements CI can't do: Kiro's
MCP setup on Windows (NET-D19 gate) and a human looking at real panes. It needs the owner's logins
for Kiro and OpenCode. A **cloud VPS** isn't recommended: it costs money, puts a port on the public
internet, and proves nothing Tier 2 + Tier 3 don't.

## What each option can and can't prove

| Option | Proves | Can't prove | Who sets it up |
|---|---|---|---|
| Tier 1: two servers on loopback | Pairing (PAKE, fingerprints, own-key rule), the encrypted link, exactly-once across drops (proxy), revoke, machine ids and addresses, remote `list_sessions`/monitor/drive end to end on real hc | Separate machines: same hostname, clock, filesystem, OS. Real NAT, firewall, sleep, DHCP | Me, now |
| Network namespace (bwrap) | Nothing beyond Tier 1. `bwrap --unshare-net` works here, but it only gives an isolated `lo`. Joining two namespaces needs veth (root) or slirp4netns/pasta (not installed) | — | — |
| Tier 2: local Linux VM | Distinct machine identity, real TCP across a NAT'd stack, a sleep/wake blip (VM paused), a cable pull (`set_link off`), an address change, clock skew (set the guest clock) | Windows, ConPTY, the Windows firewall prompt, LAN discovery | Me, after an OK to download the image |
| Windows VM (local) | ConPTY panes relayed to a Linux GUI, Windows paths, OpenCode on Windows, **Kiro MCP measurement**, firewall prompt | Unattended runs (needs a human for install and logins) | Owner (ISO + install); I can drive it after |
| Tier 3: Tailscale in CI | Real Linux ↔ Windows link on every remote e2e run, over a real WireGuard tailnet, NAT traversal included | Kiro/OpenCode with real logins (no subscriptions in CI), a human's eyes | Owner (account + secret), me (workflow) |
| Tailscale on this host + a Windows box | The real daily setup | — | Owner (needs sudo and a Windows machine) |
| Cloud VPS | Real internet latency | Nothing Tier 2 + Tier 3 don't; costs money; public exposure | Owner |

## What's on this machine (inspected 2026-11-14, not guessed)

Ubuntu 26.04.1, 12 cores, 29 GB RAM (about 12 GB free with the current load), 60 GB disk free. User
`namemenima` is in `sudo`, `kvm` (by ACL) and `lxd`.

| Thing | State | Note |
|---|---|---|
| `qemu-system-x86_64` 10.2.1, `qemu-img`, OVMF | **present** | |
| `/dev/kvm` | **usable** (ACL `user:namemenima:rw-`) | Full-speed VMs with no root |
| `xorriso` | present | Builds a cloud-init seed ISO with no root |
| `ssh` client | present | `sshd` not installed (not needed: VMs forward to loopback) |
| `bwrap` | present, `--unshare-net` works | `unshare -Urn` is blocked by `apparmor_restrict_unprivileged_userns=1` |
| docker, podman, libvirt/virsh, virt-install, vagrant, lxc/incus (user is in `lxd` but no client), multipass | **absent** | |
| slirp4netns, pasta | absent | |
| tailscale / tailscaled | **absent** | Installing needs sudo |
| Node | v26.13.1 | |
| Network | Wi-Fi `192.168.2.11/24`; Ethernet down | |

## Owner checklist

### A. Nothing to do for Tier 1 or Tier 2
Tier 2 is approved by the lead (2026-11-14): download only from cloud-images.ubuntu.com, verify the published SHA256, keep it in the scratchpad, stop the VM by its PID when not testing, and download only after the plan is approved. It downloads the Ubuntu 26.04 cloud image (~600 MB) into my
scratchpad. The VM runs as my user with `-display none` (invisible, no window) and only `127.0.0.1`
port forwards, so nothing listens beyond loopback. It uses 2 vCPU and 2 GB RAM.

### B. Tier 3: Tailscale in CI (recommended, one time)
1. Make a free Tailscale account at https://login.tailscale.com (personal plan is enough).
2. In the admin console → **Access controls**, add a tag and let it reach itself. Add to the policy
   file:
   ```json
   "tagOwners": { "tag:conduit-ci": ["autogroup:admin"] },
   "grants": [{ "src": ["tag:conduit-ci"], "dst": ["tag:conduit-ci"], "ip": ["*"] }]
   ```
   (If your policy still uses `acls`, the equivalent is an `accept` rule from `tag:conduit-ci` to
   `tag:conduit-ci:*`.) CI nodes then reach only each other, never your own devices.
3. **Settings → OAuth clients → Generate**: scope `auth_keys` (write), tag `tag:conduit-ci`. Copy the
   client id and secret.
4. In GitHub, `nima-karami/conduit` → Settings → Secrets and variables → Actions, add
   `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET`.
5. Tell me it's done. I add the workflow job; nodes are ephemeral and vanish when the job ends.

### C. Windows VM (optional; for the Kiro measurement and a hands-on look)
1. Download the Windows 11 Enterprise evaluation ISO (90 days, free):
   https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise
2. Download the virtio drivers ISO:
   https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso
3. Put both under `~/vms/` and tell me. I create the disk and start QEMU with VNC on `127.0.0.1`
   only; you do the install through a VNC viewer (about 30 min; it needs a person for the setup
   screens). Plan on 6 GB RAM and 60 GB disk for it.
4. Inside: install Node, Git, OpenCode and Kiro, and sign in to each yourself. I then run the NET-D19
   measurement and drive Conduit there.
5. Windows 11 wants TPM 2.0; `swtpm` isn't installed. Either `sudo apt install swtpm` or let me use the
   installer's registry bypass (`LabConfig\BypassTPMCheck`).

### D. The real setup (later, when you want it daily)
`sudo apt install tailscale` (or Tailscale's own repo) here, `sudo tailscale up`, Tailscale on the
Windows box, then pair the two Conduits by tailnet name.

## How e2e drives two servers

- **Harness helper `startServerPair()`** (new, next to `harness-server-teardown.mjs`): starts two
  standalone servers as `server-standalone.e2e.mjs` does, each with its own temp userData, XDG dirs
  and `HC_SESSION`. Each link listener binds `127.0.0.1:0` and reports its port over C2. Teardown
  stops only those two hc sessions (never by process name).
- **The test plays both apps**: one C2 client per server. Pairing runs through C2
  (start a window on A, read the three words, join from B, confirm the fingerprint on both).
- **Agents** are the existing fake MCP agents (`conduit-mcp-helpers.mjs`), so `send_message` /
  `read_inbox` / `list_sessions` run through real MCP on real hc.
- **Drops** go through a harness TCP proxy between B and A with `pause`, `cut` and `resume`. A test
  "resends twice" by cutting after the frame is written and before the ack, which is exactly the
  exactly-once case. No sleeps: `until()` waits on observable state.
- **GUI scenarios** (Machines group, remote pane) launch one Electron app via `launchElectron` against
  server A, headless as always.
- **Tier 2 VM**: the same scenario with server B started inside the VM over SSH (forwarded port).
  The link goes host ↔ guest through QEMU's NAT. A blip is QMP `stop`/`cont`. Local only; it doesn't
  run in CI.
- **Tier 3 CI**: a new `e2e-cross` workflow job pair. The ubuntu job runs server B and a small
  scenario agent. The windows job runs server A, the GUI and the assertions. They meet through a
  coordination file exchanged over the tailnet (a tiny HTTP endpoint on the tailnet address,
  reachable only by `tag:conduit-ci`). Triggered by `npm run e2e:remote -- cross-<name>`.

## Slice ↔ tier map (summary; the plan has the detail)

| Slice | Tier 1 | Needs Tier 2 | Needs Tier 3 / Windows |
|---|---|---|---|
| Machine id, keys, link store | ✓ | | |
| Pairing (PAKE, fingerprint, own-key rule) | ✓ | | |
| Link transport, states, backoff | ✓ (proxy) | sleep/wake, address change | |
| Messaging, exactly-once | ✓ (proxy) | real sleep | |
| Remote list_sessions + monitor | ✓ | | ConPTY facts relayed (`windowsPty`) |
| Drive | ✓ | | ConPTY resize from a Linux GUI |
| Revoke | ✓ | | |
| Kiro install target (NET-D19) | | | Windows VM or box, with a Kiro login |
