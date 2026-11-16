# CON-35 orchestrator state (handover, 2026-11-16)

Claude orchestrator (claude-23) stopped on claude-3's order. A Codex orchestrator takes over from here.
No lane sessions were opened. Nothing is merged. Slice 1 (CON-36) has started; no gate is measured yet.

## VM (Linux remote for G7 and the Linux gates)
- Dir: `~/.cache/conduit-vm/con27` (Ubuntu 26.04.1 cloud image, the one CON-27 used).
- **Running now**: QEMU PID 63797 (`~/.cache/conduit-vm/con27/run/qemu.pid`). Headless
  (`-display none -vga none -monitor none`), serial to `serial.log`, only forward `127.0.0.1:47422 -> :22`.
  Stop it by that PID only, when idle.
- Start command (from the VM dir):
  `qemu-system-x86_64 -enable-kvm -m 2048 -smp 2 -display none -vga none -monitor none -serial file:$PWD/serial.log -drive file=disk.qcow2,if=virtio -drive file=seed-con35.iso,format=raw,if=virtio,readonly=on -nic user,hostfwd=tcp:127.0.0.1:47422-:22 -pidfile $PWD/run/qemu.pid -daemonize`
- **Re-seeded for CON-35**: new cloud-init instance-id `conduit-con35` (`seed/`, `seed-con35.iso`),
  which grants user `conduit` passwordless sudo (needed to set `KillUserProcesses` and toggle linger for G7).
  The CON-27 seed is kept as `seed/*.con27.bak`.
- **Host key regenerated** by the re-seed. The new ED25519 key was taken from the serial console's
  cloud-init print, and its fingerprint matches: `SHA256:vGK53SGPox9uDoVK3Wh35qT4oYHdXpRMJRmKqChq15s`.
  `known_hosts` now holds only that key, as `[127.0.0.1]:47422`. The old file is `known_hosts.con27.bak`.
- SSH access: put this in an ssh config file and run `ssh -F <file> vm`:
  ```
  Host vm
    HostName 127.0.0.1
    Port 47422
    HostKeyAlias [127.0.0.1]:47422
    User conduit
    IdentityFile ~/.cache/conduit-vm/con27/id_ed25519
    IdentitiesOnly yes
    UserKnownHostsFile ~/.cache/conduit-vm/con27/known_hosts
    StrictHostKeyChecking yes
    BatchMode yes
  ```

## Measured so far (read only, before any change)
- OpenSSH 10.2p1 (sshd and client). `MaxSessions` isn't set in `/etc/ssh/sshd_config`
  (`#MaxSessions 10`), so it's the default; confirm with `sudo sshd -T | grep maxsessions`.
- logind: `KillUserProcesses` isn't set (`#KillUserProcesses=no`), so it's Ubuntu's default, no.
- `conduit` has **Linger=yes** already (`/var/lib/systemd/linger/conduit`). G7 must test with linger off too.
- `systemctl --user` is running; `XDG_RUNTIME_DIR=/run/user/1000`; `systemd-run` and `setsid` are present.
- The SSH login is session `Type=tty Class=user`. Disk: 4.5 GB free of 6.7 GB.

## Not done (the next owner picks these up)
- G7 matrix (not run): `KillUserProcesses` yes|no × linger on|off × start method (`nohup &`, `setsid -f`,
  `systemd-run --user --scope`, `systemd-run --user --unit`), each started from its own ssh session that
  exits, then checked from a fresh login after ~15 s. Restore the defaults afterwards
  (remove the logind drop-in, re-enable linger).
- Payload size (linux-x64), MaxSessions over one ControlMaster, the stdio bridge byte-transparency
  over sshd (random binary through `ssh -T vm cat` plus a node pipe, compared by SHA-256).
- Windows gates G1–G6, G8, G9: pending until there's a Windows box.
- Report goes to `docs/runs/2026-11-16-CON-35/gates.md`; then the plan for slices 2–3 and the contracts.
